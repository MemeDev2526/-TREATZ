# main.py
# =========================================================
# $TREATZ Backend (FastAPI)
# =========================================================
from __future__ import annotations

import hmac
import hashlib
import secrets
import time
import asyncio
import traceback
import base58 as _b58
from datetime import datetime, timedelta, timezone
def _rfc3339(dt: Optional[datetime]) -> Optional[str]:
    """
    Return an RFC3339-style UTC timestamp ending with 'Z'.
    Accepts naive or aware datetimes and normalizes to UTC (no offset).

    Returns:
        RFC3339 string ending with 'Z', or None if dt is None.
    """
    if dt is None:
        return None
    # if naive, treat as UTC
    if dt.tzinfo is None:
        dt_utc = dt.replace(microsecond=0)
    else:
        # convert to UTC and drop tzinfo for canonical Z suffix
        dt_utc = dt.astimezone(timezone.utc).replace(microsecond=0)

    # Use ISO format without offset, append 'Z'
    # If dt_utc.isoformat() contains an offset (it won't after astimezone+replace above),
    # we still strip anything after the seconds portion for safety.
    iso = dt_utc.isoformat()
    if iso.endswith("+00:00"):
        iso = iso.rsplit("+", 1)[0]
    # remove possible fractional seconds already handled by replace
    return iso + "Z"
from typing import Literal, Optional
import os
from fastapi.responses import FileResponse
from fastapi import FastAPI, HTTPException, Request, Query
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from config import settings
import db as dbmod
from db import ensure_schema   # import canonical schema
# robust imports for solana public key / keypair
try:
    # preferred: solana-py public API
    from solana.publickey import PublicKey
    from solana.keypair import Keypair
except Exception as _e:
    # fallback: try solders types if solana-py isn't present
    try:
        from solders.pubkey import Pubkey as PublicKey  # note: different class name
        from solders.keypair import Keypair as SolderKeypair
        # wrap solders keypair to a compatible interface if needed (basic)
        class Keypair:
            def __init__(self, kp: SolderKeypair):
                self._kp = kp
            @property
            def public_key(self):
                return self._kp.pubkey()
            def to_bytes(self):
                return bytes(self._kp.to_bytes())
        # you may not need more adaptation for your current code paths
    except Exception as err:
        # Helpful error to surface in logs so you know why import failed
        raise ImportError(
            "Failed to import solana PublicKey/Keypair. "
            "Ensure 'solana' is listed in requirements.txt and no local 'solana.py' or 'solana/' folder exists. "
            f"Inner error: {_e} / {err}"
        )

# NEW: payout helpers (sign + send SPL from vaults)
from payouts import pay_coinflip_winner, pay_jackpot_winner, pay_jackpot_split

# NEW: RPC helpers for balances/entropy
from solana.rpc.async_api import AsyncClient

RPC_URL = settings.RPC_URL
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

# Paths
BASE_DIR = os.path.dirname(__file__)
STATIC_DIR = os.path.join(BASE_DIR, "static")
ASSETS_DIR = os.path.join(BASE_DIR, "assets")

# ✅ Serve built frontend (Vite output) under /static (if present)
if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# ✅ Also serve the raw repo assets folder under /assets so legacy references work
if os.path.isdir(ASSETS_DIR):
    app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")

# ✅ Serve a favicon if present in static
@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    # prefer static/favicon.ico, then assets/favicon.ico, else 404
    p1 = os.path.join(STATIC_DIR, "favicon.ico")
    p2 = os.path.join(ASSETS_DIR, "favicon.ico")
    if os.path.exists(p1):
        return FileResponse(p1)
    if os.path.exists(p2):
        return FileResponse(p2)
    raise HTTPException(status_code=404, detail="favicon not found")


# ✅ Serve index.html at root (for SPA routing)
@app.get("/", include_in_schema=False)
async def serve_index():
    # Prefer built /static/index.html (from Vite)
    index_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    # fallback: local root index.html (e.g. dev mode)
    fallback_path = os.path.join(BASE_DIR, "index.html")
    if os.path.exists(fallback_path):
        return FileResponse(fallback_path)
    return {"error": "index.html not found"}
    
@app.get("/whitepaper", include_in_schema=False)
async def whitepaper():
    p = os.path.join(STATIC_DIR, "whitepaper.html")
    if os.path.exists(p):
        return FileResponse(p)
    # fallback: repo root whitepaper
    p2 = os.path.join(BASE_DIR, "whitepaper.html")
    if os.path.exists(p2):
        return FileResponse(p2)
    raise HTTPException(404, "whitepaper not found")
    
@app.get("/_debug/list_static", include_in_schema=False)
async def list_static():
    files = []
    for root, dirs, filenames in os.walk(STATIC_DIR):
        for f in filenames:
            files.append(os.path.relpath(os.path.join(root,f), STATIC_DIR))
    return {"static_exists": os.path.isdir(STATIC_DIR), "files": files[:400]}
# ----------------------------- CORS ---------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://trickortreatsol.tech",
        "https://memedev2526.github.io",
        "https://memedev2526.github.io/-TREATZ",
        "https://treatz-de1d.onrender.com",
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
    """
    Return token amount (base units) for a given ATA/pubkey string.
    Tries several PublicKey construction strategies to be tolerant across versions.
    Returns 0 if the ATA is empty, RPC fails, or the account has no balance.
    """
    if not ata:
        return 0

    # Build a key acceptable to solana-py (try several fallbacks)
    key = None
    try:
        # Preferred: direct constructor (works for string or base58)
        key = PublicKey(ata)
    except Exception:
        try:
            # Fallback: decode base58 to raw bytes then construct PublicKey
            raw = _b58.b58decode(ata)
            if len(raw) == 32:
                key = PublicKey(raw)
            else:
                # if decoded length isn't 32, leave as raw string fallback
                key = ata
        except Exception:
            # Final fallback: keep raw string (some clients accept a str pubkey)
            key = ata

    try:
        async with AsyncClient(RPC_URL) as c:
            r = await c.get_token_account_balance(key)

            # solders / object shape: r.value.amount
            val = getattr(r, "value", None)
            amt = None
            if val is not None:
                # If val is an object with attribute .amount
                amt = getattr(val, "amount", None)
                # Or if val is a dict-like
                if amt is None and isinstance(val, dict):
                    amt = val.get("amount")

            # dict shape fallback: r['result']['value']['amount']
            if amt is None and isinstance(r, dict):
                amt = (((r.get("result") or {}).get("value") or {}).get("amount"))

            return int(str(amt)) if amt is not None else 0
    except Exception:
        # RPC or parsing failed — treat as zero so frontend gets a clear error later
        return 0

async def _rpc_get_slot() -> int:
    async with AsyncClient(RPC_URL) as c:
        s = await c.get_slot()
        val = getattr(s, "value", None)
        return val if val is not None else s["result"]

def _as_str_blockhash(h) -> Optional[str]:
    """Return a plain string for blockhash objects (solders.Hash, etc.)."""
    if h is None:
        return None
    if isinstance(h, str):
        return h
    try:
        return str(h)  # solders.Hash implements __str__
    except Exception:
        try:
            return h.decode() if isinstance(h, (bytes, bytearray)) else None
        except Exception:
            return None

async def _rpc_get_blockhash(slot: int) -> Optional[str]:
    """Fetch blockhash at a specific slot; None if unavailable."""
    async with AsyncClient(RPC_URL) as c:
        b = await c.get_block(slot, max_supported_transaction_version=0)
        val = getattr(b, "value", None)
        if val and hasattr(val, "blockhash"):
            return _as_str_blockhash(val.blockhash)
        if isinstance(b, dict) and b.get("result") and b["result"].get("blockhash"):
            return _as_str_blockhash(b["result"]["blockhash"])
        return None



async def _rpc_get_blockhash_fallback(
    slot: int,
    search_back: int = 2048,
    search_forward: int = 128
) -> tuple[Optional[str], Optional[int]]:
    async with AsyncClient(RPC_URL) as c:
        async def _slot_hash(s: int) -> Optional[str]:
            b = await c.get_block(s, max_supported_transaction_version=0)
            v = getattr(b, "value", None)
            if v and hasattr(v, "blockhash"):
                return _as_str_blockhash(v.blockhash)
            if isinstance(b, dict) and b.get("result") and b["result"].get("blockhash"):
                return _as_str_blockhash(b["result"]["blockhash"])
            return None

        # 1) exact slot
        try:
            h = await _slot_hash(slot)
            if h:
                return h, slot
        except Exception:
            pass

        # 2) walk backward
        for off in range(1, search_back + 1):
            s = slot - off
            if s <= 0:
                break
            try:
                h = await _slot_hash(s)
                if h:
                    return h, s
            except Exception:
                continue

        # 3) small forward window
        for off in range(1, search_forward + 1):
            s = slot + off
            try:
                h = await _slot_hash(s)
                if h:
                    return h, s
            except Exception:
                continue

        # 4) latest finalized blockhash
        try:
            latest = await c.get_latest_blockhash()
            val = getattr(latest, "value", None)
            if val and hasattr(val, "blockhash"):
                return _as_str_blockhash(val.blockhash), None
            if isinstance(latest, dict):
                v = ((latest.get("result") or {}).get("value") or {})
                if v.get("blockhash"):
                    return _as_str_blockhash(v["blockhash"]), None
        except Exception:
            pass

        return None, None

        
async def _rpc_account_exists(pubkey_str: str) -> bool:
    try:
        async with AsyncClient(RPC_URL) as c:
            # Normalize to solana-py PublicKey
            try:
                key = PublicKey(pubkey_str)
            except Exception:
                # fallback — allow whatever was passed through
                key = pubkey_str

            r = await c.get_account_info(key, commitment="confirmed")
            val = getattr(r, "value", None)
            if val is not None:
                return True
            if isinstance(r, dict):
                v = ((r.get("result") or {}).get("value"))
                return v is not None
    except Exception:
        return False
    return False
    
def _parse_iso_z(s: Optional[str]) -> Optional[datetime]:
    """Parse an RFC3339-ish string. Accepts trailing 'Z' by converting to +00:00."""
    if not s:
        return None
    s2 = str(s).strip()
    # Allow plain "Z" timezone by converting to +00:00 which fromisoformat accepts
    if s2.endswith("Z"):
        s2 = s2[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s2)
    except Exception:
        # Fallback: attempt naive parse without offset (YYYY-MM-DDTHH:MM:SS)
        try:
            return datetime.strptime(s2, "%Y-%m-%dT%H:%M:%S")
        except Exception:
            # Re-raise so caller sees the error (so it can be logged)
            raise
            
# ---------- sequential round id helper ----------
async def alloc_next_round_id() -> str:
    """
    Allocate a sequential round id of the form RNNNN using a KV counter 'round:next_id'.
    Returns the new id (e.g. 'R0001').
    """
    key = "round:next_id"
    cur = await dbmod.kv_get(app.state.db, key)
    try:
        n = int(cur or 0) + 1
    except Exception:
        n = 1
    await dbmod.kv_set(app.state.db, key, str(n))
    return f"R{n:04d}"

# =========================================================
# Lifecycle
# =========================================================
async def round_scheduler():
    """
    Watches current round timing; when it expires, calls admin_close_round()
    which settles, pays, and opens the next round.

    Instrumented: when an exception occurs we print full traceback + context
    (current_round_id, last SQL row if available) so we can identify the failing SQL.
    """
    while True:
        try:
            rid = await dbmod.kv_get(app.state.db, "current_round_id")
            if not rid:
                await asyncio.sleep(2)
                continue

            # fetch closes_at / status
            try:
                async with app.state.db.execute(
                    "SELECT closes_at,status FROM rounds WHERE id=?", (rid,)
                ) as cur:
                    row = await cur.fetchone()
            except Exception as sql_ex:
                # SQL failed while selecting — log the SQL error and context
                print("[round_scheduler] SQL select error for current_round_id:", repr(rid), flush=True)
                traceback.print_exc()
                # brief sleep to avoid tight loop if DB is flaky
                await asyncio.sleep(2.0)
                continue

            if not row:
                # nothing found for this round id
                await asyncio.sleep(2)
                continue

            # attempt to parse closes_at robustly (use existing _parse_iso_z if available)
            try:
                # if you have _parse_iso_z defined earlier, use it; otherwise fall back
                closes_at = _parse_iso_z(row[0]) if "_parse_iso_z" in globals() else datetime.fromisoformat(row[0])
            except Exception as parse_ex:
                print("[round_scheduler] failed to parse closes_at:", repr(row[0]), "for round:", rid, flush=True)
                traceback.print_exc()
                await asyncio.sleep(2.0)
                continue

            status = (row[1] or "").upper()
            # use timezone-aware now to match stored ISO datetimes (they should be Z/UTC)
            now = datetime.now(timezone.utc)

            # safety check: ensure closes_at is timezone-aware
            if closes_at.tzinfo is None:
                # treat naive as UTC to avoid comparisons between naive / aware
                closes_at = closes_at.replace(tzinfo=timezone.utc)

            if status == "OPEN" and now >= closes_at:
                try:
                    # call admin_close_round and surface any exception
                    await admin_close_round(auth=True)
                except Exception as admin_ex:
                    print("[round_scheduler] admin_close_round raised an exception for round:", rid, flush=True)
                    traceback.print_exc()
                    # small breather
                    await asyncio.sleep(1.0)
                # small breather to avoid tight loop after handling a close
                await asyncio.sleep(1.0)
            else:
                # compute sleep seconds safely
                try:
                    delta_s = (closes_at - now).total_seconds()
                    sleep_s = max(1.0, min(5.0, delta_s))
                except Exception as se:
                    print("[round_scheduler] error computing sleep interval", flush=True)
                    traceback.print_exc()
                    sleep_s = 2.0
                await asyncio.sleep(sleep_s)
        except Exception as ex:
            # This is a top-level protection: print full traceback and context so you can diagnose.
            try:
                print("[round_scheduler] top-level exception (will sleep 2s):", str(ex), flush=True)
                print("current_round_id:", repr(rid) if 'rid' in locals() else "<unknown>", flush=True)
                if 'row' in locals():
                    print("last row:", repr(row), flush=True)
                traceback.print_exc()
            except Exception:
                pass
            await asyncio.sleep(2.0)
            
@app.on_event("startup")
async def on_startup():
    # Connect DB + ensure schema
    app.state.db = await dbmod.connect(settings.DB_PATH)
    await ensure_schema(app.state.db)

    # Ensure a current (OPEN) round exists
    current = await dbmod.kv_get(app.state.db, "current_round_id")
    if not current:
        rid = await alloc_next_round_id()
        # use timezone-aware UTC now
        now = datetime.now(timezone.utc)
        closes = now + timedelta(minutes=ROUND_MIN)
        round_srv = secrets.token_hex(32)
        await dbmod.kv_set(app.state.db, f"round:{rid}:server_seed", round_srv)
        srv_hash = _hash(round_srv)
        curr_slot = await _rpc_get_slot()
        finalize_slot = curr_slot + (ROUND_MIN * SLOTS_PER_MIN)
        await app.state.db.execute(
            "INSERT INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,finalize_slot,pot) VALUES(?,?,?,?,?,?,?,?)",
             (rid, "OPEN", _rfc3339(now), _rfc3339(closes), srv_hash, secrets.token_hex(8), finalize_slot, 0),
        )
        await dbmod.kv_set(app.state.db, "current_round_id", rid)
        await app.state.db.commit()

    # Start internal scheduler loop and keep a reference (helps debugging / graceful shutdown)
    try:
        print("[round_scheduler] starting task", flush=True)
        app.state.round_scheduler_task = asyncio.create_task(round_scheduler())
    except Exception as e:
        print("[round_scheduler] failed to start:", e, flush=True)
        traceback.print_exc()

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

    # If RPC is down or vault unfunded, max_wager will be 0; fail clearly with JSON
    if max_wager <= 0:
        raise HTTPException(
            status_code=400,
            detail="Wagering temporarily unavailable (RPC unreachable or game vault empty). Try again shortly."
        )

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

    deposit = settings.GAME_VAULT_ATA or settings.GAME_VAULT  # prefer ATA
    memo = f"BET:{bet_id}:{body.side}"
    return {"bet_id": bet_id, "server_seed_hash": server_seed_hash, "deposit": deposit, "memo": memo}

# =========================================================
# Endpoints — Raffle: Buy Tickets (client builds SPL transfer)
# =========================================================
@app.post(f"{API}/rounds/{{round_id}}/buy")
async def rounds_buy_tickets(round_id: str, payload: dict):
    """
    Return deposit + memo (and amounts) for the client to pay with SPL tokens.
    Frontend sends `tickets` (int). We compute amount in base units using settings.TICKET_PRICE.
    """
    try:
        tickets = int(payload.get("tickets", 1))
    except Exception:
        raise HTTPException(400, "tickets must be an integer")

    if tickets < 1:
        raise HTTPException(400, "tickets must be >= 1")

    ticket_price = int(getattr(settings, "TICKET_PRICE", 0))
    if ticket_price <= 0:
        raise HTTPException(500, "TICKET_PRICE not configured")

    amount = ticket_price * tickets

    # Make a memo that your ingest can parse (JP = jackpot)
    # Format: JP:<round_id>:<nonce>
    nonce = secrets.token_hex(4)
    memo = f"JP:{round_id}:{nonce}"

    # Prefer JACKPOT ATA; fall back to JACKPOT owner
    deposit = (getattr(settings, "JACKPOT_VAULT_ATA", None) or
               getattr(settings, "JACKPOT_VAULT", None))

    if not deposit:
        raise HTTPException(500, "Game vault address not configured")

    return {
        "deposit": deposit,
        "memo": memo,
        "amount": amount,          # base units
        "ticket_base": ticket_price,
        "tickets": tickets
    }


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

    # parse the timestamps
    opens_dt = _parse_iso_z(row[2])
    closes_dt = _parse_iso_z(row[3])
    next_open_dt = closes_dt + timedelta(minutes=ROUND_BREAK)

    return RoundCurrentResp(
        round_id=row[0],
        status=row[1],
        opens_at=_rfc3339(opens_dt),
        closes_at=_rfc3339(closes_dt),
        pot=row[4],
        next_opens_at=_rfc3339(next_open_dt),
        round_minutes=ROUND_MIN,
        break_minutes=ROUND_BREAK,
    )
    
@app.get(f"{API}/rounds/recent", response_model=list[RecentRoundResp])
async def rounds_recent(limit: int = 10):
    # sanitize & clamp the limit before inlining to avoid parameterized LIMIT quirks
    try:
        n = max(1, min(100, int(limit)))
    except Exception:
        n = 10

    query = f"SELECT id, pot FROM rounds ORDER BY opens_at DESC LIMIT {n}"
    try:
        async with app.state.db.execute(query) as cur:
            rows = await cur.fetchall()
    except Exception as e:
        print("[rounds_recent] DB error:", e, flush=True)
        traceback.print_exc()
        raise HTTPException(500, "Failed to fetch recent rounds")

    if not rows:
        rid = await dbmod.kv_get(app.state.db, "current_round_id")
        return [RecentRoundResp(id=rid, pot=0)] if rid else []

    return [RecentRoundResp(id=str(r[0]), pot=int(r[1] or 0)) for r in rows]
    
@app.get(f"{API}/rounds")
async def rounds_list(search: Optional[str] = Query(None), limit: int = Query(25)):
    """
    Return recent rounds (for history view). Response shape matches frontend expectation:
      { "rows": [ { id: "...", "pot": 12345, "opens_at": "...", "closes_at": "..." }, ... ] }
    Supports optional `search` (substring on id) and `limit`.
    """
    try:
        n = max(1, min(200, int(limit)))
    except Exception:
        n = 25

    # Basic SQL + optional filtering
    params = []
    base_sql = "SELECT id, pot, opens_at, closes_at FROM rounds"
    if search:
        # Allow searching by id (e.g., R1601) or by winner or seed fragments if desired.
        base_sql += " WHERE id LIKE ?"
        params.append(f"%{search}%")
    base_sql += " ORDER BY opens_at DESC LIMIT ?"
    params.append(n)

    try:
        async with app.state.db.execute(base_sql, tuple(params)) as cur:
            rows = await cur.fetchall()
    except Exception as e:
        print("[rounds_list] DB error:", e, flush=True)
        traceback.print_exc()
        raise HTTPException(500, "Failed to fetch rounds")

    result = []
    for r in rows:
        result.append({
            "id": r[0],
            "pot": int(r[1] or 0),
            "opens_at": r[2],
            "closes_at": r[3],
        })

    return {"rows": result}
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

# =========================================================
# Public RPC Proxies (Frontend-safe)
# =========================================================
@app.get(f"{API}/cluster/latest_blockhash")
async def latest_blockhash():
    """
    Frontend-safe latest blockhash. Does not expose provider URL.
    """
    try:
        async with AsyncClient(RPC_URL) as c:
            resp = await c.get_latest_blockhash()  # default commitment
            # solders object?
            val = getattr(resp, "value", None)
            if val is not None:
                bh = _as_str_blockhash(getattr(val, "blockhash", None))
                lvh = getattr(val, "last_valid_block_height", None) or getattr(val, "lastValidBlockHeight", None)
                return {
                    "blockhash": bh,
                    "last_valid_block_height": int(lvh) if lvh is not None else None
                }

            # dict shape
            if isinstance(resp, dict):
                v = ((resp.get("result") or {}).get("value") or resp.get("result") or {})
                return {
                    "blockhash": v.get("blockhash"),
                    "last_valid_block_height": v.get("lastValidBlockHeight") or v.get("last_valid_block_height")
                }
    except Exception as e:
        raise HTTPException(503, f"blockhash_unavailable: {e}")

@app.get(f"{API}/accounts/{{pubkey}}/exists")
async def account_exists(pubkey: str):
    """
    Frontend-safe check: does this account exist?
    """
    try:
        ok = await _rpc_account_exists(pubkey)
        return {"exists": bool(ok)}
    except Exception as e:
        raise HTTPException(400, f"bad_pubkey: {e}")

@app.get(f"{API}/rounds/{{round_id}}/winner", response_model=RoundWinnerResp)
async def get_round_winner(round_id: str):
    # Round basics
    try:
        async with app.state.db.execute(
            "SELECT id,status,opens_at,closes_at,pot,server_seed_hash,server_seed_reveal,finalize_slot FROM rounds WHERE id=?",
            (round_id,),
        ) as cur:
            r = await cur.fetchone()
    except Exception as e:
        print("[get_round_winner] DB error for", round_id, ":", e, flush=True)
        traceback.print_exc()
        raise HTTPException(500, "DB error")

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
    o_dt = c_dt = n_dt = None
    if rid:
        async with app.state.db.execute(
            "SELECT opens_at, closes_at FROM rounds WHERE id=?", (rid,)
        ) as cur:
            row = await cur.fetchone()
        if row:
            opens_at = row[0]
            closes_at = row[1]
            o_dt = _parse_iso_z(opens_at)
            c_dt = _parse_iso_z(closes_at)
            n_dt = c_dt + timedelta(minutes=ROUND_BREAK)
    # Vault balances / limits (optional — hits RPC)
    game_vault_ata = getattr(settings, "GAME_VAULT_ATA", "")
    jackpot_vault_ata = getattr(settings, "JACKPOT_VAULT_ATA", "")
    game_bal = jack_bal = None
    max_wager = None
    if include_balances:
        try:
            game_bal = await _rpc_get_token_balance(game_vault_ata)
        except Exception:
            game_bal = None
        try:
            jack_bal = await _rpc_get_token_balance(jackpot_vault_ata)
        except Exception:
            jack_bal = None
        if isinstance(game_bal, int):
            max_wager = game_bal // 2

    return {
        "token": {
            "mint": settings.TREATZ_MINT,
            "decimals": getattr(settings, "TOKEN_DECIMALS", 6),
            "ticket_price": settings.TICKET_PRICE,  # (back-compat)
        },
        "raffle": {
            "round_minutes": ROUND_MIN,
            "duration_minutes": ROUND_MIN,
            "break_minutes": ROUND_BREAK,
            "splits": {"winner": SPLT_WIN, "dev": SPLT_DEV, "burn": SPLT_BURN},
            "ticket_price": settings.TICKET_PRICE,  # <— added here for frontend
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
        "opens_at": _rfc3339(o_dt) if rid and opens_at else None,
        "closes_at": _rfc3339(c_dt) if rid and closes_at else None,
        "next_opens_at": _rfc3339(n_dt) if rid and closes_at else None,
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

# NEW: debug exactly what RPC URL this process is using
@app.get(f"{API}/health/rpc", include_in_schema=False)
async def health_rpc():
    try:
        async with AsyncClient(RPC_URL) as c:
            slot_resp = await c.get_slot()
            slot_val = getattr(slot_resp, "value", None)
            if slot_val is None and isinstance(slot_resp, dict):
                slot_val = slot_resp.get("result")
        return {"ok": True, "rpc_url": RPC_URL, "slot": int(slot_val)}
    except Exception as e:
        return {"ok": False, "rpc_url": RPC_URL, "error": str(e)}

@app.get(f"{API}/health/atas", include_in_schema=False)
async def health_atas():
    gv = getattr(settings, "GAME_VAULT_ATA", "")
    jv = getattr(settings, "JACKPOT_VAULT_ATA", "")
    gb = await _rpc_get_token_balance(gv) if gv else None
    jb = await _rpc_get_token_balance(jv) if jv else None
    return {
        "game_vault_ata": gv or None,
        "jackpot_vault_ata": jv or None,
        "game_vault_balance": gb,
        "jackpot_vault_balance": jb,
    }

# Raffle credit for a wallet (base units)
@app.get(f"{API}/credits/{{wallet}}", response_model=CreditResp)
async def get_credits(wallet: str) -> CreditResp:
    val = await dbmod.kv_get(app.state.db, f"raffle_credit:{wallet}")
    return CreditResp(wallet=wallet, credit=int(val or 0))

# Entries for a round (paginated)
@app.get(f"{API}/rounds/{{round_id}}/entries", response_model=list[EntryResp])
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

        game_vault_owner    = (settings.GAME_VAULT or "").lower()
        jackpot_vault_owner = (settings.JACKPOT_VAULT or "").lower()
        game_vault_ata      = (settings.GAME_VAULT_ATA or "").lower()
        jackpot_vault_ata   = (settings.JACKPOT_VAULT_ATA or "").lower()

        def _to_matches(dest: str, ata: str, owner: str) -> bool:
            d = (dest or "").lower()
            return d == (ata or "") or d == (owner or "")
            
        # ---------------- Coin flip deposits ----------------
        if memo.startswith("BET:") and _to_matches(to_addr, game_vault_ata, game_vault_owner):
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
        if memo.startswith("JP:") and _to_matches(to_addr, jackpot_vault_ata, jackpot_vault_owner) and amt > 0:
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
    # <-- make sure this return is indented to the same level as 'for ev in events:' (inside the function, outside the loop)
    return {"ok": True}

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

    # External entropy = blockhash at finalize_slot; robust fallback with slot correction
    entropy: Optional[str] = None
    effective_slot: Optional[int] = None

    if finalize_slot:
        try:
            entropy, effective_slot = await _rpc_get_blockhash_fallback(finalize_slot)
        except Exception:
            entropy, effective_slot = None, None

    if not entropy:
        # final fallback — use newest entry tx or random token
        async with app.state.db.execute(
            "SELECT tx_sig FROM entries WHERE round_id=? ORDER BY id DESC LIMIT 1",
            (rid,)
        ) as cur:
            last = await cur.fetchone()
        entropy = last[0] if last and last[0] else secrets.token_hex(16)
        # (finalize_slot remains whatever was stored previously)
    else:
        # We found a usable blockhash; if it wasn't the planned slot, persist the slot we actually used
        if effective_slot is not None and effective_slot != finalize_slot:
            try:
                await app.state.db.execute(
                    "UPDATE rounds SET finalize_slot=? WHERE id=?",
                    (effective_slot, rid)
                )
                finalize_slot = effective_slot
                await app.state.db.commit()  # ensure slot change is durable
            except Exception:
                traceback.print_exc()

    # Persist fairness bits for the UI
    await dbmod.kv_set(app.state.db, f"round:{rid}:entropy", entropy)
    if finalize_slot:
        await dbmod.kv_set(app.state.db, f"round:{rid}:entropy_slot", str(finalize_slot))

    # Optional: trace which path we used
    try:
        print(f"[round_close] entropy={'blockhash' if effective_slot else 'fallback'} slot={finalize_slot}", flush=True)
    except Exception:
        pass

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
        try:
            await app.state.db.execute(
                "UPDATE rounds SET server_seed_reveal=? WHERE id=?",
                (round_server_seed, rid),
            )
        except Exception:
            print("[admin_close_round] failed UPDATE server_seed_reveal for round:", rid, "params:", (round_server_seed, rid), flush=True)
            traceback.print_exc()
            raise
        # ensure entropy is a plain string for SQLite
        entropy_str = _as_str_blockhash(entropy) if entropy is not None else None
        await dbmod.kv_set(app.state.db, f"round:{rid}:entropy", entropy_str or "")
        if finalize_slot:
            await dbmod.kv_set(app.state.db, f"round:{rid}:entropy_slot", str(finalize_slot))

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
    new_id = await alloc_next_round_id()
    # make new round times timezone-aware UTC
    now = datetime.now(timezone.utc) + timedelta(minutes=ROUND_BREAK)
    closes = now + timedelta(minutes=ROUND_MIN)

    new_round_srv = secrets.token_hex(32)
    await dbmod.kv_set(app.state.db, f"round:{new_id}:server_seed", new_round_srv)
    srv_hash = _hash(new_round_srv)

    curr_slot = await _rpc_get_slot()
    finalize_slot = curr_slot + (ROUND_MIN * SLOTS_PER_MIN)

    await app.state.db.execute(
        "INSERT INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,finalize_slot,pot) VALUES(?,?,?,?,?,?,?,?)",
        (new_id, "OPEN", _rfc3339(now), _rfc3339(closes), srv_hash, secrets.token_hex(8), finalize_slot, 0),
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
    """Backfill recent, SETTLED rounds for UI testing using sequential IDs."""
    now = datetime.now(timezone.utc)
    created = []
    for i in range(n):
        # allocate a sequential id rather than random to match production
        rid = await alloc_next_round_id()
        # spread in the past for visible ordering (timezone-aware UTC)
        opens_dt = (now - timedelta(minutes=(n - i) * 45)).isoformat()
        closes_dt = (now - timedelta(minutes=(n - i) * 45 - 30)).isoformat()
        pot = secrets.randbelow(4_000_000_000)  # up to ~4 SOL in lamports

        await app.state.db.execute(
            "INSERT OR REPLACE INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,pot) VALUES(?,?,?,?,?,?,?)",
            (rid, "SETTLED", opens_dt, closes_dt, _hash("seed:" + rid), secrets.token_hex(8), pot),
        )
        created.append(rid)

    await app.state.db.commit()
    return {"ok": True, "created": created}

@app.post(f"{API}/admin/round/reset_counter")
async def admin_reset_round_counter(value: int = 0, auth: bool = Depends(admin_guard)):
    """
    Reset the internal sequential round counter 'round:next_id' to the provided value.
    After calling with value=0 the next allocated id will be R0001.
    """
    try:
        v = int(value)
    except Exception:
        raise HTTPException(400, "value must be an integer")

    # Store the next number (we keep the stored value as the last allocated,
    # so alloc_next_round_id will add 1). To make next returned id be R0001,
    # set stored value to 0.
    await dbmod.kv_set(app.state.db, "round:next_id", str(v))
    return {"ok": True, "round:next_id": v}
