# payouts.py
from __future__ import annotations
from typing import Tuple, List, Optional, Union

import base58 as _b58

from config import settings
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.transaction import Transaction
from solana.rpc.types import TxOpts

# ---------- Prefer solana-py, fallback to solders ----------
try:
    from solana.publickey import PublicKey
    from solana.keypair import Keypair
except Exception:
    # solders fallback (keep names compatible-ish)
    from solders.pubkey import Pubkey as _SoldersPubkey
    from solders.keypair import Keypair as _SolderKeypair

    class PublicKey(_SoldersPubkey):  # type: ignore
        def __new__(cls, val):
            if isinstance(val, (bytes, bytearray)):
                return _SoldersPubkey.from_bytes(bytes(val))
            if isinstance(val, str):
                return _SoldersPubkey.from_string(val)
            return val

    class Keypair:  # minimal shim
        def __init__(self, kp: _SolderKeypair):
            self._kp = kp

        @property
        def public_key(self):
            return self._kp.pubkey()

        @classmethod
        def from_secret_key(cls, secret: bytes):
            return cls(_SolderKeypair.from_bytes(secret))

        @classmethod
        def from_seed(cls, seed: bytes):
            return cls(_SolderKeypair.from_seed(seed))

        def to_bytes(self) -> bytes:
            return bytes(self._kp.to_bytes())

# ---------- SPL helpers ----------
from spl.token.instructions import (
    transfer_checked,
    get_associated_token_address,
    create_associated_token_account,
)
# Use idempotent ATA creation when available
try:
    from spl.token.instructions import create_associated_token_account_idempotent as create_ata_idem
except Exception:
    def create_ata_idem(*, payer, owner, mint, token_program_id=None, **_):
        return create_associated_token_account(
            payer=payer, owner=owner, mint=mint, program_id=token_program_id
        )

from spl.token.constants import TOKEN_PROGRAM_ID
try:
    from spl.token.constants import TOKEN_2022_PROGRAM_ID  # type: ignore
except Exception:
    TOKEN_2022_PROGRAM_ID = None  # will build from string when needed
TOKEN_2022_PROGRAM_ID_STR = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

RPC_URL = settings.RPC_URL

# =========================================================
# Helpers & config
# =========================================================
GAME_VAULT_STR = settings.GAME_VAULT or ""
JACKPOT_VAULT_STR = settings.JACKPOT_VAULT or ""

GAME_VAULT_PK_B58 = settings.GAME_VAULT_PK or ""
JACKPOT_VAULT_PK_B58 = settings.JACKPOT_VAULT_PK or ""

TOKEN_DECIMALS = int(getattr(settings, "TOKEN_DECIMALS", 6))


def _require_token_mint() -> None:
    if not settings.TREATZ_MINT:
        raise RuntimeError("TREATZ_MINT is not set. SPL payouts require a token mint.")


def _token_mint() -> PublicKey:
    _require_token_mint()
    return to_public_key(settings.TREATZ_MINT)


def to_public_key(addr: Optional[Union[str, PublicKey, bytes, bytearray]]) -> PublicKey:
    if addr is None:
        raise ValueError("Empty public key provided")
    try:
        if isinstance(addr, PublicKey):
            return addr  # type: ignore[arg-type]
    except Exception:
        pass
    if isinstance(addr, (bytes, bytearray)):
        return PublicKey(bytes(addr))
    if isinstance(addr, str):
        try:
            return PublicKey(addr)
        except Exception:
            raw = _b58.b58decode(addr)
            if len(raw) != 32:
                raise ValueError(f"Decoded key length != 32 ({len(raw)})")
            return PublicKey(raw)
    return PublicKey(addr)


async def _mint_owner_program_id(client: AsyncClient) -> PublicKey:
    """
    Determine whether the configured mint is classic SPL Token or Token-2022,
    and return the correct token program id as a PublicKey.
    """
    mint_pk = _token_mint()
    ai = await client.get_account_info(mint_pk, commitment=Confirmed)

    owner = None
    if hasattr(ai, "value") and ai.value:
        owner = getattr(ai.value, "owner", None)
    elif isinstance(ai, dict):
        owner = (((ai.get("result") or {}).get("value") or {}).get("owner"))

    owner_str = str(owner) if owner is not None else ""
    if owner_str == (str(TOKEN_2022_PROGRAM_ID) if TOKEN_2022_PROGRAM_ID else TOKEN_2022_PROGRAM_ID_STR):
        return TOKEN_2022_PROGRAM_ID or to_public_key(TOKEN_2022_PROGRAM_ID_STR)
    return TOKEN_PROGRAM_ID


def _kp_from_base58(b58: str) -> Keypair:
    if not b58:
        raise ValueError("Empty secret key provided")
    raw = _b58.b58decode(b58)
    if len(raw) == 64:
        try:
            return Keypair.from_secret_key(raw)
        except Exception:
            try:
                return Keypair.from_seed(raw[:32])
            except Exception as e:
                raise ValueError(f"Could not construct Keypair from 64-byte raw key: {e}")
    if len(raw) == 32:
        try:
            return Keypair.from_secret_key(raw)
        except Exception:
            try:
                return Keypair.from_seed(raw)
            except Exception as e:
                raise ValueError(f"Could not construct Keypair from 32-byte seed: {e}")
    raise ValueError(f"Invalid secret key length: {len(raw)} (expected 32 or 64 bytes)")


def _assert_owner_matches(vault_pub: PublicKey, kp: Keypair, label: str) -> None:
    if str(vault_pub) != str(kp.public_key):
        raise RuntimeError(
            f"{label} signer does not match configured vault public key. "
            f"({str(vault_pub)} != {str(kp.public_key)})"
        )


# ---------------- ATA ensure ----------------
async def _ensure_ata_ixs(
    client: AsyncClient,
    owner: PublicKey,
    payer: PublicKey,
) -> Tuple[PublicKey, List]:
    """
    Ensure owner's ATA exists (idempotent), respecting Token-2022 when applicable.
    """
    mint_pk = _token_mint()
    token_prog = await _mint_owner_program_id(client)
    ata = get_associated_token_address(owner, mint_pk, token_program_id=token_prog)

    resp = await client.get_account_info(ata, commitment=Confirmed)
    exists = False
    if hasattr(resp, "value"):
        exists = bool(resp.value)
    elif isinstance(resp, dict):
        exists = ((resp.get("result") or {}).get("value") is not None)

    ixs: List = []
    if not exists:
        ixs.append(
            create_ata_idem(
                payer=payer,
                owner=owner,
                mint=mint_pk,
                token_program_id=token_prog,
            )
        )
    return ata, ixs


# ---------------- Blockhash + signature helpers ----------------
async def _get_latest_blockhash_str(client: AsyncClient) -> str:
    lbh = await client.get_latest_blockhash()
    # object
    if hasattr(lbh, "value") and getattr(lbh, "value", None) is not None:
        bh = getattr(lbh.value, "blockhash", None)
        if bh:
            return str(bh)
    # dict
    if isinstance(lbh, dict):
        bh = (lbh.get("result") or {}).get("value", {}).get("blockhash")
        if bh:
            return str(bh)
    raise RuntimeError("Could not fetch latest blockhash")


def _normalize_sig(resp) -> str:
    if isinstance(resp, dict):
        sig = resp.get("result") or resp.get("signature")
        if isinstance(sig, dict):
            sig = sig.get("signature") or sig.get("txHash")
        return str(sig or resp)
    return str(getattr(resp, "value", None) or getattr(resp, "result", None) or resp)


# ---------------- Core SPL transfer ----------------
async def _send_spl_from_vault(
    client: AsyncClient,
    vault_owner_kp: Keypair,
    vault_wallet: PublicKey,
    winner_wallet: PublicKey,
    amount_base_units: int,
) -> str:
    if amount_base_units <= 0:
        raise ValueError("amount_base_units must be > 0")

    mint_pk = _token_mint()
    token_prog = await _mint_owner_program_id(client)

    # Ensure recipient ATA (vault pays fees)
    winner_ata, pre_ixs = await _ensure_ata_ixs(client, winner_wallet, payer=vault_wallet)

    # Vault ATA must be derived with the correct token program as well
    vault_ata = get_associated_token_address(vault_wallet, mint_pk, token_program_id=token_prog)

    tx = Transaction()
    for ix in pre_ixs:
        tx = tx.add(ix)

    tx = tx.add(
        transfer_checked(
            token_prog,            # program id
            vault_ata,
            mint_pk,
            winner_ata,
            vault_wallet,
            amount_base_units,
            TOKEN_DECIMALS,
            signers=None,
        )
    )

    tx.recent_blockhash = await _get_latest_blockhash_str(client)
    tx.fee_payer = vault_wallet

    # sign & send (with a tiny retry if simulation complains)
    tx.sign(vault_owner_kp)
    raw = tx.serialize()

    try:
        resp = await client.send_raw_transaction(
            raw,
            opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed)
        )
    except Exception:
        # one retry with skip_preflight=True (network hiccup / compute jitter)
        resp = await client.send_raw_transaction(
            raw,
            opts=TxOpts(skip_preflight=True, preflight_commitment=Confirmed)
        )

    sig = _normalize_sig(resp)

    # best-effort confirm
    try:
        await client.confirm_transaction(sig, commitment=Confirmed)
    except Exception:
        return sig
    return sig


# ---------------- Public payout APIs ----------------
async def pay_coinflip_winner(winner_pubkey_str: str, amount_base_units: int) -> str:
    if not GAME_VAULT_PK_B58:
        raise RuntimeError("GAME_VAULT_PK not set.")
    kp = _kp_from_base58(GAME_VAULT_PK_B58)
    vault_pub = to_public_key(GAME_VAULT_STR)
    _assert_owner_matches(vault_pub, kp, "GAME_VAULT")

    async with AsyncClient(RPC_URL, commitment=Confirmed) as client:
        return await _send_spl_from_vault(
            client=client,
            vault_owner_kp=kp,
            vault_wallet=vault_pub,
            winner_wallet=to_public_key(winner_pubkey_str),
            amount_base_units=amount_base_units,
        )


async def pay_jackpot_winner(winner_pubkey_str: str, amount_base_units: int) -> str:
    if not JACKPOT_VAULT_PK_B58:
        raise RuntimeError("JACKPOT_VAULT_PK not set.")
    kp = _kp_from_base58(JACKPOT_VAULT_PK_B58)
    vault_pub = to_public_key(JACKPOT_VAULT_STR)
    _assert_owner_matches(vault_pub, kp, "JACKPOT_VAULT")

    async with AsyncClient(RPC_URL, commitment=Confirmed) as client:
        return await _send_spl_from_vault(
            client=client,
            vault_owner_kp=kp,
            vault_wallet=vault_pub,
            winner_wallet=to_public_key(winner_pubkey_str),
            amount_base_units=amount_base_units,
        )


async def pay_jackpot_split(
    winner_pubkey_str: str, winner_amount: int,
    dev_pubkey_str: str, dev_amount: int,
    burn_pubkey_str: str, burn_amount: int,
) -> str:
    if not JACKPOT_VAULT_PK_B58:
        raise RuntimeError("JACKPOT_VAULT_PK not set.")
    kp = _kp_from_base58(JACKPOT_VAULT_PK_B58)
    vault_pub = to_public_key(JACKPOT_VAULT_STR)
    _assert_owner_matches(vault_pub, kp, "JACKPOT_VAULT")

    w_pub = to_public_key(winner_pubkey_str) if winner_amount > 0 and winner_pubkey_str else None
    d_pub = to_public_key(dev_pubkey_str) if (dev_amount > 0 and dev_pubkey_str) else None
    b_pub = to_public_key(burn_pubkey_str) if (burn_amount > 0 and burn_pubkey_str) else None

    mint_pk = _token_mint()

    async with AsyncClient(RPC_URL, commitment=Confirmed) as client:
        tx = Transaction()

        pre_ixs: List = []
        w_ata = d_ata = b_ata = None
        if w_pub:
            w_ata, ixs = await _ensure_ata_ixs(client, w_pub, payer=vault_pub); pre_ixs += ixs
        if d_pub:
            d_ata, ixs = await _ensure_ata_ixs(client, d_pub, payer=vault_pub); pre_ixs += ixs
        if b_pub:
            b_ata, ixs = await _ensure_ata_ixs(client, b_pub, payer=vault_pub); pre_ixs += ixs

        token_prog = await _mint_owner_program_id(client)
        vault_ata = get_associated_token_address(vault_pub, mint_pk, token_program_id=token_prog)

        for ix in pre_ixs:
            tx = tx.add(ix)

        if w_pub and winner_amount > 0:
            tx = tx.add(transfer_checked(
                token_prog, vault_ata, mint_pk, w_ata, vault_pub,
                winner_amount, TOKEN_DECIMALS, None
            ))
        if d_pub and dev_amount > 0:
            tx = tx.add(transfer_checked(
                token_prog, vault_ata, mint_pk, d_ata, vault_pub,
                dev_amount, TOKEN_DECIMALS, None
            ))
        if b_pub and burn_amount > 0:
            tx = tx.add(transfer_checked(
                token_prog, vault_ata, mint_pk, b_ata, vault_pub,
                burn_amount, TOKEN_DECIMALS, None
            ))

        tx.recent_blockhash = await _get_latest_blockhash_str(client)
        tx.fee_payer = vault_pub

        tx.sign(kp)
        raw = tx.serialize()
        try:
            sig_resp = await client.send_raw_transaction(
                raw,
                opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed)
            )
        except Exception:
            sig_resp = await client.send_raw_transaction(
                raw,
                opts=TxOpts(skip_preflight=True, preflight_commitment=Confirmed)
            )

        sig = _normalize_sig(sig_resp)

        try:
            await client.confirm_transaction(sig, commitment=Confirmed)
        except Exception:
            return sig
        return sig


async def pay_wheel_winner(winner_pubkey_str: str, amount_base_units: int) -> str:
    """Pay a Wheel of Fate winner (uses GAME_VAULT under the hood)."""
    return await pay_coinflip_winner(winner_pubkey_str, amount_base_units)