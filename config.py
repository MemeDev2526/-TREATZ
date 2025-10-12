#config.py
"""
$TREATZ — Config
Centralized environment + constants, powered by pydantic-settings.
"""
import os
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    # let pydantic also read from your .env if present (optional)
    model_config = SettingsConfigDict(
        env_file=".TREATZ.env",  # or ".env" if that’s what you use on Render
        env_prefix="",
        extra="ignore",
    )

    # =========================================================
    # API
    # =========================================================
    API_PREFIX: str = "/api"

    # =========================================================
    # RPC / Admin
    # =========================================================
    RPC_URL: str = os.getenv("RPC_URL", "https://mainnet.helius-rpc.com/?api-key=3b97cb2d-4eff-4bd3-a17f-f5d157a686a5")
    
    # =========================================================
    # Vaults (public keys as strings)
    # =========================================================
    GAME_VAULT: str = os.getenv("GAME_VAULT", "5nRWo11VPGj8Ge67ntN5cAYPHxU6xfaFwrmH9ogdzuqf")
    JACKPOT_VAULT: str = os.getenv("JACKPOT_VAULT", "AQtwNnM727GZFB9VwqXdd3uXi1K7N7wrd14giRgEWN71")
    WHEEL_VAULT: str = os.getenv("WHEEL_VAULT", "")
    GAME_VAULT_ATA: str = os.getenv("GAME_VAULT_ATA", "9vNPiCTRRJzb8pgERfxoYL2JybviL89q9966vrUN1hEp")
    JACKPOT_VAULT_ATA: str = os.getenv("JACKPOT_VAULT_ATA", "6MFMMdqTDZ4rCxmsRAq8mtTYLfV3huoG1SvSKXiqAdGH")
    WHEEL_VAULT_ATA: str = os.getenv("WHEEL_VAULT_ATA", "")
    GAME_VAULT_PK: Optional[str] = os.getenv("GAME_VAULT_PK")
    JACKPOT_VAULT_PK: Optional[str] = os.getenv("JACKPOT_VAULT_PK")
    WHEEL_VAULT_PK: Optional[str] = os.getenv("WHEEL_VAULT_PK")
    
    # =========================================================
    # Token / Mint
    # =========================================================
    TREATZ_MINT: str = os.getenv("TREATZ_MINT", "DqABdJvc7pELo4Qf9UbxcvNuf9CVQkKzSMtWdiWcpump")
    TOKEN_DECIMALS: int = int(os.getenv("TOKEN_DECIMALS", "6"))

    # =========================================================
    # Economics
    # =========================================================
    EDGE_BPS: int = 150
    WIN_AMOUNT: int = 2
    TICKET_PRICE: int = int(os.getenv("TICKET_PRICE", "1000000"))
    SPLT_BURN: int = int(os.getenv("SPLT_BURN", "10"))
    SPLT_DEV: int = int(os.getenv("SPLT_DEV", "10"))
    SPLT_WINNER: int = int(os.getenv("SPLT_WINNER", "80"))
     # Wheel of Fate: price per spin (expressed in whole $TREATZ; converted to base units in backend)
    WHEEL_SPIN_PRICE: int = int(os.getenv("WHEEL_SPIN_PRICE", "100000"))
    # =========================================================
    # Game Logic
    # =========================================================
    ROUND_BREAK: int = int(os.getenv("ROUND_BREAK", "2"))
    ROUND_MIN: int = int(os.getenv("ROUND_MIN", "2"))
    SLOTS_PER_MIN: int = 150

    # =========================================================
    # Wallets
    # =========================================================
    BURN_ADDRESS: str = os.getenv("BURN_ADDRESS", "1nc1nerator11111111111111111111111111111111")
    DEV_WALLET: str = os.getenv("DEV_WALLET", "2RXHVnWajJrUzzuH3n8jbn7Xbk6Pyjo9aycmjTA2TjGu")

    # =========================================================
    # Secrets
    # =========================================================
    HMAC_SECRET: Optional[str] = os.getenv("HMAC_SECRET")
    HELIUS_SIGNATURE_HEADER: Optional[str] = os.getenv("HELIUS_SIGNATURE_HEADER")
    HELIUS_WEBHOOK_URL: Optional[str] = os.getenv("HELIUS_WEBHOOK_URL")  # where Helius POSTs
    ADMIN_TOKEN: Optional[str] = os.getenv("ADMIN_TOKEN")
    WEBHOOK_SHARED_SECRET: Optional[str] = os.getenv("WEBHOOK_SHARED_SECRET")  # or = None
    WEBHOOK_VERIFY_MODE: str = os.getenv('WEBHOOK_VERIFY_MODE', 'header')
    WEBHOOK_HEADER_NAME: str = os.getenv('WEBHOOK_HEADER_NAME', 'X-Helius-Auth')

    # =========================================================
    # Database
    # =========================================================
    DB_PATH: str = os.getenv("DB_PATH", "/data/treatz.db")

# Instantiate global settings (values resolved from environment)
settings = Settings()

# Normalize TICKET_PRICE to base units if env was given in whole tokens
try:
    dec = int(getattr(settings, "TOKEN_DECIMALS", 6))
    if settings.TICKET_PRICE and settings.TICKET_PRICE < (10 ** dec):
        settings.TICKET_PRICE = settings.TICKET_PRICE * (10 ** dec)
except Exception:
    pass
