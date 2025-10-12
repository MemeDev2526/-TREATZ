# payouts.py
from __future__ import annotations
import asyncio
import base58 as _b58
from typing import Tuple, List, Optional, Union

from config import settings
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.transaction import Transaction
# prefer solana-py classes; fallback to solders shapes handled below
try:
    from solana.publickey import PublicKey
    from solana.keypair import Keypair
except Exception:
    # solders fallback (keep names compatible-ish)
    try:
        from solders.pubkey import Pubkey as PublicKey
        from solders.keypair import Keypair as SolderKeypair

        # Provide a minimal shim for Keypair that exposes .public_key and .to_bytes
        class Keypair:
            def __init__(self, kp: SolderKeypair):
                self._kp = kp

            @property
            def public_key(self):
                # solders.pubkey object -> bytes or str depending on use; use .to_string() if available
                try:
                    return PublicKey(bytes(self._kp.pubkey()))
                except Exception:
                    return PublicKey(str(self._kp.pubkey()))

            @classmethod
            def from_secret_key(cls, secret: bytes):
                # solders Keypair loads from bytes
                return cls(SolderKeypair.from_bytes(secret))

            def to_bytes(self) -> bytes:
                return bytes(self._kp.to_bytes())
    except Exception as e:
        raise ImportError(
            "Could not import solana PublicKey/Keypair (neither solana-py nor solders usable). "
            "Install 'solana' or 'solders' packages. Inner error: " + str(e)
        )

# spl token helpers (solana-py)
from spl.token.instructions import (
    transfer_checked,
    get_associated_token_address,
    create_associated_token_account,
)
# compat: not all spl-token builds export the idempotent variant
try:
    from spl.token.instructions import create_associated_token_account_idempotent as create_ata_idem
except Exception:
    # fallback to classic creator (not idempotent, but safe to call once)
    def create_ata_idem(*, payer, owner, mint, program_id=None, **_):
        return create_associated_token_account(payer=payer, owner=owner, mint=mint, program_id=program_id)

from solana.rpc.types import TxOpts
from spl.token.constants import TOKEN_PROGRAM_ID
try:
    from spl.token.constants import TOKEN_2022_PROGRAM_ID
except Exception:
    # hardcoded well-known Program ID for Token-2022; fallback to classic if import missing
    from solana.publickey import PublicKey as _PK
    TOKEN_2022_PROGRAM_ID = _PK("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")  # fallback

RPC_URL = settings.RPC_URL

# =========================================================
# Helpers & config
# =========================================================

# Keep original strings at module level and convert lazily
GAME_VAULT_STR = settings.GAME_VAULT or ""
JACKPOT_VAULT_STR = settings.JACKPOT_VAULT or ""

GAME_VAULT_PK_B58 = settings.GAME_VAULT_PK or ""
JACKPOT_VAULT_PK_B58 = settings.JACKPOT_VAULT_PK or ""

TOKEN_DECIMALS = settings.TOKEN_DECIMALS

async def _mint_owner_program_id(client: AsyncClient) -> PublicKey:
    """Return TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID for the configured mint."""
    mint_pk = _token_mint()
    ai = await client.get_account_info(mint_pk, commitment=Confirmed)
    owner = None
    if hasattr(ai, "value") and ai.value:
        owner = getattr(ai.value, "owner", None)
    elif isinstance(ai, dict):
        owner = (((ai.get("result") or {}).get("value") or {}).get("owner"))
    if str(owner) == str(TOKEN_2022_PROGRAM_ID):
        return TOKEN_2022_PROGRAM_ID
    return TOKEN_PROGRAM_ID



def _require_token_mint() -> None:
    if not settings.TREATZ_MINT:
        raise RuntimeError("TREATZ_MINT is not set. SPL payouts require a token mint.")

def _token_mint() -> PublicKey:
    _require_token_mint()
    return to_public_key(settings.TREATZ_MINT)

def to_public_key(addr: Optional[Union[str, PublicKey]]) -> PublicKey:
    """
    Robustly return a solana PublicKey instance from:
      - a PublicKey (returned as-is)
      - a base58 string (decoded -> PublicKey)
      - raw bytes (used directly)
    """
    if addr is None:
        raise ValueError("Empty public key provided")

    # If it's already the expected PublicKey class, return as-is
    try:
        if isinstance(addr, PublicKey):
            return addr
    except Exception:
        # isinstance may fail across solders/solana types; proceed to try other conversions
        pass

    # If it's bytes (32), try constructing
    if isinstance(addr, (bytes, bytearray)):
        try:
            return PublicKey(bytes(addr))
        except Exception:
            # some PublicKey constructors accept bytes or expect different wrapper; try str fallback
            try:
                return PublicKey(addr)
            except Exception as e:
                raise ValueError(f"Cannot convert bytes to PublicKey: {e}")

    # If it's a string, try direct constructor (works for many solana-py versions)
    if isinstance(addr, str):
        try:
            return PublicKey(addr)
        except Exception:
            # fallback: base58-decode and construct from raw bytes
            try:
                raw = _b58.b58decode(addr)
                if len(raw) != 32:
                    raise ValueError(f"Decoded key length != 32 ({len(raw)})")
                return PublicKey(raw)
            except Exception as e:
                raise ValueError(f"Could not convert '{addr}' to PublicKey: {e}")

    # final attempt: try passing to constructor, let it raise if it must
    try:
        return PublicKey(addr)
    except Exception as e:
        raise ValueError(f"Unsupported public key type: {type(addr)} -> {e}")

# ---------------- Keypair loader ----------------

def _kp_from_base58(b58: str) -> Keypair:
    """
    Decode a base58-encoded secret key and return a Keypair suitable for signing.
    Accepts 64-byte secret keys (private+public) which solana expects.
    """
    if not b58:
        raise ValueError("Empty secret key provided")
    raw = _b58.b58decode(b58)
    # Some providers export 64-byte secret key (private + public), others 32; handle both:
    if len(raw) == 64:
        # solana Keypair.from_secret_key expects a bytes-like secret key (private+public)
        try:
            return Keypair.from_secret_key(raw)
        except Exception:
            # try alternative constructor names
            try:
                return Keypair.from_seed(raw[:32])
            except Exception as e:
                raise ValueError(f"Could not construct Keypair from 64-byte raw key: {e}")
    elif len(raw) == 32:
        # If only 32 bytes given, many APIs accept from_secret_key or from_seed
        try:
            return Keypair.from_secret_key(raw)
        except Exception:
            try:
                # solana-py Keypair.from_seed exists
                return Keypair.from_seed(raw)
            except Exception as e:
                raise ValueError(f"Could not construct Keypair from 32-byte seed: {e}")
    else:
        raise ValueError(f"Invalid secret key length: {len(raw)} (expected 32 or 64 bytes)")

def _assert_owner_matches(vault_pub: PublicKey, kp: Keypair, label: str) -> None:
    # vault_pub is PublicKey; kp.public_key may be PublicKey or similar - normalize to str
    try:
        vault_s = str(vault_pub)
        kp_pub_s = str(kp.public_key)
    except Exception:
        # fallback: compare bytes if possible
        try:
            vault_s = bytes(vault_pub)
            kp_pub_s = bytes(kp.public_key)
        except Exception:
            vault_s = vault_pub
            kp_pub_s = kp.public_key
    if vault_s != kp_pub_s:
        raise RuntimeError(f"{label} signer does not match configured vault public key. ({vault_s} != {kp_pub_s})")

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

    # NOTE: python spl-token get_associated_token_address doesn’t expose allow_owner_off_curve;
    # using default is fine for normal wallets.
    ata = get_associated_token_address(owner, mint_pk)

    resp = await client.get_account_info(ata, commitment=Confirmed)
    ixs: List = []
    if getattr(resp, "value", None) is None:
        ixs.append(
            create_ata_idem(
                payer=payer,
                owner=owner,
                mint=mint_pk,
                program_id=token_prog,   # IMPORTANT
            )
        )
    return ata, ixs

# ---------------- Core SPL transfer ----------------

async def _send_spl_from_vault(
    client: AsyncClient,
    vault_owner_kp: Keypair,
    vault_wallet: PublicKey,
    winner_wallet: PublicKey,
    amount_base_units: int,
) -> str:
    mint_pk = _token_mint()
    token_prog = await _mint_owner_program_id(client)  # NEW

    # Ensure recipient ATA (vault pays)
    winner_ata, pre_ixs = await _ensure_ata_ixs(client, winner_wallet, payer=vault_wallet)
    # For vault ATA, program id must match the mint’s program
    vault_ata = get_associated_token_address(vault_wallet, mint_pk)

    tx = Transaction()
    for ix in pre_ixs:
        tx.add(ix)

    tx.add(
        transfer_checked(
            token_prog,            # CHANGED
            vault_ata,
            mint_pk,
            winner_ata,
            vault_wallet,
            amount_base_units,
            TOKEN_DECIMALS,
            signers=None,
        )
    )

    # Set recent blockhash & fee payer robustly
    lbh = await client.get_latest_blockhash()
    bh = None
    if hasattr(lbh, "value") and getattr(lbh, "value", None) is not None:
        bh = getattr(lbh.value, "blockhash", None) or getattr(lbh.value, "blockhash", None)
    if not bh and isinstance(lbh, dict):
        try:
            bh = (lbh.get("result") or {}).get("value", {}).get("blockhash")
        except Exception:
            bh = None
    if not bh:
        try:
            bh = lbh["result"]["value"]["blockhash"]
        except Exception:
            raise RuntimeError("Could not fetch latest blockhash")

    tx.recent_blockhash = str(bh)  # CHANGED: ensure string
    tx.fee_payer = vault_wallet

    # sign with vault owner keypair
    tx.sign(vault_owner_kp)

    raw = tx.serialize()
    resp = await client.send_raw_transaction(raw, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed))

    # Normalize signature out of the response
    sig = None
    if isinstance(resp, dict):
        # solana RPC dict shape -> resp['result'] often contains signature string
        sig = resp.get("result") or resp.get("signature") or None
        # some shapes: {'result': {'value': 'sig'}} -> try nested
        if isinstance(sig, dict):
            sig = sig.get("signature") or sig.get("txHash") or None
    else:
        sig = getattr(resp, "value", None) or getattr(resp, "result", None) or str(resp)

    if not sig:
        # try if resp has .value and .value is signature
        try:
            sig = str(resp)
        except Exception:
            raise RuntimeError(f"Unable to determine tx signature from send_raw_transaction response: {resp}")

    # wait for confirmation (best-effort)
    try:
        await client.confirm_transaction(sig, commitment=Confirmed)
    except Exception:
        # still return signature even if confirm failed
        return str(sig)

    return str(sig)

# ---------------- Public payout APIs ----------------

async def pay_coinflip_winner(winner_pubkey_str: str, amount_base_units: int) -> str:
    """Pay a coinflip winner from GAME_VAULT."""
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
    """Pay the jackpot winner from JACKPOT_VAULT."""
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
    """Pay jackpot split (winner/dev/burn) from JACKPOT_VAULT in a single transaction."""
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

        token_prog = await _mint_owner_program_id(client)  # NEW
        vault_ata = get_associated_token_address(vault_pub, mint_pk)
        
        for ix in pre_ixs:
            tx.add(ix)
            
        # Use same transfer_checked positional form
        if w_pub and winner_amount > 0:
            tx.add(transfer_checked(
                token_prog, vault_ata, mint_pk, w_ata, vault_pub,
                winner_amount, TOKEN_DECIMALS, None
            ))
        if d_pub and dev_amount > 0:
            tx.add(transfer_checked(
                token_prog, vault_ata, mint_pk, d_ata, vault_pub,
                dev_amount, TOKEN_DECIMALS, None
            ))
        if b_pub and burn_amount > 0:
            tx.add(transfer_checked(
                token_prog, vault_ata, mint_pk, b_ata, vault_pub,
                burn_amount, TOKEN_DECIMALS, None
            ))

        lbh = await client.get_latest_blockhash()
        # extract blockhash robustly
        bh = getattr(getattr(lbh, "value", None), "blockhash", None) or (lbh.get("result") or {}).get("value", {}).get("blockhash") if isinstance(lbh, dict) else None
        if not bh:
            try:
                bh = lbh["result"]["value"]["blockhash"]
            except Exception:
                raise RuntimeError("Could not fetch latest blockhash")
        tx.recent_blockhash = str(bh)
        tx.fee_payer = vault_pub

        # sign with vault keypair
        tx.sign(kp)
        raw = tx.serialize()
        sig_resp = await client.send_raw_transaction(raw, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed))

        # Normalize signature and confirm
        sig = None
        if isinstance(sig_resp, dict):
            sig = sig_resp.get("result") or sig_resp.get("signature") or None
        else:
            sig = getattr(sig_resp, "value", None) or getattr(sig_resp, "result", None) or str(sig_resp)

        # try confirm
        try:
            await client.confirm_transaction(sig, commitment=Confirmed)
        except Exception:
            # still return the signature even if confirm failed
            return str(sig)

        return str(sig)