from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from config import settings
import db as dbmod

app = FastAPI(title="$TREATZ Backend", version="0.1.0")

# CORS — add your Pages domain, localhost for dev, etc.
app.add_middleware(
    CORSMiddleware,
allow_origins=[
    "https://trickortreatsol.tech",                 # if/when you point the site here
    "https://memedev2526.github.io",                # user pages root (good to allow)
    "https://memedev2526.github.io/-TREATZ",        # your project pages path
    "http://localhost:5173",                        # Vite dev
    "http://127.0.0.1:8000",
    "http://localhost:8000",
],


    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API = settings.API_PREFIX

@app.on_event("startup")
async def on_startup():
    app.state.db = await dbmod.connect(settings.DB_PATH)
    # Ensure a current round exists
    if not await dbmod.kv_get(app.state.db, "current_round_id"):
        rid = f"R{secrets.randbelow(10_000):04d}"
        closes = datetime.utcnow() + timedelta(minutes=30)
        await app.state.db.execute(
            "INSERT INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,pot) VALUES(?,?,?,?,?,?,?)",
            (rid, "OPEN", datetime.utcnow().isoformat(), closes.isoformat(), _hash("seed:"+rid), secrets.token_hex(8), 0)
        )
        await app.state.db.commit()
        await dbmod.kv_set(app.state.db, "current_round_id", rid)

@app.get(f"{API}/health")
async def health():
    return {"ok": True, "ts": time.time()}

# ---------- Models ----------
class NewBet(BaseModel):
    amount: int = Field(ge=1, description="Amount in smallest units (e.g., lamports for SOL)")
    side: Literal["TRICK", "TREAT"]

class BetResp(BaseModel):
    bet_id: str
    server_seed_hash: str
    deposit: str
    memo: str

def _hash(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()

def _hmac(secret: str, msg: str) -> bytes:
    return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).digest()

# ---------- Endpoints ----------
@app.post(f"{API}/bets", response_model=BetResp)
async def create_bet(body: NewBet):
    # In MVP we just return deposit + memo; settlement occurs via webhook
    bet_id = secrets.token_hex(6)
    server_seed = secrets.token_hex(32)
    server_seed_hash = _hash(server_seed)

    await app.state.db.execute(
        "INSERT INTO bets(id, user, client_seed, server_seed_hash, server_seed_reveal, wager, side, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (bet_id, "", secrets.token_hex(8), server_seed_hash, None, body.amount, body.side, "PENDING", datetime.utcnow().isoformat())
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
            "pot": row[4],
        }

@app.get(f"{API}/rounds/recent")
async def rounds_recent(limit: int = 10):
    async with app.state.db.execute("SELECT id, pot FROM rounds ORDER BY opens_at DESC LIMIT ?", (limit,)) as cur:
        rows = await cur.fetchall()
        return [{"id": r[0], "pot": r[1]} for r in rows]

# ---------- Helius Webhook (simplified) ----------
# Expecting Helius 'enhanced' transaction webhook with token transfers & memos
@app.post(f"{API}/webhook/helius")
async def helius_webhook(request: Request):
    # (Optional) Verify signature header if configured
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")

    # Handle a list of events or single event
    events = payload if isinstance(payload, list) else [payload]

    for ev in events:
        # extract memo and basic info (simplified; adapt to your Helius shape)
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
            # Resolve with HMAC
            server_seed_hash = None
            async with app.state.db.execute("SELECT server_seed_hash, wager FROM bets WHERE id=?", (bet_id,)) as cur:
                row = await cur.fetchone()
                if not row: continue
                server_seed_hash, wager = row
            # In MVP we don't store the secret; we derive a pseudo 'reveal' from bet_id (swap to real secret in production)
            server_seed_reveal = "reveal_" + bet_id
            result = "TREAT" if (int.from_bytes(_hmac(settings.HMAC_SECRET, server_seed_reveal + tx_sig), "big") % 2) else "TRICK"
            win = int(result == choice)
            status = "SETTLED"
            await app.state.db.execute(
                "UPDATE bets SET result=?, win=?, status=?, server_seed_reveal=?, tx_sig=?, settled_at=? WHERE id=?",
                (result, win, status, server_seed_reveal, tx_sig, datetime.utcnow().isoformat(), bet_id)
            )
            await app.state.db.commit()

        # Jackpot entries
        if memo.startswith("JP:") and to_addr == jackpot_vault and amt > 0:
            parts = memo.split(":")
            if len(parts) >= 2:
                round_id = parts[1]
            else:
                rid = await dbmod.kv_get(app.state.db, "current_round_id")
                round_id = rid
            tickets = max(1, amt // settings.TICKET_PRICE)
            await app.state.db.execute(
                "INSERT INTO entries(round_id,user,tickets,tx_sig) VALUES(?,?,?,?)",
                (round_id, sender, tickets, tx_sig)
            )
            # Keep pot in lamports (INTEGER). Frontend converts to SOL.
            await app.state.db.execute(
                "UPDATE rounds SET pot = COALESCE(pot,0) + ? WHERE id=?",
                (amt, round_id)
            )
            await app.state.db.commit()


    return {"ok": True}

# ---------- Dev helper ----------
@app.post(f"{API}/admin/round/close")
async def admin_close_round():
    rid = await dbmod.kv_get(app.state.db, "current_round_id")
    # Roll to next round (no real draw here; add fairness later)
    new_id = f"R{secrets.randbelow(10_000):04d}"
    closes = datetime.utcnow() + timedelta(minutes=30)
    await app.state.db.execute("UPDATE rounds SET status='SETTLED' WHERE id=?", (rid,))
    await app.state.db.execute(
        "INSERT INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,pot) VALUES(?,?,?,?,?,?,?)",
        (new_id, "OPEN", datetime.utcnow().isoformat(), closes.isoformat(), _hash('seed:'+new_id), secrets.token_hex(8), 0)
    )
    await app.state.db.commit()
    await dbmod.kv_set(app.state.db, "current_round_id", new_id)
    return {"ok": True, "new_round": new_id}
