"""
$TREATZ — db.py
Lightweight aiosqlite helpers + canonical schema (kept in sync with main.py/init_db.py)
"""

from __future__ import annotations

from typing import Optional
from datetime import datetime, timedelta
import aiosqlite


# =========================================================
# Canonical Schema  (match main.py / init_db.py)
# =========================================================
SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,         -- OPEN | SETTLED
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  server_seed_hash TEXT,
  client_seed TEXT,
  pot INTEGER DEFAULT 0         -- smallest units (lamports if SOL)
);

CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY,
  user TEXT,
  client_seed TEXT,
  server_seed_hash TEXT,
  server_seed_reveal TEXT,
  wager INTEGER,                -- smallest units
  side TEXT,                    -- TRICK | TREAT
  result TEXT,                  -- TRICK | TREAT
  win INTEGER,                  -- 1 | 0
  status TEXT,                  -- PENDING | SETTLED
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
# Connection
# =========================================================
async def connect(db_path: str = "treatz.db") -> aiosqlite.Connection:
    """
    Open a connection, ensure schema, and return the connection.
    """
    conn = await aiosqlite.connect(db_path)
    await conn.executescript(SCHEMA)
    await conn.commit()
    return conn


# =========================================================
# KV Helpers
# =========================================================
async def kv_set(conn: aiosqlite.Connection, k: str, v: str) -> None:
    """
    Upsert a key/value pair in the KV table.
    """
    await conn.execute(
        "INSERT INTO kv(k, v) VALUES(?, ?) "
        "ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        (k, v),
    )
    await conn.commit()


async def kv_get(conn: aiosqlite.Connection, k: str) -> Optional[str]:
    """
    Read a value from KV; return None if missing.
    """
    async with conn.execute("SELECT v FROM kv WHERE k=?", (k,)) as cur:
        row = await cur.fetchone()
        return row[0] if row else None
        
def create_round(conn, opens_at: datetime, closes_at: datetime):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO rounds (opens_at, closes_at, pot, status) VALUES (?, ?, ?, ?)",
        (opens_at.isoformat(), closes_at.isoformat(), 0, "OPEN"),
    )
    conn.commit()
    rid = cur.lastrowid
    return f"R{rid}"

def mark_round_closed(conn, round_id: str):
    cur = conn.cursor()
    cur.execute("UPDATE rounds SET status = ? WHERE id = ?", ("CLOSED", round_id.lstrip("R")))
    conn.commit()
