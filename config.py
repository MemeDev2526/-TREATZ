"""
$TREATZ — Config
Centralized environment + constants, powered by pydantic-settings.
"""
from typing import Optional
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
    ADMIN_TOKEN: Optional[str] = None

    # =========================================================
    # Vaults (public keys as strings)
    # =========================================================
    GAME_VAULT: str
    JACKPOT_VAULT: str
    GAME_VAULT_ATA: Optional[str] = None
    JACKPOT_VAULT_ATA: Optional[str] = None
    GAME_VAULT_PK: Optional[str] = None   # server-side signing key
    JACKPOT_VAULT_PK: Optional[str] = None

    # =========================================================
    # Token / Mint
    # =========================================================
    TREATZ_MINT: Optional[str] = None     # empty/None for SOL-only MVP
    TOKEN_DECIMALS: int = 6

    # =========================================================
    # Economics
    # =========================================================
    EDGE_BPS: int = 150       # coinflip house edge (bps) [not yet used]
    WIN_AMOUNT: int = 2       # coinflip win multiplier (2x)
    TICKET_PRICE: int = 1_000_000
    SPLT_BURN: int = 10
    SPLT_DEV: int = 10
    SPLT_WINNER: int = 80

    # =========================================================
    # Game Logic
    # =========================================================
    ROUND_BREAK: int = 2
    ROUND_MIN: int = 2
    SLOTS_PER_MIN: int = 150  # Solana slots per minute (approx)

    # =========================================================
    # Wallets
    # =========================================================
    BURN_ADDRESS: str = "1nc1nerator11111111111111111111111111111111"
    DEV_WALLET: str

    # =========================================================
    # Secrets
    # =========================================================
    HMAC_SECRET: Optional[str] = None
    HELIUS_SIGNATURE_HEADER: Optional[str] = None

    # =========================================================
    # Database
    # =========================================================
    DB_PATH: str = "/data/treatz.db"

# Instantiate global settings (values resolved from environment)
settings = Settings()
