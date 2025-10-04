# payouts.py
from __future__ import annotations
import asyncio
import base58
from typing import Tuple, List, Optional, Union

from config import settings
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.transaction import Transaction
# use solana-py PublicKey/Keypair to match spl.token and Transaction expectations
# robust imports for solana public key / keypair
try:
    # preferred: solana-py public API
    from solana.publickey import PublicKey
    from solana.keypair import Keypair
except Exception as _e:
    # fallback: try solders types if solana-py isn't present
    try:
        from solders.pubkey import Pubkey as PublicKey  # note: different class name
        from solders.keypair import Keypair as SolderKeypair
        # wrap solders keypair to a compatible interface if needed (basic)
        class Keypair:
            def __init__(self, kp: SolderKeypair):
                self._kp = kp
            @property
            def public_key(self):
                return self._kp.pubkey()
            def to_bytes(self):
                return bytes(self._kp.to_bytes())
        # you may not need more adaptation for your current code paths
    except Exception as err:
        # Helpful error to surface in logs so you know why import failed
        raise ImportError(
            "Failed to import solana PublicKey/Keypair. "
            "Ensure 'solana' is listed in requirements.txt and no local 'solana.py' or 'solana/' folder exists. "
            f"Inner error: {_e} / {err}"
        )
from spl.token.instructions import (
    transfer_checked,
    get_associated_token_address,
    create_associated_token_account,
)
from solana.rpc.types import TxOpts
from spl.token.constants import TOKEN_PROGRAM_ID

RPC_URL = settings.RPC_URL


# --------------------------- Utils / Config ---------------------------

def to_public_key(addr: Union[str, PublicKey]) -> PublicKey:
    """Return solana.PublicKey given a str or PublicKey."""
    if isinstance(addr, PublicKey):
        return addr
    if not addr:
        raise ValueError("Empty public key string provided")
    return PublicKey(str(addr))

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
    """
    Decode a base58-encoded secret key and return solana.keypair.Keypair.
    Accepts 64-byte secret keys (private+public) which solana expects.
    """
    raw = base58.b58decode(b58)
    if len(raw) == 64:
        # solana Keypair expects bytes-like for from_secret_key
        return Keypair.from_secret_key(raw)
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

    # transfer_checked signature: (program_id, source, mint, dest, owner, amount, decimals, signers=None)
    tx.add(
        transfer_checked(
            TOKEN_PROGRAM_ID,
            vault_ata,
            mint_pk,
            winner_ata,
            vault_wallet,
            amount_base_units,
            TOKEN_DECIMALS,
            signers=None,
        )
    )

    # Set recent blockhash & fee payer
    lbh = await client.get_latest_blockhash()
    # extract blockhash robustly (solders vs dict differences)
    bh = getattr(getattr(lbh, "value", None), "blockhash", None) or (lbh.get("result") or {}).get("value", {}).get("blockhash") if isinstance(lbh, dict) else None
    if not bh:
        # fallback to the top-level result shape
        try:
            bh = lbh["result"]["value"]["blockhash"]
        except Exception:
            raise RuntimeError("Could not fetch latest blockhash")

    tx.recent_blockhash = bh
    tx.fee_payer = vault_wallet

    # sign with vault owner keypair (solana Keypair)
    tx.sign(vault_owner_kp)

    raw = tx.serialize()
    resp = await client.send_raw_transaction(raw, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed))

    # normalize response to a signature string
    sig = None
    if isinstance(resp, dict):
        sig = resp.get("result") or resp.get("result", None)
        # some versions put signature at resp['result']
        if isinstance(sig, dict):
            sig = sig.get("signature") or sig.get("txHash") or None
    else:
        # solana-py may return a SendResult-like object with .value
        sig = getattr(resp, "value", None) or getattr(resp, "result", None) or str(resp)

    if not sig:
        raise RuntimeError(f"Unable to determine tx signature from send_raw_transaction response: {resp}")

    # wait for confirmation
    try:
        await client.confirm_transaction(sig, commitment=Confirmed)
    except Exception:
        # still return the signature even if confirm failed
        return str(sig)

    return str(sig)

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
