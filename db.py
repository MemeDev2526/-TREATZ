"""
$TREATZ — db.py
Canonical schema + BOTH async (aiosqlite) and sync (sqlite3) helpers.
Target DB path: /data/treatz.db (Render disk)
"""

from __future__ import annotations
from typing import Optional
from datetime import datetime
import os, sqlite3, secrets
import aiosqlite

# =========================================================
# Canonical Schema
# =========================================================
SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- Rounds table: TEXT id like 'R0123'
CREATE TABLE IF NOT EXISTS rounds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  opens_at     TEXT NOT NULL,
  closes_at    TEXT NOT NULL,
  pot          INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'open',
  client_seed  TEXT

  -- fairness / outcome
  server_seed_hash   TEXT,
  server_seed_reveal TEXT,
  finalize_slot      INTEGER,
  entropy            TEXT,

  -- optional outcome storage (history convenience)
  winner             TEXT,
  payout_sig         TEXT
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
CREATE INDEX IF NOT EXISTS idx_entries_round   ON entries(round_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_txsig ON entries(tx_sig);
""".strip()

# =========================================================
# Connection
# =========================================================
DB_PATH = os.getenv("DB_PATH", "/data/treatz.db")

async def connect(db_path: str = DB_PATH) -> aiosqlite.Connection:
    """
    Async connection for FastAPI handlers; ensures schema.
    """
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = await aiosqlite.connect(db_path)
    await conn.executescript(SCHEMA)
    await conn.commit()
    return conn

async def ensure_schema(conn: aiosqlite.Connection) -> None:
    """Apply canonical schema (idempotent)."""
    await conn.executescript(SCHEMA)
    await conn.commit()

# =========================================================
# KV Helpers
# =========================================================
async def kv_set(conn: aiosqlite.Connection, k: str, v: str, commit: bool = True) -> None:
    """
    Upsert a key/value pair in the KV table.
    """
    await conn.execute(
        "INSERT INTO kv(k, v) VALUES(?, ?) "
        "ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        (k, v),
    )
    if commit:
        await conn.commit()

async def kv_get(conn: aiosqlite.Connection, k: str) -> Optional[str]:
    """
    Read a value from KV; return None if missing.
    """
    async with conn.execute("SELECT v FROM kv WHERE k=?", (k,)) as cur:
        row = await cur.fetchone()
        return row[0] if row else None

# =========================================================
# Sync helpers for scheduler/payouts
# =========================================================
def connect_sync(db_path: str = DB_PATH) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.commit()
    return conn

def create_round_sync(conn: sqlite3.Connection, opens_at: datetime, closes_at: datetime) -> str:
    """Create a new round row synchronously, returns new round ID."""
    rid = f"R{secrets.randbelow(10_000):04d}"  # e.g. R0042
    conn.execute(
        "INSERT INTO rounds (opens_at, closes_at, pot, status, client_seed) VALUES (?, ?, 0, 'open', ?)",
        (opens_at.isoformat(), closes_at.isoformat(), client_seed),
      )
    conn.commit()
    return rid

def mark_round_closed_sync(conn: sqlite3.Connection, round_id: str) -> None:
    """Mark a round CLOSED synchronously."""
    conn.execute("UPDATE rounds SET status='CLOSED' WHERE id=?", (round_id,))
    conn.commit()
