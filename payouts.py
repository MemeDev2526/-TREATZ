# payouts.py
from __future__ import annotations
import asyncio
import base58
from typing import Tuple, List

from config import settings
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.transaction import Transaction
from solders.pubkey import Pubkey as PublicKey
from solders.keypair import Keypair
from spl.token.instructions import (
    transfer_checked,
    get_associated_token_address,
    create_associated_token_account,
)
from solana.rpc.types import TxOpts
from spl.token.constants import TOKEN_PROGRAM_ID

RPC_URL = settings.RPC_URL


# --------------------------- Utils / Config ---------------------------

def to_public_key(addr: str | PublicKey) -> PublicKey:
    return PublicKey.from_string(addr) if isinstance(addr, str) else addr

def _require_token_mint() -> None:
    if not settings.TREATZ_MINT:
        raise RuntimeError("TREATZ_MINT is not set. SPL payouts require a token mint.")

def _token_mint() -> PublicKey:
    _require_token_mint()
    return to_public_key(settings.TREATZ_MINT)

TOKEN_DECIMALS = settings.TOKEN_DECIMALS

GAME_VAULT = to_public_key(settings.GAME_VAULT)
JACKPOT_VAULT = to_public_key(settings.JACKPOT_VAULT)

GAME_VAULT_PK_B58 = settings.GAME_VAULT_PK or ""
JACKPOT_VAULT_PK_B58 = settings.JACKPOT_VAULT_PK or ""


# --------------------------- Keypair Loader ---------------------------

def _kp_from_base58(b58: str) -> Keypair:
    raw = base58.b58decode(b58)
    if len(raw) == 64:
        return Keypair.from_bytes(raw)
    raise ValueError("Invalid secret key: expected base58-encoded 64-byte secret key.")


def _assert_owner_matches(vault_pub: PublicKey, kp: Keypair, label: str) -> None:
    if vault_pub != kp.public_key:
        raise RuntimeError(f"{label} signer does not match configured vault public key.")


# ---------------------- ATA Ensure (vault pays fees) ------------------

async def _ensure_ata_ixs(
    client: AsyncClient,
    owner: PublicKey,
    payer: PublicKey,
) -> Tuple[PublicKey, List]:
    """
    Ensure owner's ATA for TOKEN_MINT exists. If not, return create-ATA ix
    where the provided payer (the vault) pays fees.
    """
    mint_pk = _token_mint()
    ata = get_associated_token_address(owner, mint_pk)
    resp = await client.get_account_info(ata, commitment=Confirmed)
    ixs: List = []
    if resp.value is None:
        ixs.append(
            create_associated_token_account(
                payer=payer,
                owner=owner,
                mint=mint_pk,
            )
        )
    return ata, ixs


# ------------------- Core SPL transfer from a vault -------------------

async def _send_spl_from_vault(
    client: AsyncClient,
    vault_owner_kp: Keypair,
    vault_wallet: PublicKey,
    winner_wallet: PublicKey,
    amount_base_units: int,
) -> str:
    mint_pk = _token_mint()
    # Ensure recipient ATA (vault pays)
    winner_ata, pre_ixs = await _ensure_ata_ixs(client, winner_wallet, payer=vault_wallet)
    vault_ata = get_associated_token_address(vault_wallet, mint_pk)

    tx = Transaction()
    for ix in pre_ixs:
        tx.add(ix)

    tx.add(
        transfer_checked(
            program_id=TOKEN_PROGRAM_ID,
            source=vault_ata,
            mint=mint_pk,
            dest=winner_ata,
            owner=vault_wallet,
            amount=amount_base_units,
            decimals=TOKEN_DECIMALS,
            signers=[vault_owner_kp.public_key],
        )
    )

    tx.recent_blockhash = (await client.get_latest_blockhash()).value.blockhash
    tx.fee_payer = vault_wallet
    tx.sign(vault_owner_kp)

    raw = tx.serialize()
    sig = await client.send_raw_transaction(
        raw, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed)
    )
    await client.confirm_transaction(sig.value, commitment=Confirmed)
    return sig.value


# ------------------------------ Public APIs ---------------------------

async def pay_coinflip_winner(winner_pubkey_str: str, amount_base_units: int) -> str:
    """Pay a coinflip winner from GAME_VAULT."""
    if not GAME_VAULT_PK_B58:
        raise RuntimeError("GAME_VAULT_PK not set.")
    kp = _kp_from_base58(GAME_VAULT_PK_B58)
    _assert_owner_matches(GAME_VAULT, kp, "GAME_VAULT")

    async with AsyncClient(RPC_URL, commitment=Confirmed) as client:
        return await _send_spl_from_vault(
            client=client,
            vault_owner_kp=kp,
            vault_wallet=GAME_VAULT,
            winner_wallet=to_public_key(winner_pubkey_str),
            amount_base_units=amount_base_units,
        )


async def pay_jackpot_winner(winner_pubkey_str: str, amount_base_units: int) -> str:
    """Pay the jackpot winner from JACKPOT_VAULT."""
    if not JACKPOT_VAULT_PK_B58:
        raise RuntimeError("JACKPOT_VAULT_PK not set.")
    kp = _kp_from_base58(JACKPOT_VAULT_PK_B58)
    _assert_owner_matches(JACKPOT_VAULT, kp, "JACKPOT_VAULT")

    async with AsyncClient(RPC_URL, commitment=Confirmed) as client:
        return await _send_spl_from_vault(
            client=client,
            vault_owner_kp=kp,
            vault_wallet=JACKPOT_VAULT,
            winner_wallet=to_public_key(winner_pubkey_str),
            amount_base_units=amount_base_units,
        )


async def pay_jackpot_split(
    winner_pubkey_str: str, winner_amount: int,
    dev_pubkey_str: str, dev_amount: int,
    burn_pubkey_str: str, burn_amount: int,
) -> str:
    """Pay jackpot split (winner/dev/burn) from JACKPOT_VAULT in a single transaction."""
    if not JACKPOT_VAULT_PK_B58:
        raise RuntimeError("JACKPOT_VAULT_PK not set.")
    kp = _kp_from_base58(JACKPOT_VAULT_PK_B58)
    _assert_owner_matches(JACKPOT_VAULT, kp, "JACKPOT_VAULT")

    w_pub = to_public_key(winner_pubkey_str) if winner_amount > 0 else None
    d_pub = to_public_key(dev_pubkey_str) if (dev_amount > 0 and dev_pubkey_str) else None
    b_pub = to_public_key(burn_pubkey_str) if (burn_amount > 0 and burn_pubkey_str) else None

    mint_pk = _token_mint()

    async with AsyncClient(RPC_URL, commitment=Confirmed) as client:
        tx = Transaction()

        pre_ixs: List = []
        w_ata = d_ata = b_ata = None
        if w_pub:
            w_ata, ixs = await _ensure_ata_ixs(client, w_pub, payer=JACKPOT_VAULT); pre_ixs += ixs
        if d_pub:
            d_ata, ixs = await _ensure_ata_ixs(client, d_pub, payer=JACKPOT_VAULT); pre_ixs += ixs
        if b_pub:
            b_ata, ixs = await _ensure_ata_ixs(client, b_pub, payer=JACKPOT_VAULT); pre_ixs += ixs

        vault_ata = get_associated_token_address(JACKPOT_VAULT, mint_pk)

        for ix in pre_ixs:
            tx.add(ix)

        if w_pub and winner_amount > 0:
            tx.add(transfer_checked(TOKEN_PROGRAM_ID, vault_ata, mint_pk, w_ata, JACKPOT_VAULT,
                                    winner_amount, TOKEN_DECIMALS, [kp.public_key]))
        if d_pub and dev_amount > 0:
            tx.add(transfer_checked(TOKEN_PROGRAM_ID, vault_ata, mint_pk, d_ata, JACKPOT_VAULT,
                                    dev_amount, TOKEN_DECIMALS, [kp.public_key]))
        if b_pub and burn_amount > 0:
            tx.add(transfer_checked(TOKEN_PROGRAM_ID, vault_ata, mint_pk, b_ata, JACKPOT_VAULT,
                                    burn_amount, TOKEN_DECIMALS, [kp.public_key]))

        tx.recent_blockhash = (await client.get_latest_blockhash()).value.blockhash
        tx.fee_payer = JACKPOT_VAULT
        tx.sign(kp)
        raw = tx.serialize()
        sig = await client.send_raw_transaction(raw, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed))
        await client.confirm_transaction(sig.value, commitment=Confirmed)
        return sig.value
