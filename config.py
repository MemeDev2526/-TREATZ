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
    RPC_URL: str = os.getenv("RPC_URL", "https://api.mainnet-beta.solana.com")
    
    # =========================================================
    # Vaults (public keys as strings)
    # =========================================================
    GAME_VAULT: str = os.getenv("GAME_VAULT", "BSeXqAhun3MprUAxBdNAGDHyJY1yssf1yZYKden8uoGg")
    JACKPOT_VAULT: str = os.getenv("JACKPOT_VAULT", "9MV8pJFPwLuwTZkJ7cg8pkeQdfGiLWXrkYt1M4FShLGU")
    GAME_VAULT_ATA: str = os.getenv("GAME_VAULT_ATA", "")
    JACKPOT_VAULT_ATA: str = os.getenv("JACKPOT_VAULT_ATA", "")
    GAME_VAULT_PK: Optional[str] = os.getenv("GAME_VAULT_PK")
    JACKPOT_VAULT_PK: Optional[str] = os.getenv("JACKPOT_VAULT_PK")

    # =========================================================
    # Token / Mint
    # =========================================================
    TREATZ_MINT: str = os.getenv("TREATZ_MINT", "")
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
    WEBHOOK_VERIFY_MODE = os.getenv("WEBHOOK_VERIFY_MODE")
    WEBHOOK_HEADER_NAME = os.getenv("WEBHOOK_HEADER_NAME")

    # =========================================================
    # Database
    # =========================================================
    DB_PATH: str = os.getenv("DB_PATH", "/data/treatz.db")

# Instantiate global settings (values resolved from environment)
settings = Settings()
