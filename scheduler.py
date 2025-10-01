# scheduler.py
import os
import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone
from payouts import settle_and_payout

# --- ENV (read directly here, per your preference) ---
ROUND_MIN = int(os.getenv("ROUND_MIN", 30))
ROUND_BREAK = int(os.getenv("ROUND_BREAK", 0))

# SQLite location (adjust if you store elsewhere)
DB_PATH = os.getenv("DATABASE_URL", "/data/treatz.db")

# --- Minimal DB helpers (scheduler-only) ---
def get_conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # Ensure table exists (lightweight migration)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS rounds (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          opens_at   TEXT NOT NULL,
          closes_at  TEXT NOT NULL,
          pot        INTEGER NOT NULL DEFAULT 0,
          status     TEXT NOT NULL DEFAULT 'OPEN'
        )
    """)
    return conn

def create_round(conn, opens_at: datetime, closes_at: datetime) -> str:
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO rounds (opens_at, closes_at, pot, status) VALUES (?, ?, ?, ?)",
        (opens_at.isoformat(), closes_at.isoformat(), 0, "OPEN"),
    )
    conn.commit()
    rid = cur.lastrowid
    return f"R{rid}"

def mark_round_closed(conn, round_id: str) -> None:
    rid = int(str(round_id).lstrip("R"))
    conn.execute("UPDATE rounds SET status = ? WHERE id = ?", ("CLOSED", rid))
    conn.commit()
    
async def raffle_loop():
    while True:
        try:
            conn = get_conn()

            now = datetime.now(timezone.utc)
            opens_at = now
            closes_at = now + timedelta(minutes=ROUND_MIN)
            round_id = create_round(conn, opens_at, closes_at)
            print(f"[RAFFLE] Opened {round_id} {opens_at} → {closes_at}")

            while datetime.now(timezone.utc) < closes_at:
                await asyncio.sleep(5)

            mark_round_closed(conn, round_id)
            print(f"[RAFFLE] Closing {round_id} — settling")

            try:
                result = settle_and_payout(conn, round_id)
                print(f"[RAFFLE] {round_id} winner {result.get('winner')} pot {result.get('pot')}")
            except Exception as e:
                print(f"[RAFFLE] payout error {e}")

            await asyncio.sleep(max(0, ROUND_BREAK * 60))
        except Exception as e:
            print(f"[RAFFLE] loop error {e}")
            await asyncio.sleep(5)

