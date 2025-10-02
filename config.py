"""
$TREATZ — Config
Centralized environment + constants, powered by pydantic-settings.
"""
import os
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # =========================================================
    # API
    # =========================================================
    API_PREFIX: str = "/api"

    # =========================================================
    # RPC / Admin
    # =========================================================
    RPC_URL: str = os.getenv("RPC_URL", "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY")
    ADMIN_TOKEN: Optional[str] = None

    # =========================================================
    # Vaults (public keys as strings)
    # =========================================================
    GAME_VAULT: str = os.getenv("GAME_VAULT", "")
    JACKPOT_VAULT: str = os.getenv("JACKPOT_VAULT", "")
    GAME_VAULT_ATA: str = os.getenv("GAME_VAULT_ATA", "")
    JACKPOT_VAULT_ATA: str = os.getenv("JACKPOT_VAULT_ATA", "")
    GAME_VAULT_PK: Optional[str] = None  # base58 secret key (server only)
    JACKPOT_VAULT_PK: Optional[str] = None

    # =========================================================
    # Token / Mint
    # =========================================================
    TREATZ_MINT: str = os.getenv("TREATZ_MINT", "")
    TOKEN_DECIMALS: int = int(os.getenv("TOKEN_DECIMALS", 6))

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
    SLOTS_PER_MIN: int = int(os.getenv("SLOTS_PER_MIN", "150"))

    # =========================================================
    # Wallets
    # =========================================================
    BURN_ADDRESS: str = os.getenv("BURN_ADDRESS", "1nc1nerator11111111111111111111111111111111")
    DEV_WALLET: str = os.getenv("DEV_WALLET", "")

    # =========================================================
    # Secrets
    # =========================================================
    HMAC_SECRET: Optional[str] = os.getenv("HMAC_SECRET", None)
    HELIUS_SIGNATURE_HEADER: Optional[str] = os.getenv("HELIUS_SIGNATURE_HEADER", None)

    # =========================================================
    # Database
    # =========================================================
    DB_PATH: str = os.getenv("DB_PATH", "/data/treatz.db")

# Instantiate global settings (values resolved from environment)
settings = Settings()
