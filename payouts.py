# payouts.py
from __future__ import annotations
import os
import asyncio
import base58
from typing import Optional, Tuple

from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.transaction import Transaction
from spl.token.instructions import transfer_checked, get_associated_token_address, create_associated_token_account
from solana.publickey import PublicKey
from solana.keypair import Keypair
from solana.rpc.types import TxOpts

from spl.token.constants import TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
from spl.token.instructions import transfer_checked, get_associated_token_address, create_associated_token_account

RPC_URL = os.getenv("RPC_URL", "https://api.mainnet-beta.solana.com")
SOLANA_CLUSTER = os.getenv("SOLANA_CLUSTER", "mainnet-beta")

# Mints & vaults
MINT = PublicKey(os.getenv("TREATZ_MINT", "11111111111111111111111111111111"))
TOKEN_DECIMALS = int(os.getenv("TOKEN_DECIMALS", "9"))

# Game (coin flip) vaults
GAME_VAULT = PublicKey(os.getenv("GAME_VAULT", "11111111111111111111111111111111"))
GAME_VAULT_PK_B58 = os.getenv("GAME_VAULT_PK", "")

# Jackpot (raffle) vaults
JACKPOT_VAULT = PublicKey(os.getenv("JACKPOT_VAULT", "11111111111111111111111111111111"))
JACKPOT_VAULT_PK_B58 = os.getenv("JACKPOT_VAULT_PK", "")

# ---------------------------------------------------------------------
# Keypair loader that accepts base58-encoded 64-byte secret keys.
# (If a 32-byte seed is provided by mistake, we try to derive a pair.)
# ---------------------------------------------------------------------
def _kp_from_base58(b58: str) -> Keypair:
    raw = base58.b58decode(b58)
    if len(raw) == 64:
        return Keypair.from_secret_key(raw)
    if len(raw) == 32:
        # seed -> derive keypair (not recommended, but handle gracefully)
        return Keypair.from_seed(raw)
    raise ValueError("Invalid secret key length. Expected 64 or 32 bytes after base58 decoding.")

# ---------------------------------------------------------------------
# Ensure recipient ATA exists; if missing, create it in the same tx
# ---------------------------------------------------------------------
async def _ensure_ata_ixs(
    client: AsyncClient, owner: PublicKey, mint: PublicKey
) -> Tuple[PublicKey, list]:
    ata = get_associated_token_address(owner, mint)
    resp = await client.get_account_info(ata, commitment=Confirmed)
    ixs = []
    if resp.value is None:
        # create associated token account instruction
        ixs.append(
            create_associated_token_account(
                payer=owner,            # NOTE: payer doesn't sign here; we'll swap payer in tx
                owner=owner,
                mint=mint,
            )
        )
    return ata, ixs

# ---------------------------------------------------------------------
# Build, sign, and send an SPL transfer (checked) from vault -> winner
# amount must be in base units (respect TOKEN_DECIMALS)
# ---------------------------------------------------------------------
async def _send_spl_from_vault(
    client: AsyncClient,
    vault_owner_kp: Keypair,
    vault_wallet: PublicKey,
    winner_wallet: PublicKey,
    amount_base_units: int,
) -> str:
    # Resolve ATAs
    winner_ata, pre_ixs = await _ensure_ata_ixs(client, winner_wallet, MINT)
    vault_ata = get_associated_token_address(vault_wallet, MINT)

    # Transfer instruction (checked)
    transfer_ix = transfer_checked(
        program_id=TOKEN_PROGRAM_ID,
        source=vault_ata,
        mint=MINT,
        dest=winner_ata,
        owner=vault_wallet,
        amount=amount_base_units,
        decimals=TOKEN_DECIMALS,
        signers=[vault_owner_kp.public_key],  # owner signer
    )

    # Build tx
    tx = Transaction()
    # IMPORTANT: pre_ixs may include a create-ATA with an internal payer placeholder
    # We want the vault to pay fees. Replace payer on the fly by setting tx.payer after we add ixs.
    for ix in pre_ixs:
        # rewrite the payer to be the vault wallet (so fees come from the vault)
        ix.accounts[0].pubkey = vault_wallet
        tx.add(ix)
    tx.add(transfer_ix)
    tx.recent_blockhash = (await client.get_latest_blockhash()).value.blockhash
    tx.fee_payer = vault_wallet

    # Sign & send
    tx.sign(vault_owner_kp)
    raw = tx.serialize()
    sig = await client.send_raw_transaction(raw, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed))
    # Confirm
    await client.confirm_transaction(sig.value, commitment=Confirmed)
    return sig.value

# ---------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------
async def pay_coinflip_winner(winner_pubkey_str: str, amount_base_units: int) -> str:
    """Pays a coinflip winner from GAME_VAULT."""
    if not GAME_VAULT_PK_B58:
        raise RuntimeError("GAME_VAULT_PK not set.")
    kp = _kp_from_base58(GAME_VAULT_PK_B58)
    async with AsyncClient(RPC_URL, commitment=Confirmed) as client:
        sig = await _send_spl_from_vault(
            client=client,
            vault_owner_kp=kp,
            vault_wallet=GAME_VAULT,
            winner_wallet=PublicKey(winner_pubkey_str),
            amount_base_units=amount_base_units,
        )
        return sig

async def pay_jackpot_winner(winner_pubkey_str: str, amount_base_units: int) -> str:
    """Pays the jackpot winner from JACKPOT_VAULT."""
    if not JACKPOT_VAULT_PK_B58:
        raise RuntimeError("JACKPOT_VAULT_PK not set.")
    kp = _kp_from_base58(JACKPOT_VAULT_PK_B58)
    async with AsyncClient(RPC_URL, commitment=Confirmed) as client:
        sig = await _send_spl_from_vault(
            client=client,
            vault_owner_kp=kp,
            vault_wallet=JACKPOT_VAULT,
            winner_wallet=PublicKey(winner_pubkey_str),
            amount_base_units=amount_base_units,
        )
        return sig

async def pay_jackpot_split(
    winner_pubkey_str: str, winner_amount: int,
    dev_pubkey_str: str, dev_amount: int,
    burn_pubkey_str: str, burn_amount: int,
) -> str:
    """Pays jackpot split (winner/dev/burn) from JACKPOT_VAULT in a single tx."""
    if not JACKPOT_VAULT_PK_B58:
        raise RuntimeError("JACKPOT_VAULT_PK not set.")
    kp = _kp_from_base58(JACKPOT_VAULT_PK_B58)

    w_pub = PublicKey(winner_pubkey_str) if winner_amount > 0 else None
    d_pub = PublicKey(dev_pubkey_str) if dev_amount > 0 and dev_pubkey_str else None
    b_pub = PublicKey(burn_pubkey_str) if burn_amount > 0 and burn_pubkey_str else None

    async with AsyncClient(RPC_URL, commitment=Confirmed) as client:
        tx = Transaction()
        # Prepare ATAs (create as needed; vault pays fees)
        pre_ixs = []
        w_ata = None
        if w_pub:
            w_ata, ixs = await _ensure_ata_ixs(client, w_pub, MINT); pre_ixs += ixs
        d_ata = None
        if d_pub:
            d_ata, ixs = await _ensure_ata_ixs(client, d_pub, MINT); pre_ixs += ixs
        b_ata = None
        if b_pub:
            b_ata, ixs = await _ensure_ata_ixs(client, b_pub, MINT); pre_ixs += ixs

        vault_ata = get_associated_token_address(JACKPOT_VAULT, MINT)

        # rewrite payer to vault, add create-ATA ixs
        for ix in pre_ixs:
            ix.accounts[0].pubkey = JACKPOT_VAULT
            tx.add(ix)

        # add transfers
        if w_pub and winner_amount > 0:
            tx.add(transfer_checked(TOKEN_PROGRAM_ID, vault_ata, MINT, w_ata, JACKPOT_VAULT,
                                    winner_amount, TOKEN_DECIMALS, [kp.public_key]))
        if d_pub and dev_amount > 0:
            tx.add(transfer_checked(TOKEN_PROGRAM_ID, vault_ata, MINT, d_ata, JACKPOT_VAULT,
                                    dev_amount, TOKEN_DECIMALS, [kp.public_key]))
        if b_pub and burn_amount > 0:
            tx.add(transfer_checked(TOKEN_PROGRAM_ID, vault_ata, MINT, b_ata, JACKPOT_VAULT,
                                    burn_amount, TOKEN_DECIMALS, [kp.public_key]))

        tx.recent_blockhash = (await client.get_latest_blockhash()).value.blockhash
        tx.fee_payer = JACKPOT_VAULT
        tx.sign(kp)
        raw = tx.serialize()
        sig = await client.send_raw_transaction(raw, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed))
        await client.confirm_transaction(sig.value, commitment=Confirmed)
        return sig.value
