from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    API_PREFIX: str = "/api"
    # Public SPL or SOL vaults (public keys as strings)
    GAME_VAULT: str = "GAME_VAULT_PUBLIC_KEY_HERE"
    JACKPOT_VAULT: str = "JACKPOT_VAULT_PUBLIC_KEY_HERE"

    # Token mint for $TREATZ (string). For SOL-only MVP, leave empty.
    TREATZ_MINT: str = ""

    # Economics
    EDGE_BPS: int = 150           # 1.5% house edge for coin flip
    BURN_BPS: int = 1000          # 10% for jackpot/losers (in basis points)
    TREASURY_BPS: int = 1000      # 10%
    WINNER_BPS: int = 8000        # 80% to winner in jackpot

    TICKET_PRICE: int = 1000000   # 1e6 base units (your token's smallest unit); adjust.

    # Provably-fair secret; rotate periodically
    HMAC_SECRET: str = "CHANGE_THIS_SECRET"

    # Helius webhook secret (optional, to verify origin)
    HELIUS_SIGNATURE_HEADER: str = ""

    # SQLite path
    DB_PATH: str = "treatz.db"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

settings = Settings()
