# =========================================================
# $TREATZ Backend (FastAPI)
# =========================================================
from __future__ import annotations

import hmac
import hashlib
import secrets
import time
from datetime import datetime, timedelta
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from config import settings
import db as dbmod  # aiosqlite helpers (connect, kv_get/kv_set)


# =========================================================
# App Init
# =========================================================
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


# =========================================================
# DB Schema (SQLite / aiosqlite)
# =========================================================
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
""".strip()


async def ensure_schema(db):
    await db.executescript(SCHEMA_SQL)


# =========================================================
# Crypto Helpers
# =========================================================
def _hash(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _hmac(secret: str, msg: str) -> bytes:
    return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).digest()


# =========================================================
# Lifecycle
# =========================================================
@app.on_event("startup")
async def on_startup():
    # Connect DB + ensure schema
    app.state.db = await dbmod.connect(settings.DB_PATH)
    await ensure_schema(app.state.db)

    # Ensure a current (OPEN) round exists
    current = await dbmod.kv_get(app.state.db, "current_round_id")
    if not current:
        rid = f"R{secrets.randbelow(10_000):04d}"
        now = datetime.utcnow()
        closes = now + timedelta(minutes=30)
        await app.state.db.execute(
            "INSERT INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,pot) VALUES(?,?,?,?,?,?,?)",
            (rid, "OPEN", now.isoformat(), closes.isoformat(), _hash("seed:" + rid), secrets.token_hex(8), 0),
        )
        await dbmod.kv_set(app.state.db, "current_round_id", rid)
        await app.state.db.commit()


# =========================================================
# Health
# =========================================================
@app.get(f"{API}/health")
async def health():
    return {"ok": True, "ts": time.time(), "service": "$TREATZ", "version": "0.1.0"}


# =========================================================
# Models
# =========================================================
class NewBet(BaseModel):
    amount: int = Field(ge=1, description="Amount in smallest units (e.g., lamports)")
    side: Literal["TRICK", "TREAT"]


class BetResp(BaseModel):
    bet_id: str
    server_seed_hash: str
    deposit: str
    memo: str


# =========================================================
# Endpoints — Bets
# =========================================================
@app.post(f"{API}/bets", response_model=BetResp)
async def create_bet(body: NewBet):
    """
    Create a coin-flip bet record and return the deposit address + memo.
    Settlement occurs later via webhook (Helius).
    """
    bet_id = secrets.token_hex(6)

    # For MVP we commit the *hash* (not the reveal) to DB
    server_seed = secrets.token_hex(32)
    server_seed_hash = _hash(server_seed)

    await app.state.db.execute(
        "INSERT INTO bets(id, user, client_seed, server_seed_hash, server_seed_reveal, wager, side, status, created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (
            bet_id,
            "",
            secrets.token_hex(8),
            server_seed_hash,
            None,
            body.amount,
            body.side,
            "PENDING",
            datetime.utcnow().isoformat(),
        ),
    )
    await app.state.db.commit()

    deposit = settings.GAME_VAULT  # where user will send funds
    memo = f"BET:{bet_id}:{body.side}"

    return {"bet_id": bet_id, "server_seed_hash": server_seed_hash, "deposit": deposit, "memo": memo}


# =========================================================
# Endpoints — Rounds (current / recent)
# =========================================================
@app.get(f"{API}/rounds/current")
async def rounds_current():
    rid = await dbmod.kv_get(app.state.db, "current_round_id")
    async with app.state.db.execute(
        "SELECT id, status, opens_at, closes_at, pot FROM rounds WHERE id=?",
        (rid,),
    ) as cur:
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "No current round")
        return {
            "round_id": row[0],
            "status": row[1],
            "opens_at": row[2],
            "closes_at": row[3],
            "pot": row[4],  # integer smallest units (lamports if SOL)
        }


@app.get(f"{API}/rounds/recent")
async def rounds_recent(limit: int = 10):
    async with app.state.db.execute(
        "SELECT id, pot FROM rounds ORDER BY opens_at DESC LIMIT ?",
        (limit,),
    ) as cur:
        rows = await cur.fetchall()

    if not rows:
        rid = await dbmod.kv_get(app.state.db, "current_round_id")
        return [{"id": rid, "pot": 0}] if rid else []

    return [{"id": r[0], "pot": r[1]} for r in rows]


# =========================================================
# Webhooks — Helius (MVP)
# =========================================================
def _verify_helius_signature(request: Request, raw_body: bytes) -> bool:
    """
    Optional: verify Helius request signature if HELIUS_SIGNATURE_HEADER is set.
    Helius sends hex-encoded HMAC-SHA256 over the raw body.
    """
    header_name = settings.HELIUS_SIGNATURE_HEADER or ""
    if not header_name:
        return True  # verification disabled

    sig = request.headers.get(header_name)
    if not sig:
        return False

    computed = hmac.new(settings.HMAC_SECRET.encode(), raw_body, hashlib.sha256).hexdigest()
    try:
        # constant-time compare
        return hmac.compare_digest(computed, sig)
    except Exception:
        return False


@app.post(f"{API}/webhook/helius")
async def helius_webhook(request: Request):
    # Optional signature check (disabled unless header name configured)
    raw = await request.body()
    if not _verify_helius_signature(request, raw):
        raise HTTPException(401, "Signature verification failed")

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

        game_vault = (settings.GAME_VAULT or "").lower()
        jackpot_vault = (settings.JACKPOT_VAULT or "").lower()

        # ---------------- Coin flip deposits ----------------
        if memo.startswith("BET:") and to_addr == game_vault:
            try:
                _, bet_id, choice = memo.split(":")
            except Exception:
                continue

            async with app.state.db.execute(
                "SELECT server_seed_hash, wager FROM bets WHERE id=?",
                (bet_id,),
            ) as cur:
                row = await cur.fetchone()
                if not row:
                    continue

            # MVP pseudo reveal; replace with real committed reveal later
            server_seed_reveal = "reveal_" + bet_id
            # Deterministic fair coin from HMAC(secret, reveal + tx_sig)
            result = "TREAT" if (int.from_bytes(_hmac(settings.HMAC_SECRET, server_seed_reveal + tx_sig), "big") % 2) else "TRICK"
            win = int(result == choice)
            status = "SETTLED"

            await app.state.db.execute(
                "UPDATE bets SET result=?, win=?, status=?, server_seed_reveal=?, tx_sig=?, settled_at=? WHERE id=?",
                (result, win, status, server_seed_reveal, tx_sig, datetime.utcnow().isoformat(), bet_id),
            )
            await app.state.db.commit()

        # ---------------- Jackpot entries -------------------
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
            # Keep pot in smallest units. Frontend converts (lamports → SOL).
            await app.state.db.execute(
                "UPDATE rounds SET pot = COALESCE(pot,0) + ? WHERE id=?",
                (amt, round_id),
            )
            await app.state.db.commit()

    return {"ok": True}


# =========================================================
# Admin Helpers (simple, no auth — secure behind network!)
# =========================================================
@app.post(f"{API}/admin/round/close")
async def admin_close_round():
    """Close the current round and open a fresh one (30 min)."""
    rid = await dbmod.kv_get(app.state.db, "current_round_id")
    new_id = f"R{secrets.randbelow(10_000):04d}"
    now = datetime.utcnow()
    closes = now + timedelta(minutes=30)

    await app.state.db.execute("UPDATE rounds SET status='SETTLED' WHERE id=?", (rid,))
    await app.state.db.execute(
        "INSERT INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,pot) VALUES(?,?,?,?,?,?,?)",
        (new_id, "OPEN", now.isoformat(), closes.isoformat(), _hash("seed:" + new_id), secrets.token_hex(8), 0),
    )
    await app.state.db.commit()
    await dbmod.kv_set(app.state.db, "current_round_id", new_id)

    return {"ok": True, "new_round": new_id}


@app.post(f"{API}/admin/round/seed")
async def admin_seed_rounds(n: int = 5):
    """Backfill recent, SETTLED rounds for UI testing."""
    now = datetime.utcnow()
    created = []
    for i in range(n):
        rid = f"R{secrets.randbelow(10_000):04d}"
        # spread in the past for visible ordering
        opens = (now - timedelta(minutes=(n - i) * 45)).isoformat()
        closes = (now - timedelta(minutes=(n - i) * 45 - 30)).isoformat()
        pot = secrets.randbelow(4_000_000_000)  # up to ~4 SOL in lamports

        await app.state.db.execute(
            "INSERT OR REPLACE INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,pot) VALUES(?,?,?,?,?,?,?)",
            (rid, "SETTLED", opens, closes, _hash("seed:" + rid), secrets.token_hex(8), pot),
        )
        created.append(rid)

    await app.state.db.commit()
    return {"ok": True, "created": created}
