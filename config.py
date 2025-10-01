"""
$TREATZ — Config
Centralized environment + constants, powered by pydantic-settings.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # =========================================================
    # API
    # =========================================================
    API_PREFIX: str = "/api"

    # =========================================================
    # RPC / Admin
    # =========================================================
    RPC_URL: str = "https://api.mainnet-beta.solana.com"
    ADMIN_TOKEN: str = ""

    # =========================================================
    # Vaults (public keys as strings)
    # =========================================================
    GAME_VAULT: str = "GAME_VAULT_PUBLIC_KEY_HERE"
    JACKPOT_VAULT: str = "JACKPOT_VAULT_PUBLIC_KEY_HERE"
    # Optional: precomputed ATAs (lets the UI send SPL directly)
    GAME_VAULT_ATA: str = ""
    JACKPOT_VAULT_ATA: str = ""
    # Private keys (base58 64-byte) for server-side payouts
    GAME_VAULT_PK: str = ""
    JACKPOT_VAULT_PK: str = ""

    # =========================================================
    # Token / Mint
    # =========================================================
    TREATZ_MINT: str = ""     # empty for SOL-only MVP
    TOKEN_DECIMALS: int = 6   # shared default across app + payouts

    # =========================================================
    # Economics
    # =========================================================
    EDGE_BPS: int = 150                     # coinflip house edge (bps)
    WIN_AMOUNT: int = 2                     # coinflip win multiplier (2x)
    TICKET_PRICE: int = 1_000_000           # smallest units
    SPLT_BURN: int = 10                     # raffle split (%)
    SPLT_DEV: int = 10                      # raffle split (%)
    SPLT_WINNER: int = 80                   # raffle split (%)

    # =========================================================
    # Game Logic
    # =========================================================
    ROUND_BREAK: int = 2   # minutes between draw close and next open
    ROUND_MIN: int = 2     # minutes per raffle round

    # =========================================================
    # Wallets
    # =========================================================
    BURN_ADDRESS: str = "1nc1nerator11111111111111111111111111111111"
    DEV_WALLET: str = "2RXHVnWajJrUzzuH3n8jbn7Xbk6Pyjo9aycmjTA2TjGu"

    # =========================================================
    # Secrets
    # =========================================================
    HMAC_SECRET: str = "CHANGE_THIS_SECRET"
    HELIUS_SIGNATURE_HEADER: str = ""

    # =========================================================
    # Database
    # =========================================================
    DB_PATH: str = "/data/treatz.db"  # Render disk default

    # =========================================================
    # Model Config
    # =========================================================
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


# Instantiate global settings
settings = Settings()
