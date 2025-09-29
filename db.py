import aiosqlite
from typing import Any, Dict, List, Optional
from datetime import datetime

SCHEMA = """
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
CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  status TEXT,
  opens_at TEXT,
  closes_at TEXT,
  server_seed_hash TEXT,
  server_seed_reveal TEXT,
  client_seed TEXT,
  finalize_slot INTEGER,
  pot INTEGER,
  winner TEXT,
  payouts TEXT
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id TEXT,
  user TEXT,
  tickets INTEGER,
  tx_sig TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT,
  updated_at TEXT
);
"""

async def connect(db_path: str = "treatz.db"):
    conn = await aiosqlite.connect(db_path)
    await conn.executescript(SCHEMA)
    await conn.commit()
    return conn

async def kv_set(conn, k: str, v: str):
    now = datetime.utcnow().isoformat()
    await conn.execute("INSERT INTO kv(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at", (k, v, now))
    await conn.commit()

async def kv_get(conn, k: str) -> Optional[str]:
    async with conn.execute("SELECT v FROM kv WHERE k=?", (k,)) as cur:
        row = await cur.fetchone()
        return row[0] if row else None
