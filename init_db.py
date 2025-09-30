"""
$TREATZ — init_db.py
One-shot initializer for the SQLite database:
- Ensures schema (PRAGMA + tables + indexes)
- Creates an OPEN "current round" if none exists
"""

import os
import asyncio
import secrets
import hashlib
from datetime import datetime, timedelta

import aiosqlite
from config import settings  # keeps DB path consistent with app


# =========================================================
# Config
# =========================================================
DB_PATH = os.getenv("DB_PATH", settings.DB_PATH)

DDL = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,                 -- OPEN | SETTLED
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  server_seed_hash TEXT,
  client_seed TEXT,
  pot INTEGER DEFAULT 0                 -- smallest units (lamports if SOL)
);

CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY,
  user TEXT,
  client_seed TEXT,
  server_seed_hash TEXT,
  server_seed_reveal TEXT,
  wager INTEGER,                        -- smallest units
  side TEXT,                            -- TRICK | TREAT
  result TEXT,                          -- TRICK | TREAT
  win INTEGER,                          -- 1 | 0
  status TEXT,                          -- PENDING | SETTLED
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
CREATE INDEX IF NOT EXISTS idx_entries_round   ON entries(round_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_txsig ON entries(tx_sig);
""".strip()


# =========================================================
# Helpers
# =========================================================
def _hash(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


async def ensure_current_round(db: aiosqlite.Connection) -> None:
    cur = await db.execute("SELECT v FROM kv WHERE k='current_round_id'")
    row = await cur.fetchone()
    await cur.close()

    if row:
        print(f"Current round exists: {row[0]}")
        return

    rid = f"R{secrets.randbelow(10_000):04d}"
    opens = datetime.utcnow()
    closes = opens + timedelta(minutes=30)

    await db.execute(
        "INSERT INTO rounds(id,status,opens_at,closes_at,server_seed_hash,client_seed,pot) "
        "VALUES(?,?,?,?,?,?,?)",
        (rid, "OPEN", opens.isoformat(), closes.isoformat(), _hash("seed:" + rid), secrets.token_hex(8), 0),
    )
    await db.execute("INSERT INTO kv(k,v) VALUES('current_round_id',?)", (rid,))
    await db.commit()
    print(f"Initialized first round: {rid}")


# =========================================================
# Main
# =========================================================
async def main():
    print(f"Using DB_PATH={DB_PATH}")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(DDL)
        await ensure_current_round(db)


if __name__ == "__main__":
    asyncio.run(main())
