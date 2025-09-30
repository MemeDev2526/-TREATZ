# main.py
from __future__ import annotations

import time
import hmac
import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from config import settings
import db as dbmod

app = FastAPI(title="$TREATZ Backend", version="0.1.0")

# ----------------------------- CORS ---------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://trickortreatsol.tech",
        "https://memedev2526.github.io",
        "https://memedev2526.github.io/-TREATZ",
        "http://localhost:5173",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API = (getattr(settings, "API_PREFIX", "/api") or "/api").rstrip("/")

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  server_seed_hash TEXT,
  client_seed TEXT,
  pot INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY,
  user TEXT,
  client_seed TEXT,
  server_seed_hash TEXT,
  server_seed_reveal TEXT,
  wager INTEGER,
  side TEXT,
  result TEXT,
  win INTEGER,
  status TEXT,
  tx_sig TEXT,
  created_at TEXT,
  settled_at TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id TEXT NOT NULL,
  user TEXT,
  tickets INTEGER NOT NULL,
  tx_sig TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(round_id) REFERENCES rounds(id)
);

CREATE INDEX IF NOT EXISTS idx_rounds_opens_at ON rounds(opens_at);
CREATE INDEX IF NOT EXISTS idx_entries_round ON entries(round_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_txsig ON entries(tx_sig);
"""

async def ensure_schema(db):
    await db.executescript(SCHEMA_SQL)

def _hash(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()

def _hmac(secret: str, msg: str) -> bytes:
    return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).digest()

@app.on_event("startup")
async def on_startup():
    # connect DB and ensure schema
    app.state.db = await dbmod.connect(settings.DB_PATH)
    await ensure_schema(app.state.db)

    # Ensure a current round exists
    if not await dbmod.kv_get(app.state.db, "current_round_id"):
        rid = f"R{secrets.randbelow(10_000):04d}"
        now = datetime.utcnow()
        closes = now + timedelta(minutes=30)
        await app.state.db.execute(
            "INSERT INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,pot) VALUES(?,?,?,?,?,?,?)",
            (rid, "OPEN", now.isoformat(), closes.isoformat(), _hash('seed:'+rid), secrets.token_hex(8), 0),
        )
        await dbmod.kv_set(app.state.db, "current_round_id", rid)
        await app.state.db.commit()

# ----------------------------- Health --------------------------------
@app.get(f"{API}/health")
async def health():
    return {"ok": True, "ts": time.time(), "service": "$TREATZ", "version": "0.1.0"}

# ----------------------------- Models --------------------------------
class NewBet(BaseModel):
    amount: int = Field(ge=1, description="Amount in smallest units (e.g., lamports for SOL)")
    side: Literal["TRICK", "TREAT"]

class BetResp(BaseModel):
    bet_id: str
    server_seed_hash: str
    deposit: str
    memo: str

# --------------------------- Endpoints --------------------------------
@app.post(f"{API}/bets", response_model=BetResp)
async def create_bet(body: NewBet):
    # In MVP we just return deposit + memo; settlement occurs via webhook
    bet_id = secrets.token_hex(6)
    server_seed = secrets.token_hex(32)
    server_seed_hash = _hash(server_seed)

    await app.state.db.execute(
        "INSERT INTO bets(id, user, client_seed, server_seed_hash, server_seed_reveal, wager, side, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (bet_id, "", secrets.token_hex(8), server_seed_hash, None, body.amount, body.side, "PENDING", datetime.utcnow().isoformat()),
    )
    await app.state.db.commit()

    deposit = settings.GAME_VAULT  # where user will send funds
    memo = f"BET:{bet_id}:{body.side}"

    return {"bet_id": bet_id, "server_seed_hash": server_seed_hash, "deposit": deposit, "memo": memo}

@app.get(f"{API}/rounds/current")
async def rounds_current():
    rid = await dbmod.kv_get(app.state.db, "current_round_id")
    async with app.state.db.execute(
        "SELECT id, status, opens_at, closes_at, pot FROM rounds WHERE id=?", (rid,)
    ) as cur:
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "No current round")
        return {
            "round_id": row[0],
            "status": row[1],
            "opens_at": row[2],
            "closes_at": row[3],
            "pot": row[4],  # integer lamports; frontend divides by 1e9
        }

@app.get(f"{API}/rounds/recent")
async def rounds_recent(limit: int = 10):
    async with app.state.db.execute(
        "SELECT id, pot FROM rounds ORDER BY opens_at DESC LIMIT ?", (limit,)
    ) as cur:
        rows = await cur.fetchall()
        if not rows:
            rid = await dbmod.kv_get(app.state.db, "current_round_id")
            if rid:
                return [{"id": rid, "pot": 0}]
        return [{"id": r[0], "pot": r[1]} for r in rows]

# ----------------------- Helius Webhook (MVP) -------------------------
@app.post(f"{API}/webhook/helius")
async def helius_webhook(request: Request):
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")

    events = payload if isinstance(payload, list) else [payload]

    for ev in events:
        memo = ev.get("memo") or ev.get("description") or ""
        tx_sig = ev.get("signature") or ev.get("txHash") or ""
        amt = int(ev.get("amount", 0))
        to_addr = (ev.get("destination") or "").lower()
        sender = (ev.get("source") or "").lower()

        game_vault = settings.GAME_VAULT.lower()
        jackpot_vault = settings.JACKPOT_VAULT.lower()

        # Coin flip deposits
        if memo.startswith("BET:") and to_addr == game_vault:
            try:
                _, bet_id, choice = memo.split(":")
            except Exception:
                continue

            async with app.state.db.execute(
                "SELECT server_seed_hash, wager FROM bets WHERE id=?", (bet_id,)
            ) as cur:
                row = await cur.fetchone()
                if not row:
                    continue

            # In MVP we derive a pseudo 'reveal' from bet_id (replace with real secret later)
            server_seed_reveal = "reveal_" + bet_id
            result = "TREAT" if (int.from_bytes(_hmac(settings.HMAC_SECRET, server_seed_reveal + tx_sig), "big") % 2) else "TRICK"
            win = int(result == choice)
            status = "SETTLED"

            await app.state.db.execute(
                "UPDATE bets SET result=?, win=?, status=?, server_seed_reveal=?, tx_sig=?, settled_at=? WHERE id=?",
                (result, win, status, server_seed_reveal, tx_sig, datetime.utcnow().isoformat(), bet_id),
            )
            await app.state.db.commit()

        # Jackpot entries
        if memo.startswith("JP:") and to_addr == jackpot_vault and amt > 0:
            parts = memo.split(":")
            if len(parts) >= 2:
                round_id = parts[1]
            else:
                round_id = await dbmod.kv_get(app.state.db, "current_round_id")

            tickets = max(1, amt // settings.TICKET_PRICE)
            await app.state.db.execute(
                "INSERT INTO entries(round_id,user,tickets,tx_sig) VALUES(?,?,?,?)",
                (round_id, sender, tickets, tx_sig),
            )
            # Keep pot in lamports (INTEGER). Frontend converts to SOL.
            await app.state.db.execute(
                "UPDATE rounds SET pot = COALESCE(pot,0) + ? WHERE id=?",
                (amt, round_id),
            )
            await app.state.db.commit()

    return {"ok": True}

# --------------------------- Admin helper -----------------------------
@app.post(f"{API}/admin/round/close")
async def admin_close_round():
    rid = await dbmod.kv_get(app.state.db, "current_round_id")
    new_id = f"R{secrets.randbelow(10_000):04d}"
    now = datetime.utcnow()
    closes = now + timedelta(minutes=30)

    await app.state.db.execute("UPDATE rounds SET status='SETTLED' WHERE id=?", (rid,))
    await app.state.db.execute(
        "INSERT INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,pot) VALUES(?,?,?,?,?,?,?)",
        (new_id, "OPEN", now.isoformat(), closes.isoformat(), _hash('seed:'+new_id), secrets.token_hex(8), 0),
    )
    await app.state.db.commit()
    await dbmod.kv_set(app.state.db, "current_round_id", new_id)

    return {"ok": True, "new_round": new_id}
    
@app.post(f"{API}/admin/round/seed")
async def admin_seed_rounds(n: int = 5):
    now = datetime.utcnow()
    created = []
    for i in range(n):
        rid = f"R{secrets.randbelow(10_000):04d}"
        opens = (now - timedelta(minutes=(n - i) * 45)).isoformat()
        closes = (now - timedelta(minutes=(n - i) * 45 - 30)).isoformat()
        pot = secrets.randbelow(4_000_000_000)  # up to ~4 SOL in lamports
        await app.state.db.execute(
            "INSERT OR REPLACE INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,pot) VALUES(?,?,?,?,?,?,?)",
            (rid, "SETTLED", opens, closes, _hash('seed:'+rid), secrets.token_hex(8), pot)
        )
        created.append(rid)
    await app.state.db.commit()
    return {"ok": True, "created": created}
    