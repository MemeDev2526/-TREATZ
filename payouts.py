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
USING_SOLDERS = False
try:
    from solana.publickey import PublicKey
    from solana.keypair import Keypair
except Exception:
    # solders fallback (keep names compatible-ish)
    try:
        from solders.pubkey import Pubkey as _SoldersPubkey
        from solders.keypair import Keypair as _SolderKeypair
        USING_SOLDERS = True

        # Provide a minimal shim for Keypair that exposes .public_key and .to_bytes
        class Keypair:
            def __init__(self, kp: _SolderKeypair):
                self._kp = kp

            @property:
            def public_key(self):
                # solders: expose a PublicKey-compatible object
                return _SoldersPubkey.from_bytes(bytes(self._kp.pubkey()))

            @classmethod
            def from_secret_key(cls, secret: bytes):
                return cls(_SolderKeypair.from_bytes(secret))

            @classmethod
            def from_seed(cls, seed: bytes):
                return cls(_SolderKeypair.from_seed(seed))

            def to_bytes(self) -> bytes:
                return bytes(self._kp.to_bytes())

        # Alias PublicKey to solders type for uniform use
        PublicKey = _SoldersPubkey  # type: ignore
    except Exception as e:
        raise ImportError(
            "Could not import solana PublicKey/Keypair (neither solana-py nor solders usable). "
            "Install 'solana' or 'solders' packages. Inner error: " + str(e)
        )

# -------- Unified PublicKey constructor (string/bytes -> PublicKey) --------
def _pk_from_b58(s: str) -> PublicKey:
    """
    Construct a PublicKey from a base58 string across solana-py and solders.
    """
    if USING_SOLDERS:
        # solders requires .from_string for base58
        return PublicKey.from_string(s)  # type: ignore[attr-defined]
    # solana-py accepts base58 string directly
    return PublicKey(s)

def _pk_from_bytes(b: bytes) -> PublicKey:
    if USING_SOLDERS:
        return PublicKey.from_bytes(b)  # type: ignore[attr-defined]
    return PublicKey(b)

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
    def create_ata_idem(*, payer, owner, mint, token_program_id=None, program_id=None, **_):
        # classic create_associated_token_account supports token_program_id
        return create_associated_token_account(
            payer=payer, owner=owner, mint=mint,
            token_program_id=token_program_id, program_id=program_id
        )

from solana.rpc.types import TxOpts
from spl.token.constants import TOKEN_PROGRAM_ID
try:
    from spl.token.constants import TOKEN_2022_PROGRAM_ID  # type: ignore
except Exception:
    # Use a cross-lib constructor for the well-known Token-2022 program id
    TOKEN_2022_PROGRAM_ID = _pk_from_b58("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")  # fallback

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

    if owner and str(owner) == str(TOKEN_2022_PROGRAM_ID):
        return TOKEN_2022_PROGRAM_ID
    return TOKEN_PROGRAM_ID

def _require_token_mint() -> None:
    if not settings.TREATZ_MINT:
        raise RuntimeError("TREATZ_MINT is not set. SPL payouts require a token mint.")

def _token_mint() -> PublicKey:
    _require_token_mint()
    return to_public_key(settings.TREATZ_MINT)

def to_public_key(addr: Optional[Union[str, PublicKey, bytes, bytearray]]) -> PublicKey:
    """
    Robustly return a PublicKey from:
      - a PublicKey (returned as-is)
      - a base58 string
      - raw 32 bytes
    """
    if addr is None:
        raise ValueError("Empty public key provided")

    # Already PublicKey?
    try:
        if isinstance(addr, PublicKey):  # type: ignore[arg-type]
            return addr  # type: ignore[return-value]
    except Exception:
        pass

    # Bytes?
    if isinstance(addr, (bytes, bytearray)):
        if len(addr) != 32:
            raise ValueError(f"PublicKey bytes must be length 32, got {len(addr)}")
        return _pk_from_bytes(bytes(addr))

    # String?
    if isinstance(addr, str):
        # Try direct (solana) or from_string (solders) via helper
        try:
            return _pk_from_b58(addr)
        except Exception:
            # fallback: decode then construct
            raw = _b58.b58decode(addr)
            if len(raw) != 32:
                raise ValueError(f"Decoded key length != 32 ({len(raw)})")
            return _pk_from_bytes(raw)

    # Final attempt: pass through (may raise)
    return PublicKey(addr)  # type: ignore[arg-type]

# ---------------- ATA utilities ----------------

def _get_ata(owner: PublicKey, mint: PublicKey, token_prog: PublicKey) -> PublicKey:
    """
    Derive the associated token account for (owner, mint), preferring a signature
    that lets us specify the token program (for Token-2022).
    """
    try:
        # Newer spl-token exposes token_program_id kw
        return get_associated_token_address(owner, mint, token_program_id=token_prog)
    except TypeError:
        # Older builds ignore token_program_id; this will still be correct for classic Token
        return get_associated_token_address(owner, mint)

# ---------------- Keypair loader ----------------

def _kp_from_base58(b58: str) -> Keypair:
    """
    Decode a base58-encoded secret key and return a Keypair suitable for signing.
    Accepts 64-byte secret keys (private+public) or 32-byte seed.
    """
    if not b58:
        raise ValueError("Empty secret key provided")
    raw = _b58.b58decode(b58)

    if len(raw) == 64:
        try:
            return Keypair.from_secret_key(raw)  # type: ignore[attr-defined]
        except Exception:
            try:
                return Keypair.from_seed(raw[:32])  # type: ignore[attr-defined]
            except Exception as e:
                raise ValueError(f"Could not construct Keypair from 64-byte raw key: {e}")
    elif len(raw) == 32:
        try:
            return Keypair.from_secret_key(raw)  # type: ignore[attr-defined]
        except Exception:
            try:
                return Keypair.from_seed(raw)  # type: ignore[attr-defined]
            except Exception as e:
                raise ValueError(f"Could not construct Keypair from 32-byte seed: {e}")
    else:
        raise ValueError(f"Invalid secret key length: {len(raw)} (expected 32 or 64 bytes)")

def _assert_owner_matches(vault_pub: PublicKey, kp: Keypair, label: str) -> None:
    # Normalize to string for comparison
    try:
        vault_s = str(vault_pub)
    except Exception:
        vault_s = str(_b58.b58encode(bytes(vault_pub)))  # defensive

    try:
        kp_pub = kp.public_key
        kp_pub_s = str(kp_pub)
    except Exception:
        kp_pub_s = str(_b58.b58encode(bytes(kp.public_key)))  # defensive

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

    ata = _get_ata(owner, mint_pk, token_prog)

    resp = await client.get_account_info(ata, commitment=Confirmed)
    ixs: List = []
    # If account doesn't exist, add create ix (idempotent variant when available)
    if getattr(resp, "value", None) is None:
        ixs.append(
            create_ata_idem(
                payer=payer,
                owner=owner,
                mint=mint_pk,
                token_program_id=token_prog,   # IMPORTANT for Token-2022 compatibility
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
    token_prog = await _mint_owner_program_id(client)

    # Ensure recipient ATA (vault pays)
    winner_ata, pre_ixs = await _ensure_ata_ixs(client, winner_wallet, payer=vault_wallet)
    # Vault ATA must be for the same token program that owns the mint
    vault_ata = _get_ata(vault_wallet, mint_pk, token_prog)

    tx = Transaction()
    for ix in pre_ixs:
        tx.add(ix)

    tx.add(
        transfer_checked(
            token_prog,            # token program (classic or 2022)
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
        bh = getattr(lbh.value, "blockhash", None)
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

    tx.recent_blockhash = str(bh)
    tx.fee_payer = vault_wallet

    # sign with vault owner keypair
    tx.sign(vault_owner_kp)

    raw = tx.serialize()
    resp = await client.send_raw_transaction(raw, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed))

    # Normalize signature out of the response
    sig = None
    if isinstance(resp, dict):
        sig = resp.get("result") or resp.get("signature") or None
        if isinstance(sig, dict):
            sig = sig.get("signature") or sig.get("txHash") or None
    else:
        sig = getattr(resp, "value", None) or getattr(resp, "result", None) or str(resp)

    if not sig:
        try:
            sig = str(resp)
        except Exception:
            raise RuntimeError(f"Unable to determine tx signature from send_raw_transaction response: {resp}")

    # wait for confirmation (best-effort)
    try:
        await client.confirm_transaction(sig, commitment=Confirmed)
    except Exception:
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

        token_prog = await _mint_owner_program_id(client)
        vault_ata = _get_ata(vault_pub, mint_pk, token_prog)

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
        bh = getattr(getattr(lbh, "value", None), "blockhash", None) or (lbh.get("result") or {}).get("value", {}).get("blockhash") if isinstance(lbh, dict) else None
        if not bh:
            try:
                bh = lbh["result"]["value"]["blockhash"]
            except Exception:
                raise RuntimeError("Could not fetch latest blockhash")
        tx.recent_blockhash = str(bh)
        tx.fee_payer = vault_pub

        tx.sign(kp)
        raw = tx.serialize()
        sig_resp = await client.send_raw_transaction(raw, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed))

        sig = None
        if isinstance(sig_resp, dict):
            sig = sig_resp.get("result") or sig_resp.get("signature") or None
        else:
            sig = getattr(sig_resp, "value", None) or getattr(sig_resp, "result", None) or str(sig_resp)

        try:
            await client.confirm_transaction(sig, commitment=Confirmed)
        except Exception:
            return str(sig)

        return str(sig)