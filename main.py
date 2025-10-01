# =========================================================
# $TREATZ Backend (FastAPI)
# =========================================================
from __future__ import annotations

import hmac
import hashlib
import secrets
import time
import asyncio
from datetime import datetime, timedelta
from typing import Literal, Optional
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from config import settings
import db as dbmod
from db import ensure_schema   # import canonical schema

# NEW: payout helpers (sign + send SPL from vaults)
from payouts import pay_coinflip_winner, pay_jackpot_winner, pay_jackpot_split

# NEW: RPC helpers for balances/entropy
from solana.rpc.async_api import AsyncClient

RPC_URL = getattr(settings, "RPC_URL", "https://api.mainnet-beta.solana.com")
ROUND_MIN = int(getattr(settings, "ROUND_MIN", 30))
ROUND_BREAK = int(getattr(settings, "ROUND_BREAK", 0))
SPLT_WIN = int(getattr(settings, "SPLT_WINNER", 80))
SPLT_DEV = int(getattr(settings, "SPLT_DEV", 10))
SPLT_BURN = int(getattr(settings, "SPLT_BURN", 10))
DEV_WALLET = getattr(settings, "DEV_WALLET", "")
BURN_ADDRESS = getattr(settings, "BURN_ADDRESS", "")
SLOTS_PER_MIN = 150  # approx. Solana slots per minute; good enough for 2–30m rounds

# --- top of main.py (near imports) ---
from fastapi import Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

ADMIN_TOKEN = getattr(settings, "ADMIN_TOKEN", "")
_auth_scheme = HTTPBearer(auto_error=False)
def admin_guard(creds: HTTPAuthorizationCredentials = Depends(_auth_scheme)):
    if not ADMIN_TOKEN:
        # allow only if explicitly running in debug/dev
        if getattr(settings, "DEBUG", False):
            return True
        raise HTTPException(401, "ADMIN_TOKEN required in production")
    if not creds or creds.credentials != ADMIN_TOKEN:
        raise HTTPException(401, "Unauthorized")
    return True

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
# Crypto Helpers
# =========================================================
def _hash(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _hmac(secret: str, msg: str, as_hex: bool = False) -> str | bytes:
    """Return HMAC-SHA256 over msg using secret. Hex for storage, raw bytes for RNG."""
    dig = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).digest()
    return dig.hex() if as_hex else dig


# =========================================================
# RPC Helpers
# =========================================================
async def _rpc_get_token_balance(ata: str) -> int:
    """Return token balance (base units) for a token account address."""
    if not ata:
        return 0
    async with AsyncClient(RPC_URL) as c:
        r = await c.get_token_account_balance(ata)
        # solana-py typed response
        val = getattr(r, "value", None)
        if val and hasattr(val, "amount"):
            return int(val.amount)
        # fallback for raw style
        return int(r["result"]["value"]["amount"])

async def _rpc_get_slot() -> int:
    async with AsyncClient(RPC_URL) as c:
        s = await c.get_slot()
        return getattr(s, "value", s["result"])

async def _rpc_get_blockhash(slot: int) -> Optional[str]:
    """Fetch blockhash at a specific slot; None if unavailable."""
    async with AsyncClient(RPC_URL) as c:
        b = await c.get_block(slot, max_supported_transaction_version=0)
        val = getattr(b, "value", None)
        if val and hasattr(val, "blockhash"):
            return val.blockhash
        if isinstance(b, dict) and b.get("result") and b["result"].get("blockhash"):
            return b["result"]["blockhash"]
        return None


# =========================================================
# Lifecycle
# =========================================================
async def round_scheduler():
    """
    Watches current round timing; when it expires, calls admin_close_round()
    which settles, pays, and opens the next round.
    """
    while True:
        try:
            rid = await dbmod.kv_get(app.state.db, "current_round_id")
            if not rid:
                await asyncio.sleep(2)
                continue
            async with app.state.db.execute(
                "SELECT closes_at,status FROM rounds WHERE id=?", (rid,)
            ) as cur:
                row = await cur.fetchone()
            if not row:
                await asyncio.sleep(2)
                continue
            closes_at = datetime.fromisoformat(row[0])
            status = (row[1] or "").upper()
            now = datetime.utcnow()

            if status == "OPEN" and now >= closes_at:
                # Use the same logic as the admin endpoint (no HTTP needed)
                await admin_close_round(auth=True)
                # small breather to avoid tight loop
                await asyncio.sleep(1.0)
            else:
                # sleep until close or check again shortly
                sleep_s = max(1.0, min(5.0, (closes_at - now).total_seconds()))
                await asyncio.sleep(sleep_s)
        except Exception:
            await asyncio.sleep(2.0)

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
        closes = now + timedelta(minutes=ROUND_MIN)
        round_srv = secrets.token_hex(32)
        await dbmod.kv_set(app.state.db, f"round:{rid}:server_seed", round_srv)
        srv_hash = _hash(round_srv)
        curr_slot = await _rpc_get_slot()
        finalize_slot = curr_slot + (ROUND_MIN * SLOTS_PER_MIN)
        await app.state.db.execute(
            "INSERT INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,finalize_slot,pot) VALUES(?,?,?,?,?,?,?,?)",
            (rid, "OPEN", now.isoformat(), closes.isoformat(), srv_hash, secrets.token_hex(8), finalize_slot, 0),
        )
        await dbmod.kv_set(app.state.db, "current_round_id", rid)
        await app.state.db.commit()

    # Start internal scheduler loop
    asyncio.create_task(round_scheduler())

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
    amount: int = Field(ge=1, description="Amount in smallest units (e.g., token base units)")
    side: Literal["TRICK", "TREAT"]

class BetResp(BaseModel):
    bet_id: str
    server_seed_hash: str
    deposit: str
    memo: str

class BetFullResp(BaseModel):
    id: str
    user: Optional[str] = None
    side: Optional[str] = None
    wager: int
    result: Optional[str] = None
    win: Optional[int] = None
    status: str
    server_seed_hash: str
    server_seed_reveal: Optional[str] = None
    tx_sig: Optional[str] = None
    payout_sig: Optional[str] = None
    short_deposit: Optional[int] = None
    created_at: str
    settled_at: Optional[str] = None

class RoundWinnerResp(BaseModel):
    round_id: str
    status: str
    pot: int
    opens_at: str
    closes_at: str
    winner: Optional[str] = None
    payout_sig: Optional[str] = None
    entries: int
    total_tickets: int
    # Fairness evidence (make them part of the model so they return!)
    server_seed_hash: Optional[str] = None
    server_seed_reveal: Optional[str] = None
    finalize_slot: Optional[int] = None
    entropy: Optional[str] = None

class ConfigResp(BaseModel):
    token: dict
    raffle: dict
    vaults: dict
    timers: dict
    limits: dict

class RecentRoundResp(BaseModel):
    id: str
    pot: int

class TxLinkResp(BaseModel):
    url: str

class CreditResp(BaseModel):
    wallet: str
    credit: int

class EntryResp(BaseModel):
    user: str
    tickets: int
    tx_sig: str
    created_at: str

# =========================================================
# Endpoints — Bets
# =========================================================
@app.post(f"{API}/bets", response_model=BetResp)
async def create_bet(body: NewBet):
    """
    Create a coin-flip bet. Commits server_seed_hash (reveal later) and enforces wager cap:
      wager <= (GAME_VAULT balance / 2)
    """
    # Enforce max wager based on current vault balance (base units)
    vault_bal = await _rpc_get_token_balance(getattr(settings, "GAME_VAULT_ATA", ""))
    max_wager = vault_bal // 2
    if body.amount > max_wager:
        raise HTTPException(400, f"Max wager is {max_wager} base units right now.")

    bet_id = secrets.token_hex(6)

    # Commit-reveal seed
    server_seed = secrets.token_hex(32)
    server_seed_hash = _hash(server_seed)
    await dbmod.kv_set(app.state.db, f"bet:{bet_id}:server_seed", server_seed)

    client_seed = secrets.token_hex(8)

    await app.state.db.execute(
        "INSERT INTO bets(id, user, client_seed, server_seed_hash, server_seed_reveal, wager, side, status, created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (
            bet_id,
            "",
            client_seed,
            server_seed_hash,
            None,                    # reveal later at settlement
            body.amount,
            body.side,
            "PENDING",
            datetime.utcnow().isoformat(),
        ),
    )
    await app.state.db.commit()

    deposit = settings.GAME_VAULT
    memo = f"BET:{bet_id}:{body.side}"
    return {"bet_id": bet_id, "server_seed_hash": server_seed_hash, "deposit": deposit, "memo": memo}

# =========================================================
# Endpoints — Rounds (current / recent)
# =========================================================
class RoundCurrentResp(BaseModel):
    round_id: str
    status: str
    opens_at: str
    closes_at: str
    pot: int
    next_opens_at: str
    round_minutes: int
    break_minutes: int

@app.get(f"{API}/rounds/current", response_model=RoundCurrentResp)
async def rounds_current():
    rid = await dbmod.kv_get(app.state.db, "current_round_id")
    async with app.state.db.execute(
        "SELECT id, status, opens_at, closes_at, pot FROM rounds WHERE id=?",
        (rid,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "No current round")
    next_open = (datetime.fromisoformat(row[3]) + timedelta(minutes=ROUND_BREAK)).isoformat()
    return RoundCurrentResp(
        round_id=row[0],
        status=row[1],
        opens_at=row[2],
        closes_at=row[3],
        pot=row[4],
        next_opens_at=next_open,
        round_minutes=ROUND_MIN,
        break_minutes=ROUND_BREAK,
    )

@app.get(f"{API}/rounds/recent", response_model=list[RecentRoundResp])
async def rounds_recent(limit: int = 10):
    async with app.state.db.execute(
        "SELECT id, pot FROM rounds ORDER BY opens_at DESC LIMIT ?",
        (limit,),
    ) as cur:
        rows = await cur.fetchall()

    if not rows:
        rid = await dbmod.kv_get(app.state.db, "current_round_id")
        return [RecentRoundResp(id=rid, pot=0)] if rid else []

    return [RecentRoundResp(id=r[0], pot=r[1]) for r in rows]


# =========================================================
# Read Endpoints — Fairness & Transparency
# =========================================================
@app.get(f"{API}/bets/{{bet_id}}", response_model=BetFullResp)
async def get_bet(bet_id: str):
    async with app.state.db.execute(
        "SELECT id,user,wager,side,result,win,status,server_seed_hash,server_seed_reveal,tx_sig,created_at,settled_at "
        "FROM bets WHERE id=?",
        (bet_id,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Bet not found")

    # KV extras
    payout_sig = await dbmod.kv_get(app.state.db, f"bet:{bet_id}:payout_sig")
    short_amt = await dbmod.kv_get(app.state.db, f"bet:{bet_id}:short_deposit")

    return {
        "id": row[0],
        "user": row[1],
        "wager": int(row[2] or 0),
        "side": row[3],
        "result": row[4],
        "win": int(row[5] or 0) if row[5] is not None else None,
        "status": row[6],
        "server_seed_hash": row[7],
        "server_seed_reveal": row[8],
        "tx_sig": row[9],
        "created_at": row[10],
        "settled_at": row[11],
        "payout_sig": payout_sig,
        "short_deposit": int(short_amt) if short_amt is not None else None,
    }


@app.get(f"{API}/rounds/{{round_id}}/winner", response_model=RoundWinnerResp)
async def get_round_winner(round_id: str):
    # Round basics
    async with app.state.db.execute(
        "SELECT id,status,opens_at,closes_at,pot,server_seed_hash,server_seed_reveal,finalize_slot FROM rounds WHERE id=?",
        (round_id,),
    ) as cur:
        r = await cur.fetchone()
    if not r:
        raise HTTPException(404, "Round not found")

    # Winner + payout (from KV, written during admin_close_round)
    winner = await dbmod.kv_get(app.state.db, f"round:{round_id}:winner")
    payout_sig = await dbmod.kv_get(app.state.db, f"round:{round_id}:payout_sig")

    # Entry stats
    async with app.state.db.execute(
        "SELECT COUNT(1), COALESCE(SUM(tickets),0) FROM entries WHERE round_id=?",
        (round_id,),
    ) as cur:
        stats = await cur.fetchone()
    entries_count = int(stats[0] or 0)
    total_tickets = int(stats[1] or 0)

    # KV fairness bits
    entropy = await dbmod.kv_get(app.state.db, f"round:{round_id}:entropy")

    return {
        "round_id": r[0],
        "status": r[1],
        "opens_at": r[2],
        "closes_at": r[3],
        "pot": int(r[4] or 0),
        "winner": winner,
        "payout_sig": payout_sig,
        "entries": entries_count,
        "total_tickets": total_tickets,
        "server_seed_hash": r[5],
        "server_seed_reveal": r[6],
        "finalize_slot": r[7],                 
        "entropy": entropy,
    }

@app.get(f"{API}/config", response_model=ConfigResp)
async def get_config(include_balances: bool = False):
    # Current round timing (for countdowns)
    rid = await dbmod.kv_get(app.state.db, "current_round_id")
    opens_at = closes_at = next_opens_at = None
    if rid:
        async with app.state.db.execute(
            "SELECT opens_at, closes_at FROM rounds WHERE id=?", (rid,)
        ) as cur:
            row = await cur.fetchone()
        if row:
            opens_at = row[0]
            closes_at = row[1]
            next_opens_at = (datetime.fromisoformat(closes_at) + timedelta(minutes=ROUND_BREAK)).isoformat()

    # Vault balances / limits (optional — hits RPC)
    game_vault_ata = getattr(settings, "GAME_VAULT_ATA", "")
    jackpot_vault_ata = getattr(settings, "JACKPOT_VAULT_ATA", "")
    game_bal = jack_bal = None
    max_wager = None
    if include_balances:
        game_bal = await _rpc_get_token_balance(game_vault_ata)
        jack_bal = await _rpc_get_token_balance(jackpot_vault_ata)
        if game_bal is not None:
            max_wager = game_bal // 2

    return {
        "token": {
            "mint": settings.TREATZ_MINT,
            "decimals": getattr(settings, "TOKEN_DECIMALS", 6),
            "ticket_price": settings.TICKET_PRICE,  # base units
        },
        "raffle": {
            "round_minutes": ROUND_MIN,
            "break_minutes": ROUND_BREAK,
            "splits": {"winner": SPLT_WIN, "dev": SPLT_DEV, "burn": SPLT_BURN},
            "dev_wallet": DEV_WALLET or None,
            "burn_address": BURN_ADDRESS or None,
        },
        "vaults": {
            "game_vault": settings.GAME_VAULT,
            "game_vault_ata": game_vault_ata or None,
            "jackpot_vault": settings.JACKPOT_VAULT,
            "jackpot_vault_ata": jackpot_vault_ata or None,
        },
        "timers": {
            "current_round_id": rid,
            "opens_at": opens_at,
            "closes_at": closes_at,
            "next_opens_at": next_opens_at,
        },
        "limits": {
            "max_wager_base_units": max_wager,            # null unless include_balances=true
            "game_vault_balance": game_bal,               # null unless include_balances=true
            "jackpot_vault_balance": jack_bal,            # null unless include_balances=true
        },
    }

EXPLORER_BASE = "https://solscan.io/tx/"

@app.get(f"{API}/tx/{{sig}}", response_model=TxLinkResp)
async def get_tx(sig: str) -> TxLinkResp:
    return TxLinkResp(url=f"{EXPLORER_BASE}{sig}")

@app.get(f"{API}/health/full")
async def health_full():
    try:
        slot = await _rpc_get_slot()
        ok_rpc = True
    except Exception:
        slot = None
        ok_rpc = False
    return {
        "ok": True,
        "service": "$TREATZ",
        "rpc_ok": ok_rpc,
        "slot": slot,
        "ts": time.time(),
        "version": "0.1.0",
    }

# Raffle credit for a wallet (base units)
@app.get(f"{API}/credits/{wallet}", response_model=CreditResp)
async def get_credit(wallet: str):
    val = await dbmod.kv_get(app.state.db, f"raffle_credit:{wallet}")
    return CreditResp(wallet=wallet, credit=int(val or 0))

# Entries for a round (paginated)
@app.get(f"{API}/rounds/{round_id}/entries", response_model=list[EntryResp])
async def list_round_entries(round_id: str, offset: int = 0, limit: int = 100):
    async with app.state.db.execute(
        "SELECT user, tickets, tx_sig, created_at FROM entries WHERE round_id=? ORDER BY id ASC LIMIT ? OFFSET ?",
        (round_id, limit, offset),
    ) as cur:
        rows = await cur.fetchall()
    return [
        EntryResp(user=r[0], tickets=int(r[1] or 0), tx_sig=r[2], created_at=r[3])
        for r in rows
    ]

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
        return hmac.compare_digest(computed, sig)
    except Exception:
        return False

def _parse_token_transfer(ev: dict):
    # Prefer tokenTransfers array (Helius), fallback to root fields
    tts = ev.get("tokenTransfers") or ev.get("transfers") or []
    for tt in tts:
        mint = (tt.get("mint") or tt.get("tokenAddress") or "").lower()
        if mint == (settings.TREATZ_MINT or "").lower():
            return {
                "amount": int(tt.get("tokenAmount", 0) or tt.get("amount", 0)),
                "source": tt.get("fromUserAccount") or tt.get("from") or "",
                "destination": tt.get("toUserAccount") or tt.get("to") or "",
                "mint": mint,
            }
    return {
        "amount": int(ev.get("amount", 0)),
        "source": ev.get("source") or "",
        "destination": ev.get("destination") or "",
        "mint": (ev.get("mint") or "").lower(),
    }

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

        parsed = _parse_token_transfer(ev)
        amt = int(parsed.get("amount", 0))
        to_addr_raw = parsed.get("destination") or ""
        sender_raw = parsed.get("source") or ""
        to_addr = to_addr_raw.lower()

        # Mint guard: skip if not our token
        if (ev.get("tokenTransfers") or ev.get("transfers")):
            # already filtered by _parse_token_transfer
            if parsed.get("mint") != (settings.TREATZ_MINT or "").lower():
                continue
        else:
            ev_mint = (ev.get("mint") or "").lower()
            if ev_mint and ev_mint != (settings.TREATZ_MINT or "").lower():
                continue

        game_vault = (settings.GAME_VAULT or "").lower()
        jackpot_vault = (settings.JACKPOT_VAULT or "").lower()

        # ---------------- Coin flip deposits ----------------
        if memo.startswith("BET:") and to_addr == game_vault:
            try:
                _, bet_id, choice = memo.split(":")
            except Exception:
                continue

            # Fetch wager + status for idempotency
            async with app.state.db.execute(
                "SELECT wager, status FROM bets WHERE id=?", (bet_id,)
            ) as cur:
                row = await cur.fetchone()
                if not row:
                    continue

            wager = int(row[0] or 0)
            prev_status = (row[1] or "").upper()

            existing_payout = await dbmod.kv_get(app.state.db, f"bet:{bet_id}:payout_sig")
            if prev_status == "SETTLED" and existing_payout:
                continue

            # Short-deposit guard
            if amt < wager:
                await dbmod.kv_set(app.state.db, f"bet:{bet_id}:short_deposit", str(amt))
                await app.state.db.commit()
                continue

            # Commit-reveal
            server_seed = await dbmod.kv_get(app.state.db, f"bet:{bet_id}:server_seed")
            if not server_seed:
                await dbmod.kv_set(app.state.db, f"bet:{bet_id}:payout_error", "missing_server_seed")
                await app.state.db.commit()
                continue

            async with app.state.db.execute("SELECT client_seed FROM bets WHERE id=?", (bet_id,)) as c2:
                r2 = await c2.fetchone()
            client_seed = r2[0] if r2 else ""

            rng = int.from_bytes(_hmac(server_seed, tx_sig + client_seed), "big")
            result = "TREAT" if (rng % 2) else "TRICK"
            server_seed_reveal = server_seed

            win = int(result == choice)
            status = "SETTLED"

            await app.state.db.execute(
                "UPDATE bets SET user=?, result=?, win=?, status=?, server_seed_reveal=?, tx_sig=?, settled_at=? WHERE id=?",
                (sender_raw, result, win, status, server_seed_reveal, tx_sig, datetime.utcnow().isoformat(), bet_id),
            )
            await app.state.db.commit()

            if win and wager > 0 and not existing_payout:
                try:
                    payout_amount = wager * int(getattr(settings, "WIN_AMOUNT", 2))
                    payout_sig = await pay_coinflip_winner(sender_raw, payout_amount)
                    await dbmod.kv_set(app.state.db, f"bet:{bet_id}:payout_sig", payout_sig)
                    await app.state.db.commit()
                except Exception as e:
                    await dbmod.kv_set(app.state.db, f"bet:{bet_id}:payout_error", str(e))
                    await app.state.db.commit()

        # ---------------- Jackpot entries -------------------
        if memo.startswith("JP:") and to_addr == jackpot_vault and amt > 0:
            parts = memo.split(":")
            if len(parts) >= 2 and parts[1]:
                round_id = parts[1]
            else:
                round_id = await dbmod.kv_get(app.state.db, "current_round_id")

            # full tickets only
            tickets = amt // settings.TICKET_PRICE
            remainder = amt - (tickets * settings.TICKET_PRICE)

            try:
                await app.state.db.execute("BEGIN")
                if tickets > 0:
                    await app.state.db.execute(
                        "INSERT INTO entries(round_id,user,tickets,tx_sig) VALUES(?,?,?,?)",
                        (round_id, sender_raw, tickets, tx_sig),
                    )
                    await app.state.db.execute(
                        "UPDATE rounds SET pot = COALESCE(pot,0) + ? WHERE id=?",
                        (tickets * settings.TICKET_PRICE, round_id),
                    )
                if remainder > 0:
                    key = f"raffle_credit:{sender_raw}"
                    existing = await dbmod.kv_get(app.state.db, key)
                    cur = int(existing or 0)
                    await dbmod.kv_set(app.state.db, key, str(cur + remainder))
                await app.state.db.commit()
            except Exception:
                await app.state.db.rollback()
                raise


# =========================================================
# Admin Helpers (simple, no auth — secure behind network!)
# =========================================================
@app.post(f"{API}/admin/round/close")
async def admin_close_round(auth: bool = Depends(admin_guard)):
    """Settle current round using commit-reveal + external entropy, split payouts, then open next round and auto-apply credits."""
    rid = await dbmod.kv_get(app.state.db, "current_round_id")

    # Load round basics
    async with app.state.db.execute("SELECT pot, opens_at, closes_at, server_seed_hash, server_seed_reveal, finalize_slot FROM rounds WHERE id=?", (rid,)) as cur:
        r = await cur.fetchone()
    pot = int(r[0] if r else 0)
    finalize_slot = int(r[5] or 0) if r else 0

    # Gather entries
    async with app.state.db.execute("SELECT user, tickets FROM entries WHERE round_id=?", (rid,)) as cur:
        entries = await cur.fetchall()

    winner_addr = None
    payout_sig = None

    # --- Commit-reveal for round ---
    round_server_seed = await dbmod.kv_get(app.state.db, f"round:{rid}:server_seed")
    if not round_server_seed:
        # backstop; generate one to avoid blocking (won't match hash though)
        round_server_seed = secrets.token_hex(32)
        await dbmod.kv_set(app.state.db, f"round:{rid}:server_seed", round_server_seed)

    # External entropy = blockhash at finalize_slot; fallback to last entry tx
    entropy = await _rpc_get_blockhash(finalize_slot) if finalize_slot else None
    if not entropy:
        async with app.state.db.execute("SELECT tx_sig FROM entries WHERE round_id=? ORDER BY id DESC LIMIT 1", (rid,)) as cur:
            last = await cur.fetchone()
        entropy = last[0] if last and last[0] else secrets.token_hex(16)

    # Weighted draw
    total_tix = sum(int(t or 0) for _u, t in entries)
    if pot > 0 and total_tix > 0:
        pick_space = int.from_bytes(_hmac(round_server_seed, (entropy + rid)), "big") % total_tix
        acc = 0
        for u, t in entries:
            acc += int(t or 0)
            if acc > pick_space:
                winner_addr = u
                break

        # Store reveal & entropy on round
        await app.state.db.execute(
            "UPDATE rounds SET server_seed_reveal=? WHERE id=?",
            (round_server_seed, rid),
        )
        await dbmod.kv_set(app.state.db, f"round:{rid}:entropy", entropy)

        # Split pot
        total_pct = max(1, SPLT_WIN + SPLT_DEV + SPLT_BURN)
        win_amt  = pot * SPLT_WIN  // total_pct
        dev_amt  = pot * SPLT_DEV  // total_pct if DEV_WALLET else 0
        burn_amt = pot * SPLT_BURN // total_pct if BURN_ADDRESS else 0
        # adjust rounding remainder to winner
        remainder = pot - (win_amt + dev_amt + burn_amt)
        win_amt += remainder

        try:
            payout_sig = await pay_jackpot_split(
                winner_addr, win_amt,
                DEV_WALLET, dev_amt,
                BURN_ADDRESS, burn_amt,
            )
            await dbmod.kv_set(app.state.db, f"round:{rid}:winner", winner_addr)
            await dbmod.kv_set(app.state.db, f"round:{rid}:payout_sig", payout_sig)
            await dbmod.kv_set(app.state.db, f"round:{rid}:split",
                               f"win:{win_amt},dev:{dev_amt},burn:{burn_amt}")
        except Exception as e:
            await dbmod.kv_set(app.state.db, f"round:{rid}:payout_error", str(e))

    # Close current
    await app.state.db.execute("UPDATE rounds SET status='SETTLED' WHERE id=?", (rid,))

    # Open next round (timed with ROUND_MIN & finalize_slot)
    new_id = f"R{secrets.randbelow(10_000):04d}"
    now = datetime.utcnow() + timedelta(minutes=ROUND_BREAK)
    closes = now + timedelta(minutes=ROUND_MIN)

    new_round_srv = secrets.token_hex(32)
    await dbmod.kv_set(app.state.db, f"round:{new_id}:server_seed", new_round_srv)
    srv_hash = _hash(new_round_srv)

    curr_slot = await _rpc_get_slot()
    finalize_slot = curr_slot + (ROUND_MIN * SLOTS_PER_MIN)

    await app.state.db.execute(
        "INSERT INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,finalize_slot,pot) VALUES(?,?,?,?,?,?,?,?)",
        (new_id, "OPEN", now.isoformat(), closes.isoformat(), srv_hash, secrets.token_hex(8), finalize_slot, 0),
    )
    await dbmod.kv_set(app.state.db, "current_round_id", new_id)
    await app.state.db.commit()

    # Auto-apply credits to NEW round
    async with app.state.db.execute("SELECT k, v FROM kv WHERE k LIKE 'raffle_credit:%'") as cur:
        credit_rows = await cur.fetchall()
    for k, v in credit_rows:
        owner = k.split("raffle_credit:", 1)[1]
        credit = int(v or 0)
        if credit >= settings.TICKET_PRICE:
            extra_tix = credit // settings.TICKET_PRICE
            rem = credit % settings.TICKET_PRICE
            await app.state.db.execute(
                "INSERT INTO entries(round_id,user,tickets,tx_sig) VALUES(?,?,?,?)",
                (new_id, owner, extra_tix, f"auto_credit_{new_id}_{owner[:6]}"),
            )
            # note: pot increases only by tickets*price
            await app.state.db.execute(
                "UPDATE rounds SET pot = COALESCE(pot,0) + ? WHERE id=?",
                (extra_tix * settings.TICKET_PRICE, new_id),
            )
            await dbmod.kv_set(app.state.db, k, str(rem))
    await app.state.db.commit()

    return {
        "ok": True,
        "settled_round": rid,
        "winner": winner_addr,
        "payout_sig": payout_sig,
        "new_round": new_id
    }

@app.post(f"{API}/admin/round/seed")
async def admin_seed_rounds(n: int = 5, auth: bool = Depends(admin_guard)):
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
