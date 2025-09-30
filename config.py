"""
$TREATZ — Config
Centralized environment + constants, powered by pydantic-settings.
"""
import os
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # =========================================================
    # API
    # =========================================================
    API_PREFIX: str = "/api"

    # =========================================================
    # Vaults (public keys as strings)
    # =========================================================
    GAME_VAULT: str = "GAME_VAULT_PUBLIC_KEY_HERE"
    JACKPOT_VAULT: str = "JACKPOT_VAULT_PUBLIC_KEY_HERE"

    # Token mint for $TREATZ (string). For SOL-only MVP, leave empty.
    TREATZ_MINT: str = ""

    # =========================================================
    # Economics
    # =========================================================
    EDGE_BPS: int     = 150    # 1.5% house edge for coin flip
    BURN_BPS: int     = 1000   # 10% burn (basis points)
    TREASURY_BPS: int = 1000   # 10% treasury
    WINNER_BPS: int   = 8000   # 80% to jackpot winner

    # Price per raffle ticket (in smallest units; 1e6 = 0.000001 SOL if using lamports)
    TICKET_PRICE: int = 1_000_000

    # =========================================================
    # Secrets
    # =========================================================
    # Provably-fair secret; rotate periodically
    HMAC_SECRET: str = "CHANGE_THIS_SECRET"

    # Helius webhook signature header (optional, to verify origin)
    HELIUS_SIGNATURE_HEADER: str = ""

    # =========================================================
    # Database
    # =========================================================
    DB_PATH: str = "treatz.db"

    # =========================================================
    # Model Config
    # =========================================================
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


# Instantiate global settings
settings = Settings()
