# db.py

"""
$TREATZ — db.py
Canonical schema + BOTH async (aiosqlite) and sync (sqlite3) helpers.
Target DB path: /data/treatz.db (Render disk)
"""

from __future__ import annotations
from typing import Optional
from datetime import datetime
from contextlib import contextmanager
import os
import sqlite3
import secrets
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
  id                 TEXT PRIMARY KEY,
  opens_at           TEXT NOT NULL,
  closes_at          TEXT NOT NULL,
  pot                INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'OPEN',
  client_seed        TEXT,
  server_seed_hash   TEXT,
  server_seed_reveal TEXT,
  finalize_slot      INTEGER,
  entropy            TEXT,
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
  user TEXT NOT NULL,
  tickets INTEGER NOT NULL,
  tx_sig TEXT,
  -- Use ISO 8601 with 'T' separator; API can append 'Z' as needed
  created_at TEXT DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%S','now')),
  FOREIGN KEY(round_id) REFERENCES rounds(id)
);

-- Wheel of Fate spins
CREATE TABLE IF NOT EXISTS spins(
  id TEXT PRIMARY KEY,
  user TEXT DEFAULT '',
  wager INTEGER NOT NULL,
  server_seed_hash TEXT NOT NULL,
  server_seed_reveal TEXT,
  client_seed TEXT NOT NULL,
  tx_sig TEXT,
  outcome_label TEXT,
  prize_amount INTEGER,
  free_spins INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_rounds_opens_at ON rounds(opens_at);
CREATE INDEX IF NOT EXISTS idx_entries_round   ON entries(round_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_txsig ON entries(tx_sig);
CREATE INDEX IF NOT EXISTS spins_user_created ON spins(user, created_at);

-- Extra helpful indexes for perf
CREATE INDEX IF NOT EXISTS idx_bets_created   ON bets(created_at);
CREATE INDEX IF NOT EXISTS idx_spins_created  ON spins(created_at);
CREATE INDEX IF NOT EXISTS idx_spins_status   ON spins(status);

-- keep schema forward-compatible across versions
-- (FIXED: give the temp table one dummy column)
CREATE TEMP TABLE IF NOT EXISTS _chk_guard (ok INTEGER);
""".strip()

# =========================================================
# Connection
# =========================================================
DB_PATH = os.getenv("DB_PATH", "/data/treatz.db")

async def connect(db_path: str = DB_PATH) -> aiosqlite.Connection:
    """
    Async connection for FastAPI handlers; ensures schema and sets PRAGMAs.
    """
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = await aiosqlite.connect(db_path)

    # Per-connection PRAGMAs to reduce locking and keep WAL fast
    await conn.execute("PRAGMA foreign_keys=ON")
    await conn.execute("PRAGMA journal_mode=WAL")
    await conn.execute("PRAGMA synchronous=NORMAL")
    await conn.execute("PRAGMA temp_store=MEMORY")
    await conn.execute("PRAGMA wal_autocheckpoint=1000")
    await conn.execute("PRAGMA busy_timeout=5000")

    # Use aiosqlite.Row for dict-like access
    conn.row_factory = aiosqlite.Row

    await conn.executescript(SCHEMA)
    await conn.commit()
    return conn

async def ensure_schema(conn: aiosqlite.Connection) -> None:
    """Apply canonical schema (idempotent)."""
    await conn.executescript(SCHEMA)
    await conn.commit()

# =========================================================
# KV Helpers (async)
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
    """
    Synchronous connection for scripts / payout code that prefer blocking I/O.
    """
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row

    # Per-connection PRAGMAs (mirror async)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA wal_autocheckpoint=1000")
    conn.execute("PRAGMA busy_timeout=5000")

    conn.executescript(SCHEMA)
    conn.commit()
    return conn

@contextmanager
def tx(conn: sqlite3.Connection):
    """
    Tiny transactional context manager for sync code.
    Usage:
        with tx(conn) as c:
            c.execute(...)
            c.execute(...)
    """
    try:
        conn.execute("BEGIN")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise

# -------------------------
# Sync KV helpers (mirror async kv_get / kv_set)
# -------------------------
def kv_set_sync(conn: sqlite3.Connection, k: str, v: str) -> None:
    """
    Upsert a key/value pair in the KV table (synchronous).
    """
    conn.execute(
        "INSERT INTO kv(k, v) VALUES(?, ?) "
        "ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        (k, v),
    )
    conn.commit()

def kv_get_sync(conn: sqlite3.Connection, k: str) -> Optional[str]:
    """
    Read a value from KV; return None if missing (synchronous).
    """
    cur = conn.execute("SELECT v FROM kv WHERE k=?", (k,))
    row = cur.fetchone()
    return row[0] if row else None

# -------------------------
# Sequential round id allocator (synchronous)
# -------------------------
def alloc_next_round_id_sync(conn: sqlite3.Connection) -> str:
    """
    Allocate a sequential round id of the form RNNNN using KV counter 'round:next_id'.
    Returns the new id (e.g. 'R0001').
    This is synchronous variant for use with connect_sync() users.
    """
    key = "round:next_id"
    cur = kv_get_sync(conn, key)
    try:
        n = int(cur or 0) + 1
    except Exception:
        n = 1
    kv_set_sync(conn, key, str(n))
    return f"R{n:04d}"

# -------------------------
# Create round (synchronous) — uses sequential allocator
# -------------------------
def create_round_sync(conn: sqlite3.Connection, opens_at: datetime, closes_at: datetime) -> str:
    """Create a new round row synchronously, returns new round ID (sequential)."""
    rid = alloc_next_round_id_sync(conn)
    client_seed = secrets.token_hex(8)
    conn.execute(
        "INSERT INTO rounds (id, status, opens_at, closes_at, pot, client_seed) VALUES (?, 'OPEN', ?, ?, 0, ?)",
        (rid, opens_at.isoformat(), closes_at.isoformat(), client_seed),
    )
    conn.commit()
    return rid

# -------------------------
# Mark round closed (synchronous) — align with main.py which sets SETTLED
# -------------------------
def mark_round_closed_sync(conn: sqlite3.Connection, round_id: str) -> None:
    """Mark a round SETTLED synchronously."""
    conn.execute("UPDATE rounds SET status='SETTLED' WHERE id=?", (round_id,))
    conn.commit()

def reset_round_counter_sync(conn: sqlite3.Connection, value: int = 0) -> None:
    """
    Reset internal 'round:next_id' counter. Setting to 0 means next allocated id will be R0001.
    """
    kv_set_sync(conn, "round:next_id", str(int(value)))