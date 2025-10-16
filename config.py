# config.py
"""
$TREATZ — Config
Centralized environment + constants, powered by pydantic-settings (Pydantic v2).
"""

from __future__ import annotations
from typing import Optional, List
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator

class Settings(BaseSettings):
    # pydantic-settings config
    model_config = SettingsConfigDict(
        env_file=".TREATZ.env",   # change to ".env" if preferred
        env_prefix="",            # read raw names (e.g., RPC_URL)
        extra="ignore",
        case_sensitive=False,
    )

    # =========================
    # App / API
    # =========================
    API_PREFIX: str = "/api"
    DEBUG: bool = False

    # normalize API_PREFIX (no trailing slash; always starts with '/')
    @field_validator("API_PREFIX")
    @classmethod
    def _norm_api_prefix(cls, v: str) -> str:
        v = (v or "/api").strip()
        if not v.startswith("/"):
            v = "/" + v
        if v != "/" and v.endswith("/"):
            v = v[:-1]
        return v

    # =========================
    # CORS (optional)
    # =========================
    CORS_ORIGINS: List[str] = [
        "https://trickortreatsol.tech",
        "https://memedev2526.github.io",
        "https://memedev2526.github.io/-TREATZ",
        "https://treatz-de1d.onrender.com",
        "http://localhost:5173",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ]

    # =========================
    # RPC / Admin
    # =========================
    # Avoid shipping real keys by default; require env to override
    RPC_URL: str = "https://mainnet.helius-rpc.com/?api-key=REPLACE_ME"
    ADMIN_TOKEN: Optional[str] = None

    # =========================
    # Vaults (public keys as strings)
    # =========================
    GAME_VAULT: str = "5nRWo11VPGj8Ge67ntN5cAYPHxU6xfaFwrmH9ogdzuqf"
    JACKPOT_VAULT: str = "AQtwNnM727GZFB9VwqXdd3uXi1K7N7wrd14giRgEWN71"
    WHEEL_VAULT: str = ""

    GAME_VAULT_ATA: str = "9vNPiCTRRJzb8pgERfxoYL2JybviL89q9966vrUN1hEp"
    JACKPOT_VAULT_ATA: str = "6MFMMdqTDZ4rCxmsRAq8mtTYLfV3huoG1SvSKXiqAdGH"
    WHEEL_VAULT_ATA: str = ""

    # Base58-encoded secret keys (64b or 32b seed) — MUST be set in env for payouts
    GAME_VAULT_PK: Optional[str] = None
    JACKPOT_VAULT_PK: Optional[str] = None
    WHEEL_VAULT_PK: Optional[str] = None

    # =========================
    # Token / Mint
    # =========================
    TREATZ_MINT: str = "DqABdJvc7pELo4Qf9UbxcvNuf9CVQkKzSMtWdiWcpump"
    TOKEN_DECIMALS: int = 6

    # =========================
    # Economics
    # =========================
    EDGE_BPS: int = 150                 # house edge basis points (if used later)
    WIN_AMOUNT: int = 2                 # coinflip multiplier
    TICKET_PRICE: int = 1_000_000       # base units by default (see normalizer below)

    # Wheel of Fate: price per spin (WHOLE tokens; converted when used)
    WHEEL_SPIN_PRICE: int = 100_000

    # =========================
    # Game Logic
    # =========================
    ROUND_BREAK: int = 2
    ROUND_MIN: int = 2
    # Note: your code currently uses a local constant; keeping here for reference
    SLOTS_PER_MIN: int = 150

    # =========================
    # Wallets (dev/burn)
    # =========================
    BURN_ADDRESS: str = "1nc1nerator11111111111111111111111111111111"
    DEV_WALLET: str = "2RXHVnWajJrUzzuH3n8jbn7Xbk6Pyjo9aycmjTA2TjGu"

    # =========================
    # Secrets / Webhooks
    # =========================
    HMAC_SECRET: Optional[str] = os.getenv("HMAC_SECRET")  # optional, only for HMAC mode                # used to sign/verify webhooks
    HELIUS_SIGNATURE_HEADER: Optional[str] = os.getenv("HELIUS_SIGNATURE_HEADER")
    HELIUS_WEBHOOK_URL: Optional[str] = None         # where Helius POSTs (informational)
    WEBHOOK_SHARED_SECRET: Optional[str] = os.getenv("WEBHOOK_SHARED_SECRET")
    WEBHOOK_VERIFY_MODE: str = "header"              # "header"|"body" (future use)
    WEBHOOK_HEADER_NAME: str = "X-Helius-Auth"
    ALLOW_UNSIGNED_HELIUS: bool = os.getenv("ALLOW_UNSIGNED_HELIUS", "false").lower() in ("1","true","yes")

    # =========================
    # Database
    # =========================
    DB_PATH: str = "/data/treatz.db"

    # -------------------------
    # Derived helpers
    # -------------------------
    @property
    def ticket_price_base(self) -> int:
        """Ticket price in base units (already normalized)."""
        return int(self.TICKET_PRICE)

    @property
    def spin_price_base(self) -> int:
        """Wheel spin price in base units."""
        return int(self.WHEEL_SPIN_PRICE) * (10 ** int(self.TOKEN_DECIMALS))

# Instantiate global settings (values resolved from environment)
settings = Settings()

# Normalize TICKET_PRICE to base units if someone set it in whole tokens by mistake.
try:
    dec = int(getattr(settings, "TOKEN_DECIMALS", 6))
    # Heuristic: if TICKET_PRICE < 10^dec, treat it as whole tokens and convert.
    if settings.TICKET_PRICE and int(settings.TICKET_PRICE) < (10 ** dec):
        settings.TICKET_PRICE = int(settings.TICKET_PRICE) * (10 ** dec)
except Exception:
    # leave as-is if anything goes wrong
    pass
