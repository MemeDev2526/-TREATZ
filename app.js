// app.js — reorganized, resilient, complete drop-in for TREATZ
// - cleaned structure: sections for imports, shims, config, helpers, FX, countdown,
//   wallet plumbing, UI wiring, raffle/history, ambient audio, exports.
// - defensive DOM access, robust wallet APIs, no TDZ/reference errors if libs missing.
// - preserves all existing behaviors (coin flip UI, FX, mascot, ambient audio).
//
// NOTE: This is intended as a drop-in replacement for the original app.js at:
// https://github.com/MemeDev2526/-TREATZ/blob/9a0930dc1809002caca7111194c6d2c34ac27c6f/app.js

// [polyfills] -------------------------------------------------
// Buffer/Process shims are injected by esbuild (see build-app.js).
// Do not import "buffer" here—browsers cannot resolve it.
if (typeof window !== "undefined") {
  if (!window.global) window.global = window; // some libs expect global
  if (!window.process) window.process = { env: { NODE_ENV: "production" } };
}
// ------------------------------------------------------------

// 1) Solana + SPL Token imports (ESM)
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";

// SHIM: expose imported libs onto window for legacy diagnostics / IIFEs
if (typeof window !== "undefined") {
  window.solanaWeb3 = window.solanaWeb3 || {
    Connection,
    PublicKey,
    Transaction,
    TransactionInstruction,
  };
  window.splToken = window.splToken || {
    getAssociatedTokenAddress,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferCheckedInstruction,
  };
}

// 2) RPC connection
const RPC_URL =
  window.TREATZ_CONFIG?.rpcUrl
  || "https://api.mainnet-beta.solana.com";

const connection = new Connection(RPC_URL, { commitment: "confirmed" });

// Warm-up probe so we fail fast & show a friendly message if RPC blocks the browser
(async () => {
  try {
    await connection.getLatestBlockhash("confirmed");
  } catch (e) {
    console.error("[TREATZ] RPC warmup failed:", e);
    try {
      (window.toast ? window.toast : (m)=>console.log("[toast]", m))("RPC blocked/rate-limited. Try another RPC or use a proxy.");
    } catch {}
  }
})();

// 2b) Token program resolver (module-scope, used by exports and by the IIFE)
export async function getTokenProgramForMint(mintPk) {
  try {
    const mint = new PublicKey(mintPk);
    const ai = await connection.getAccountInfo(mint, "confirmed");
    if (!ai?.owner) return TOKEN_PROGRAM_ID;
    return ai.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
  } catch (e) {
    console.warn("[TREATZ] getTokenProgramForMint fallback (RPC error):", e?.message || e);
    return TOKEN_PROGRAM_ID; // graceful fallback on 401/403/timeouts
  }
}

// 3) Exported helper (used by other modules / tests)
export async function getAta(owner, mint) {
  const ownerPk = new PublicKey(owner);
  const mintPk  = new PublicKey(mint);
  const tokenProgramId = await getTokenProgramForMint(mintPk);
  const ata = getAssociatedTokenAddressSync(mintPk, ownerPk, true, tokenProgramId);
  console.log("ATA:", ata.toBase58());
  return ata;
}

// 4) App IIFE — core initialization & module wiring
(function () {
  "use strict";

  // GLOBAL CONFIG
  const C = window.TREATZ_CONFIG || {};
  const API = (C.apiBase || "/api").replace(/\/$/, "");
  const TOKEN = C.token || { symbol: "$TREATZ", decimals: 6 };

  // --- Wallet Helpers ---
  // --- Wallet detection + universal sender ---
  function getInjectedProvider() {
    const candidates = [
      (window.phantom && window.phantom.solana) || null,
      (window.solana && window.solana.isPhantom ? window.solana : null) || null,
      (window.backpack && window.backpack.isBackpack ? window.backpack : null) || null,
      (window.solflare && window.solflare.isSolflare ? window.solflare : null) || null,
    ].filter(Boolean);
    const connected = candidates.find(p => p.publicKey || p.isConnected);
    return connected || candidates[0] || null;
  }

  async function ensureBlockhashAndPayer(connection, tx, feePayerPubkey) {
    if (!tx.feePayer) tx.feePayer = feePayerPubkey;
    if (!tx.recentBlockhash) {
      const { blockhash } = await connection.getLatestBlockhash("finalized");
      tx.recentBlockhash = blockhash;
    }
    return tx;
  }

  async function sendTxUniversal({ connection, tx }) {
    const provider = getInjectedProvider();
    if (!provider) {
      throw new Error("WALLET_NOT_FOUND");
    }
    try {
      if (!provider.publicKey) {
        await provider.connect?.();
      }
    } catch (e) {
      throw new Error("WALLET_CONNECT_REJECTED");
    }

    await ensureBlockhashAndPayer(connection, tx, provider.publicKey);

    if (typeof provider.transact === "function") {
      const sig = await provider.transact(async (wallet) => {
        const res = await wallet.signAndSendTransaction(tx);
        return res?.signature || res;
      });
      return sig;
    }
    if (typeof provider.signAndSendTransaction === "function") {
      const res = await provider.signAndSendTransaction(tx);
      return res?.signature || res;
    }
    if (typeof provider.signTransaction === "function") {
      const signed = await provider.signTransaction(tx);
      const raw = signed.serialize();
      const sig = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
      return sig;
    }
    if (typeof provider.signAllTransactions === "function") {
      const [signed] = await provider.signAllTransactions([tx]);
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
      return sig;
    }
    throw new Error("WALLET_NO_SEND_METHOD");
  }

  // DOM helpers (defensive)
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel || ""));

  // Number formatting helpers
  let DECIMALS = Number(TOKEN.decimals || 6);
  let TEN_POW = 10 ** DECIMALS;
  const fmtUnits = (units, decimals = DECIMALS) => {
    if (units == null) return "—";
    const t = Number(units) / Math.pow(10, decimals);
    return t >= 1 ? t.toFixed(2) : t.toFixed(4);
  };

  // Network-safe fetch helpers
  async function jfetch(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }
  async function jfetchStrict(url, opts) { return jfetch(url, opts); }

  // Lightweight toast
  const toast = (msg) => {
    try {
      const t = document.createElement("div");
      t.className = "toast";
      t.textContent = msg;
      Object.assign(t.style, {
        position: "fixed", right: "16px", bottom: "16px",
        background: "rgba(0,0,0,.75)", color: "#fff",
        padding: "10px 12px", borderRadius: "8px", zIndex: 9999,
        fontFamily: "Rubik, system-ui, sans-serif", fontSize: "14px",
        opacity: 0, transition: "opacity .2s ease"
      });
      document.body.appendChild(t);
      requestAnimationFrame(() => t.style.opacity = 1);
      setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.remove(), 250); }, 2600);
    } catch (e) { console.warn("toast failed", e); }
  };

  // Simple random helpers
  const rand = (min, max) => Math.random() * (max - min) + min;

  // -------------------------
  // Diagnostics — visible bar for debugging (optional)
  // -------------------------
  (function diagnostics() {
    if (!window.__TREATZ_DEBUG) return;

    function showDiag(msg, kind) {
      if (!window.__TREATZ_DEBUG) return;
      if (!document.body) {
        document.addEventListener("DOMContentLoaded", () => showDiag(msg, kind));
        return;
      }
      let bar = document.getElementById("__treatz_diag");
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "__treatz_diag";
        bar.style.cssText = [
          "position:fixed",
          "left:0",
          "right:0",
          "top:0",
          "z-index:99999",
          "padding:10px 14px",
          "font:14px/1.3 Rubik,system-ui,sans-serif",
          "color:#fff",
          "background:#c01",
          "box-shadow:0 6px 20px rgba(0,0,0,.5)",
          "display:flex",
          "flex-direction:column",
          "gap:4px",
        ].join(";");
        document.body.appendChild(bar);
      }
      const span = document.createElement("div");
      span.textContent = "[TREATZ] " + msg;
      span.style.whiteSpace = "nowrap";
      if (kind === "ok") span.style.color = "#0f0";
      if (kind === "err") span.style.color = "#ffb3b3";
      bar.appendChild(span);
    }

    window.addEventListener("error", (e) => showDiag("JS error: " + (e.message || e.type), "err"));
    window.addEventListener("unhandledrejection", (e) => showDiag("Promise rejection: " + (e.reason && e.reason.message || e.reason), "err"));

    document.addEventListener("DOMContentLoaded", async () => {
      try {
        showDiag("Booting diagnostics…");
        showDiag(window.solanaWeb3 ? "web3.js ✓" : "solana web3 missing", window.solanaWeb3 ? "ok" : "err");
        showDiag(window.splToken ? "@solana/spl-token ✓" : "spl-token missing", window.splToken ? "ok" : "err");
        showDiag("API = " + API);
        try {
          const r = await fetch(API + "/health", { mode: "cors" });
          if (!r.ok) throw new Error(r.status + " " + r.statusText);
          const j = await r.json();
          showDiag("API /health OK (ts=" + j.ts + ")", "ok");
        } catch (e) {
          showDiag("API not reachable: " + (e.message || e), "err");
        }
      } catch (e) {
        showDiag("Diagnostics failed: " + (e.message || e), "err");
      }
    });
  })();

  // -------------------------
  // FX: fx-layer root and primitives
  // -------------------------
  const fxRoot = (() => {
    try {
      let n = document.getElementById("fx-layer");
      if (!n) {
        n = document.createElement("div");
        n.id = "fx-layer";
        n.classList.add("fx-layer");
        n.setAttribute("aria-hidden", "true");
        document.body.appendChild(n);
        console.log("[TREATZ] fx-layer created");
      } else if (n.parentElement !== document.body) {
        console.warn("[TREATZ] fx-layer not direct child of <body>. Moving under body.");
        document.body.appendChild(n);
      }
      Object.assign(n.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",
        overflow: "visible",
        zIndex: "99999",
        transform: "none",
      });
      return n;
    } catch (e) {
      console.warn("fxRoot init failed", e);
      return null;
    }
  })();

  (function ensureFxRootTopLevel() {
    try {
      const fx = document.getElementById("fx-layer");
      if (!fx) return;
      let n = fx.parentElement, found = false;
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n);
        if (cs.transform !== "none" || cs.perspective !== "none" || cs.filter !== "none" || /fixed|sticky/.test(cs.position)) {
          found = true;
          break;
        }
        n = n.parentElement;
      }
      if (found) {
        document.documentElement.appendChild(fx);
        Object.assign(fx.style, {
          position: "fixed", inset: "0px", left: "0px", top: "0px", width: "100%", height: "100%", pointerEvents: "none"
        });
        fx.style.zIndex = String(Math.max(11000, Number(getComputedStyle(fx).zIndex || 11000)) + 10000);
        console.log("[TREATZ] fx-layer moved to <html> to avoid transformed ancestor containment.");
      }
    } catch (e) { console.warn("ensureFxRootTopLevel failed", e); }
  })();

  // SVG helpers
  function svgWrapper(color = "#FF6B00") {
    return `
<svg width="84" height="40" viewBox="0 0 84 40" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="$TREATZ">
  <g fill="currentColor">
    <path d="M10 14 L2 8 L10 10 L8 2 L16 12 Z"/>
    <rect x="16" y="6" rx="6" ry="6" width="52" height="28"/>
    <path d="M74 26 L82 32 L74 30 L76 38 L68 28 Z"/>
  </g>
  <text x="42" y="26" text-anchor="middle" font-family="Creepster, Luckiest Guy, sans-serif" font-size="14" fill="#ffffff" font-weight="700">$TREATZ</text>
</svg>`;
  }
  function svgCandy() {
    const uid = 'candyG_' + Math.floor(Math.random() * 1e9);
    return `
<svg width="42" height="32" viewBox="0 0 42 32" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="candy">
  <defs>
    <linearGradient id="${uid}" x1="0" x2="1">
      <stop offset="0" stop-color="#FFB27A"/>
      <stop offset="1" stop-color="#FF6B00"/>
    </linearGradient>
  </defs>
  <path d="M4 16 L0 10 L6 12 L6 4 L12 10" fill="#F7F7F8"/>
  <rect x="8" y="6" rx="6" ry="6" width="26" height="20" fill="url(#${uid})" stroke="rgba(0,0,0,0.12)"/>
  <path d="M38 16 L42 22 L36 20 L36 28 L30 22" fill="#F7F7F8"/>
  <rect x="16" y="10" width="10" height="12" rx="3" fill="#0D0D0D" />
</svg>`;
  }
  function svgGhost() {
    const uid = Math.floor(Math.random() * 1e9);
    const gid = `gGhost_${uid}`;
    const fid = `gShadow_${uid}`;
    return `
<svg width="44" height="56" viewBox="0 0 44 56" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ghost">
  <defs>
    <linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.98"/>
      <stop offset="1" stop-color="#cfefff" stop-opacity="0.9"/>
    </linearGradient>
    <filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <g filter="url(#${fid})">
    <path d="M22 2c11 0 20 9 20 20v24c0 3-3 3-6 2-3-1-5 0-8 1s-6-2-9-2-6 3-9 2-5-2-8-1c-3 1-6 1-6-2V22C2 11 11 2 22 2z" fill="url(#${gid})"/>
    <circle cx="16" cy="22" r="4" fill="#0D0D0D"/>
    <circle cx="28" cy="22" r="4" fill="#0D0D0D"/>
    <path d="M14 34 Q18 30 22 34 Q26 38 30 34" fill="rgba(0,0,0,0.06)"/>
  </g>
</svg>`;
  }
  function svgSkull() {
    return `
<svg width="56" height="56" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="skull">
  <g>
    <rect width="100%" height="100%" fill="none"/>
    <text x="50%" y="54%" text-anchor="middle" font-size="36" font-family="Apple Color Emoji,Segoe UI Emoji,Segoe UI Symbol" dominant-baseline="middle">☠️</text>
  </g>
</svg>`;
  }

  // spawn piece primitive
  function spawnPiece(kind, xvw = 50, sizeScale = 1, duration = 4.2, opts = {}) {
    try {
      let root = document.getElementById("fx-layer") || fxRoot;
      if (!root) {
        root = document.createElement("div");
        root.id = "fx-layer";
        root.classList.add("fx-layer");
        root.setAttribute("aria-hidden", "true");
        document.body.appendChild(root);
        Object.assign(root.style, {
          position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh",
          pointerEvents: "none", overflow: "visible", zIndex: "99999", transform: "none"
        });
        console.log("[TREATZ] fx-layer fallback created");
      }

      const el = document.createElement("div");
      el.className = `fx-piece ${kind}`;

      const rotation = Math.floor(rand(-28, 28));
      const r1 = `${Math.floor(rand(240, 720))}deg`;
      const scaleVal = Number(sizeScale) || 1;
      const leftPct = Math.max(2, Math.min(98, Number(xvw) || 50));

      el.style.left = `${leftPct}%`;
      el.style.top = `-8%`;
      el.style.setProperty("--dur", `${duration}s`);
      el.style.setProperty("--scale", String(scaleVal));
      el.style.setProperty("--r0", `${rotation}deg`);
      el.style.setProperty("--r1", r1);

      let svg = "";
      if (kind === "fx-wrapper") {
        const color = opts.color || opts.colorHex || "#FF6B00";
        el.style.setProperty("--fx-color", color);
        el.style.color = color;
        el.classList.add("fx-piece--win");
        svg = svgWrapper(color);
      } else if (kind === "fx-candy") {
        el.classList.add("fx-piece--win");
        el.style.color = "#39FF14";
        svg = svgCandy();
      } else if (kind === "fx-ghost") {
        el.classList.add("fx-piece--loss", "fx-piece--ghost");
        el.style.color = "#94DAFF";
        svg = svgGhost();
      } else if (kind === "fx-skull" || kind === "fx-loss" || kind === "fx-bone") {
        el.classList.add("fx-piece--loss");
        el.style.color = "#FFFFFF";
        svg = svgSkull();
      } else {
        el.classList.add("fx-piece--loss");
        el.style.color = "#FF6B00";
        svg = svgSkull();
      }

      el.innerHTML = svg;
      el.querySelectorAll("svg, path, rect, circle, text").forEach(n => {
        n.style.fill = "currentColor";
      });

      solidifySVG(el);

      el.style.willChange = "transform, opacity";
      root.appendChild(el);
      void el.offsetWidth;

      el.style.transform = `translateY(-6%) rotate(${Math.floor(rand(-20,20))}deg) scale(${scaleVal})`;

      let removed = false;
      const removeNow = () => {
        if (removed) return;
        removed = true;
        try {
          if (el.__treatz_rm) { clearTimeout(el.__treatz_rm); el.__treatz_rm = null; }
          el.remove();
        } catch (e) {}
      };

      el.addEventListener("animationend", () => removeNow(), { once: true });
      const removeAfter = Math.max(900, Math.round(Number(duration) * 1000) + 750);
      el.__treatz_rm = setTimeout(removeNow, removeAfter);

      return el;
    } catch (e) {
      console.warn("spawnPiece failed", e);
      return null;
    }
  }

  function solidifySVG(el){
    try {
      el.querySelectorAll('svg, path, rect, circle, ellipse, polygon, text, stop, g').forEach(n => {
        const fill = n.getAttribute('fill');
        if (!fill || fill === 'none') n.setAttribute('fill', 'currentColor');
        n.style.opacity = '1';
        n.setAttribute('fill-opacity', '1');
        n.setAttribute('stroke-opacity', '1');
      });
    } catch(e) {}
  }

  const WRAP_COLORS = ['#6b2393', '#00c96b', '#ff7a00'];

  function rainTreatz({ count = 24, wrappers = true, candies = true, minDur = 4.5, maxDur = 7 } = {}) {
    for (let i = 0; i < count; i++) {
      const x = Math.round(rand(6, 94));
      const scale = rand(0.78, 1.22);
      const dur = rand(minDur, maxDur);
      if (wrappers) {
        const color = WRAP_COLORS[Math.floor(Math.random() * WRAP_COLORS.length)];
        spawnPiece("fx-wrapper", x + rand(-3, 3), scale, dur, { color });
      }
      if (candies && Math.random() < 0.75) {
        spawnPiece("fx-candy", Math.max(6, Math.min(94, x + rand(-6, 6))), rand(0.7, 1.05), Math.max(2.6, dur + rand(-0.6, 0.6)));
      }
    }
  }

  function hauntTrick({ count = 10, ghosts = true, skulls = true } = {}) {
    for (let i = 0; i < count; i++) {
      const x = rand(6, 94);
      const skullScale = rand(0.7, 2.6);
      const ghostScale = rand(0.9, 1.6);
      const skullDur = rand(3.8, 7.5);
      const ghostDur = rand(5.6, 10.5);
      const delay = Math.floor(rand(0, 700));
      if (ghosts && Math.random() < 0.75) {
        setTimeout(() => spawnPiece("fx-ghost", x + rand(-8, 8), ghostScale, ghostDur), delay);
      }
      if (skulls && Math.random() < 0.85) {
        setTimeout(() => spawnPiece("fx-skull", x + rand(-8, 8), skullScale, skullDur), delay + Math.floor(rand(80, 360)));
      }
    }
  }

  function playResultFX(result) {
    const r = String(result || "").toUpperCase();
    if (r === "TRICK" || r === "LOSS") {
      hauntTrick({ count: 10, ghosts: true, skulls: true });
      document.body.classList.add('flash');
      setTimeout(() => document.body.classList.remove('flash'), 1100);
      setTimeout(() => hauntTrick({ count: 6, ghosts: true, skulls: true }), 300);
    } else {
      rainTreatz({ count: 28, wrappers: true, candies: true, minDur: 4.2, maxDur: 7 });
      setTimeout(() => rainTreatz({ count: 12, wrappers: true, candies: false, minDur: 3.6, maxDur: 5.6 }), 220);
    }
  }

  // Expose FX helpers
  window.playResultFX = playResultFX;
  window.rainTreatz = rainTreatz;
  window.hauntTrick = hauntTrick;
  window.spawnPiece = spawnPiece;

  // -------------------------
  // Coin faces & visuals
  // -------------------------
  function setCoinFaces(trickImg, treatImg) {
    const front = document.querySelector(".coin__face--front");
    const back = document.querySelector(".coin__face--back");
    if (!front || !back) return;
    Object.assign(front.style, {
      background: `center/contain no-repeat url('${trickImg}')`,
      border: "none", textIndent: "-9999px"
    });
    Object.assign(back.style, {
      background: `center/contain no-repeat url('${treatImg}')`,
      border: "none", textIndent: "-9999px", transform: "rotateY(180deg)"
    });
  }

  function applyCoinFaces({ trickImg, treatImg } = {}) {
    try {
      trickImg = trickImg || (window.TREATZ_CONFIG?.assets?.coin_trick) || "/static/assets/coin_trickz.png";
      treatImg = treatImg || (window.TREATZ_CONFIG?.assets?.coin_treat) || "/static/assets/coin_treatz.png";
      setCoinFaces(trickImg, treatImg);
    } catch (e) {
      console.warn("applyCoinFaces failed", e);
    }
  }

  function setCoinVisual(landed) {
    const result = String(landed || "").toUpperCase();
    const isTreat = (result === "TREAT");
    const coinRoot = document.getElementById("coin") || document.querySelector(".coin");
    if (coinRoot) coinRoot.dataset.coinResult = landed;
    if (coinRoot) {
      if (isTreat) {
        coinRoot.classList.add("coin--show-treat");
        coinRoot.classList.remove("coin--show-trick");
      } else {
        coinRoot.classList.add("coin--show-trick");
        coinRoot.classList.remove("coin--show-treat");
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const treatImg = (window.TREATZ_CONFIG?.assets?.coin_treat) || "/static/assets/coin_treatz.png";
    const trickImg = (window.TREATZ_CONFIG?.assets?.coin_trick) || "/static/assets/coin_trickz.png";
    applyCoinFaces({ trickImg, treatImg });
  });

  // -------------------------
  // Countdown helpers (Halloween)
  // -------------------------
  function nextHalloween() {
    const now = new Date();
    const m = now.getMonth();
    const d = now.getDate();
    const year = (m > 9 || (m === 9 && d >= 31)) ? now.getFullYear() + 1 : now.getFullYear();
    return new Date(year, 9, 31, 0, 0, 0, 0);
  }

  function formatDHMS(ms) {
    let s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60); s %= 60;
    const dd = String(d);
    const hh = String(h).padStart(2, "0");
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return (
      `<span class="cd-part"><span class="cd-num">${dd}</span><span class="cd-unit">D</span></span>` +
      ` <span class="cd-part"><span class="cd-num">${hh}</span><span class="cd-unit">H</span></span>` +
      ` <span class="cd-part"><span class="cd-num">${mm}</span><span class="cd-unit">M</span></span>` +
      ` <span class="cd-part"><span class="cd-num">${ss}</span><span class="cd-unit">S</span></span>`
    );
  }

  function initHalloweenCountdown() {
    try {
      const timerEl = document.getElementById("countdown-timer");
      const omenEl = document.getElementById("countdown-omen");
      if (!timerEl) return;
      const omens = [
        "The wrappers rustle. Something’s awake.",
        "Beware the TRICKZ… crave the TREATZ.",
        "Candy fog thickens… footsteps in the mist.",
        "Lanterns flicker. The ritual nears.",
        "Whispers from the vault… tickets scratch.",
        "Hungry ghosts eye your bag.",
        "A second game stirs beneath the moon.",
        "The cauldron hums. Keys turn in the dark.",
        "A sweet pump draws near.",
        "Don’t blink. The jackpot watches back.",
        "Another door may open before midnight…"
      ];
      let i = Math.floor(Math.random() * omens.length);
      let target = nextHalloween();
      const tick = () => {
        const diff = target - Date.now();
        if (diff <= 0) target = nextHalloween();
        timerEl.innerHTML = formatDHMS(target - Date.now());
      };
      const rotate = () => {
        i = (i + 1) % omens.length;
        if (omenEl) omenEl.textContent = omens[i];
      };
      tick(); rotate();
      window.__treatz_cd_timer && clearInterval(window.__treatz_cd_timer);
      window.__treatz_cd_timer = setInterval(tick, 1000);
      window.__treatz_cd_omen && clearInterval(window.__treatz_cd_omen);
      window.__treatz_cd_omen = setInterval(rotate, 12000);
    } catch (e) { console.error("Countdown init failed", e); }
  }
  initHalloweenCountdown();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) initHalloweenCountdown(); });

  // -------------------------
  // Static links, deep-links, mascot float, copy token
  // -------------------------
  const link = (id, href) => { const el = document.getElementById(id); if (el && href) el.href = href; };
  link("link-telegram", C.links?.telegram);
  link("link-twitter", C.links?.twitter);
  link("link-tiktok", C.links?.tiktok);
  link("link-whitepaper", C.links?.whitepaper);
  link("btn-buy", C.buyUrl);

  function phantomDeepLinkForThisSite() {
    const url = location.href.split('#')[0];
    return `https://phantom.app/ul/browse/${encodeURIComponent(url)}`;
  }

  function isMobile() { return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || ""); }

  const deepLinks = [
    document.getElementById("btn-open-in-phantom"),
    document.getElementById("btn-open-in-phantom-2"),
    document.getElementById("btn-open-in-phantom-3"),
    document.getElementById("btn-open-in-phantom-modal"),
  ].filter(Boolean);

  function updateDeepLinkVisibility(PUBKEY = null) {
    if (!deepLinks.length) return;
    const href = phantomDeepLinkForThisSite();
    const hasProvider = !!(getPhantomProvider() || getSolflareProvider() || getBackpackProvider());
    const shouldShow = isMobile() && !hasProvider && !PUBKEY;
    for (const a of deepLinks) {
      a.href = href;
      a.style.display = shouldShow ? "inline-block" : "none";
      if (a.hasAttribute("hidden")) a.hidden = !shouldShow;
    }
  }
  document.addEventListener("DOMContentLoaded", () => updateDeepLinkVisibility());
  window.addEventListener("load", () => updateDeepLinkVisibility());

  const tokenEl = $("#token-address");
  if (tokenEl) tokenEl.textContent = C.tokenAddress || "—";
  const cdLogo = $("#countdown-logo");
  if (C.assets?.logo && cdLogo) { cdLogo.src = C.assets.logo; cdLogo.alt = "$TREATZ"; }

  // Mascot float
  (function mascotFloat() {
    const mascotImg = $("#mascot-floater");
    if (!mascotImg || !C.assets?.mascot) return;
    mascotImg.src = C.assets.mascot;
    mascotImg.alt = "Treatz Mascot";
    mascotImg.style.willChange = "transform";
    mascotImg.style.position = "fixed";
    mascotImg.style.left = "35px";
    mascotImg.style.top = "35px";

    const MARGIN = 24;
    let x = 120, y = 120, tx = x, ty = y, t = 0;
    const SPEED = 0.01;
    let mascotPaused = false;
    let rafId = null;

    const pickTarget = () => {
      const w = window.innerWidth, h = window.innerHeight;
      const rect = mascotImg.getBoundingClientRect();
      const elW = rect.width || 96, elH = rect.height || 96;
      tx = MARGIN + Math.random() * Math.max(1, w - elW - MARGIN * 2);
      ty = MARGIN + Math.random() * Math.max(1, h - elH - MARGIN * 2);
    };

    function step() {
      if (mascotPaused) { rafId = null; return; }
      t += 1;
      x += (tx - x) * SPEED;
      y += (ty - y) * SPEED;
      if (Math.hypot(tx - x, ty - y) < 4) pickTarget();
      const bobX = Math.sin(t * 0.05) * 10;
      const bobY = Math.cos(t * 0.04) * 8;
      const rot = Math.sin(t * 0.03) * 4;
      mascotImg.style.transform = `translate(${x + bobX}px, ${y + bobY}px) rotate(${rot}deg)`;
      rafId = requestAnimationFrame(step);
    }

    pickTarget();
    if (!rafId) rafId = requestAnimationFrame(step);
    window.addEventListener("resize", pickTarget);

    (function enableFlyAndReturn() {
      mascotImg.style.cursor = 'pointer';
      mascotImg.setAttribute('aria-label', 'site mascot - tap to send flying');
      let busy = false;
      async function flyToAndReturn() {
        if (busy) return;
        busy = true;
        mascotPaused = true;
        await new Promise(r => requestAnimationFrame(r));
        const rect = mascotImg.getBoundingClientRect();
        const startX = rect.left;
        const startY = rect.top;
        const quadrant = Math.floor(Math.random() * 4);
        const targets = [
          { xPct: 12, yPct: 14 },
          { xPct: 82, yPct: 12 },
          { xPct: 12, yPct: 72 },
          { xPct: 78, yPct: 68 }
        ];
        const tPerc = targets[quadrant];
        tPerc.x += (Math.random() - 0.5) * 8;
        tPerc.y += (Math.random() - 0.5) * 8;
        const targetX = Math.round(window.innerWidth * (tPerc.x / 100));
        const targetY = Math.round(window.innerHeight * (tPerc.y / 100));
        const dx = targetX - startX;
        const dy = targetY - startY;
        const spin = (Math.random() < 0.5 ? 18 : -18);
        mascotImg.style.transition = 'transform 1000ms cubic-bezier(.22,.85,.32,1), opacity 1000ms ease';
        requestAnimationFrame(() => {
          mascotImg.style.transform = `translate(${dx}px, ${dy}px) rotate(${spin}deg) scale(.96)`;
          mascotImg.style.opacity = '0.98';
        });
        await new Promise(r => setTimeout(r, 1100));
        mascotImg.style.transform = 'none';
        mascotImg.style.opacity = '1';
        mascotImg.style.left = `${Math.max(8, Math.min(targetX, window.innerWidth - mascotImg.offsetWidth - 8))}px`;
        mascotImg.style.top  = `${Math.max(8, Math.min(targetY, window.innerHeight - mascotImg.offsetHeight - 8))}px`;
        await new Promise(r => setTimeout(r, 5000));
        const returnX = Math.round(Math.max(MARGIN, Math.min(window.innerWidth - mascotImg.offsetWidth - MARGIN, tx)));
        const returnY = Math.round(Math.max(MARGIN, Math.min(window.innerHeight - mascotImg.offsetHeight - MARGIN, ty)));
        const currRect = mascotImg.getBoundingClientRect();
        const returnDx = returnX - currRect.left;
        const returnDy = returnY - currRect.top;
        mascotImg.style.transition = 'transform 1100ms cubic-bezier(.22,.85,.32,1), left 1100ms ease, top 1100ms ease';
        requestAnimationFrame(() => {
          mascotImg.style.transform = `translate(${returnDx}px, ${returnDy}px) rotate(${spin > 0 ? -spin : spin}deg) scale(1)`;
        });
        await new Promise(r => setTimeout(r, 1150));
        mascotImg.style.transform = 'none';
        mascotImg.style.left = `${returnX}px`;
        mascotImg.style.top  = `${returnY}px`;
        mascotPaused = false;
        pickTarget();
        if (!rafId) rafId = requestAnimationFrame(step);
        busy = false;
      }

      mascotImg.addEventListener('click', flyToAndReturn, { passive: true });
      mascotImg.addEventListener('touchstart', (e) => { e.preventDefault(); flyToAndReturn(); }, { passive: false });
    })();
  })();

  // Copy token address button
  $("#btn-copy")?.addEventListener("click", () => {
    navigator.clipboard.writeText(C.tokenAddress || "").then(
      () => toast("Token address copied"),
      () => toast("Copy failed")
    );
  });

  // Unwrap / enter page button
  document.getElementById("btn-unwrap")?.addEventListener("click", () => {
    const overlay = document.getElementById("entry-overlay");
    if (overlay) overlay.remove();
    try { initHalloweenCountdown(); } catch (_) { }
    try { armAmbient(); } catch (_) { }
    try { announceLastWinner(); } catch (_) { }
  });

  // -------------------------
  // Wallet plumbing (provider-agnostic)
  // -------------------------
  function getPhantomProvider() {
    const p = (window.phantom && window.phantom.solana) || window.solana;
    return (p && p.isPhantom) ? p : null;
  }
  function getSolflareProvider() { return (window.solflare && window.solflare.isSolflare) ? window.solflare : null; }
  function getBackpackProvider() { return window.backpack?.solana || null; }
  const getProviderByName = (name) => {
    name = (name || "").toLowerCase();
    const ph = (window.phantom && window.phantom.solana) || window.solana;
    if (name === "phantom" && ph?.isPhantom) return ph;
    if (name === "solflare" && window.solflare?.isSolflare) return window.solflare;
    if (name === "backpack" && window.backpack?.solana) return window.backpack.solana;
    return null;
  };

  function setWalletUIEnabled(enabled = true) {
    const qs = '#btn-connect, #btn-connect-2, #btn-openwallet, #btn-openwallet-2';
    document.querySelectorAll(qs).forEach(b => {
      if (!b) return;
      b.disabled = !enabled;
      b.setAttribute('aria-disabled', String(!enabled));
      b.classList.toggle('is-disabled', !enabled);
    });
    const modal = document.getElementById('wallet-modal');
    if (modal && !enabled) modal.hidden = true;
    window.__WALLET_DISABLED__ = !enabled;
  }
  setWalletUIEnabled(true);

  // Wallet state
  let WALLET = null;
  let PUBKEY = null;
  let CONFIG = null;

  const toBaseUnits = (human) => Math.floor(Number(human) * TEN_POW);
  const fromBaseUnits = (base) => Number(base) / TEN_POW;

  function setWalletLabels() {
    const connectBtns = $$("#btn-connect, #btn-connect-2");
    const openBtns = $$("#btn-openwallet, #btn-openwallet-2");
    if (PUBKEY) {
      const s = typeof PUBKEY === "string" ? PUBKEY : (PUBKEY.toBase58 ? PUBKEY.toBase58() : "wallet");
      const short = s.slice(0,4) + "…" + s.slice(-4);
      connectBtns.forEach(b => b && (b.textContent = "Disconnect"));
      openBtns.forEach(b => { if (!b) return; b.textContent = `Wallet (${short})`; b.hidden = false; });
    } else {
      connectBtns.forEach(b => b && (b.textContent = "Connect Wallet"));
      openBtns.forEach(b => b && (b.hidden = true));
    }
    updateDeepLinkVisibility(PUBKEY);
    refreshWalletBalance().catch(() => {});
  }

  async function ensureConfig() {
    if (!CONFIG) {
      try {
        const r = await jfetch(`${API}/config?include_balances=true`);
        CONFIG = r;
        DECIMALS = Number(CONFIG?.token?.decimals || TOKEN.decimals || 6);
        TEN_POW = 10 ** DECIMALS;
      } catch (e) {
        console.error("Failed to load /config", e);
        toast("Backend not reachable (/config). Check server.");
        throw e;
      }
    }
    return CONFIG;
  }

  async function refreshWalletBalance() {
    try {
      const wrap = document.getElementById("wallet-balance-wrap");
      const out  = document.getElementById("wallet-balance");
      if (!out) return;

      if (!PUBKEY) {
        if (wrap) wrap.hidden = true;
        out.textContent = "—";
        window.dispatchEvent(new CustomEvent("treatz-wallet-change", {
          detail: { pubkey: null, balance: 0, balanceBase: 0 }
        }));
        return;
      }

      await ensureConfig();
      const mint  = new PublicKey(CONFIG.token.mint);
      const owner = new PublicKey(PUBKEY);
      const tokenProgramId = await getTokenProgramForMint(mint);
      const ata   = getAssociatedTokenAddressSync(mint, owner, true, tokenProgramId);

      let ui = 0;
      try {
        const bal = await connection.getTokenAccountBalance(ata, "confirmed");
        ui = Number(bal?.value?.uiAmount || 0);
      } catch {
        ui = 0;
      }

      out.textContent = ui.toLocaleString(undefined, { maximumFractionDigits: 0 });
      if (wrap) wrap.hidden = false;

      window.dispatchEvent(new CustomEvent("treatz-wallet-change", {
        detail: { pubkey: PUBKEY, balance: ui, balanceBase: Math.floor(ui * TEN_POW) }
      }));
    } catch (e) {
      console.warn("refreshWalletBalance failed", e);
    }
  }
  window.refreshWalletBalance = refreshWalletBalance;

  // Minimal connect toggles
  $$("#btn-connect, #btn-connect-2").forEach(btn => btn?.addEventListener("click", async () => {
    try {
      if (PUBKEY) {
        try { await WALLET?.disconnect?.(); } catch {}
        PUBKEY = null; WALLET = null;
        window.PUBKEY = null;
        window.provider = null;
        window.WALLET = null;
        setWalletLabels();
        toast("Disconnected");
        return;
      }

      const present = [
        getPhantomProvider() && "phantom",
        getSolflareProvider() && "solflare",
        getBackpackProvider() && "backpack",
      ].filter(Boolean);

      if (present.length === 1) {
        const name = present[0], p = getProviderByName(name);
        try {
          if (p && p.connect) {
            window.provider = p;
            window.WALLET = p;
            const res = await p.connect({ onlyIfTrusted: false }).catch(() => null);
            const resolved = (res?.publicKey?.toString?.() || p.publicKey?.toString?.() || window.solana?.publicKey?.toString?.() || null);
            if (resolved) {
              PUBKEY = resolved;
              WALLET = p;
              window.PUBKEY = PUBKEY;
              window.WALLET = WALLET;
              window.provider = p;
              window.walletPlumbingReady = !!PUBKEY && !!p;
              if (typeof p.on === 'function') {
                try {
                  p.on('connect', (pk) => {
                    const s = (pk && pk.toString && pk.toString()) || (p.publicKey && p.publicKey.toString && p.publicKey.toString()) || null;
                    PUBKEY = s; window.PUBKEY = s;
                    window.walletPlumbingReady = !!s;
                    setWalletLabels();
                  });
                  p.on('disconnect', () => {
                    PUBKEY = null; WALLET = null;
                    window.PUBKEY = null; window.WALLET = null; window.provider = null; window.walletPlumbingReady = false;
                    setWalletLabels();
                  });
                } catch {}
              }
              setWalletLabels();
              toast("Wallet connected");
              return;
            }
          }
        } catch (e) { console.warn("wallet connect failed", e); }
      }

      const modal = document.getElementById("wallet-modal");
      if (modal) modal.hidden = false;
    } catch (err) { console.error("[btn-connect] error", err); alert(err?.message || "Failed to open wallet."); }
  }));

  // Wallet modal menu
  const menu = document.getElementById("wallet-menu") || document.querySelector(".wm__list");
  menu?.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-wallet]");
    if (!b) return;
    const w = b.getAttribute("data-wallet");
    const modal = document.getElementById("wallet-modal");
    if (modal) modal.hidden = true;

    (async () => {
      try {
        const p = getProviderByName(w);
        if (p && p.connect) {
          window.provider = p;
          window.WALLET = p;
          const res = await p.connect({ onlyIfTrusted: false }).catch(() => null);
          const got =
            (res?.publicKey?.toString?.() ||
              p.publicKey?.toString?.() ||
              window.solana?.publicKey?.toString?.() ||
              null);
          PUBKEY = got;
          WALLET = p;
          window.PUBKEY = PUBKEY;
          window.WALLET = WALLET;
          window.provider = p;
          window.walletPlumbingReady = !!PUBKEY && !!p;

          if (typeof p.on === 'function') {
            try {
              p.on('connect', (pk) => {
                const s = (pk && pk.toString && pk.toString()) || (p.publicKey && p.publicKey.toString && p.publicKey.toString()) || null;
                PUBKEY = s; window.PUBKEY = s; window.walletPlumbingReady = !!s;
                setWalletLabels();
              });
              p.on('disconnect', () => {
                PUBKEY = null; WALLET = null;
                window.PUBKEY = null; window.WALLET = null; window.provider = null; window.walletPlumbingReady = false;
                setWalletLabels();
              });
            } catch {}
          }

          setWalletLabels();
          toast("Wallet connected");
        } else {
          if (w === "phantom") window.open("https://phantom.app/", "_blank");
        }
      } catch (e) { console.error("connect from modal failed", e); toast("Wallet connect failed"); }
    })();
  });

  // Hydrate provider on load (trusted connection)
  (function hydrateProviderOnLoad() {
    try {
      const p = getPhantomProvider() || getSolflareProvider() || getBackpackProvider() || window.solana;
      const foundPk = p?.publicKey || window.solana?.publicKey;
      if (p && foundPk) {
        const s = (p.publicKey && typeof p.publicKey.toString === 'function' && p.publicKey.toString()) ||
                  (window.solana?.publicKey && typeof window.solana.publicKey.toString === 'function' && window.solana.publicKey.toString()) ||
                  null;
        if (s) {
          PUBKEY = s; WALLET = p;
          window.PUBKEY = s; window.WALLET = p; window.provider = p;
          window.walletPlumbingReady = true;
          setWalletLabels();
          console.log("[TREATZ] hydrated provider on load ->", s);

          if (typeof p.on === 'function') {
            try {
              p.on('connect', (pk) => {
                const str = (pk && typeof pk.toString === 'function' && pk.toString()) ||
                            (p.publicKey && typeof p.publicKey.toString === 'function' && p.publicKey.toString()) || null;
                PUBKEY = str; window.PUBKEY = str; window.walletPlumbingReady = !!str; setWalletLabels();
              });
              p.on('disconnect', () => {
                PUBKEY = null; WALLET = null; window.PUBKEY = null; window.WALLET = null; window.provider = null; window.walletPlumbingReady = false;
                setWalletLabels();
              });
            } catch {}
          }
        }
      }
    } catch {}
  })();

  // -------------------------
  // Ticker (faux feed)
  // -------------------------
  (function initCoinFlipTicker() {
    const el = document.getElementById("fomo-ticker");
    if (!el) return;
    const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const randFrom = (arr) => arr[randInt(0, arr.length - 1)];
    const randWallet = () => {
      const n = () => Array.from({ length: 4 }, () => randFrom(ALPH)).join("");
      return `${n()}…${n()}`;
    };
    const fmt = (n) => n.toLocaleString();
    function makeLine() {
      const who = randWallet();
      const isWin = Math.random() < 0.58;
      const amounts = [5000, 10000, 25000, 50000, 75000, 100000, 150000, 250000, 500000];
      const amount = amounts[randInt(0, amounts.length - 1)];
      const verb = isWin ? "won" : "lost";
      const emoji = isWin ? "🎉" : "💀";
      const cls = isWin ? "tick-win" : "tick-loss";
      return `<span class="ticker__item ${cls}">${who} ${verb} ${fmt(amount)} $TREATZ ${emoji}</span>`;
    }
    function buildBatch(len = 30) {
      const lines = [];
      for (let i = 0; i < len; i++) lines.push(makeLine());
      return lines.concat(lines.slice(0, 8)).join("<span class='ticker-sep' aria-hidden='true'> • </span>") + "<span class='ticker-sep' aria-hidden='true'> • • </span>";
    }
    function render() {
      let rail = document.getElementById("ticker-rail");
      if (!rail) {
        rail = document.createElement("div");
        rail.id = "ticker-rail";
        rail.className = "ticker__rail";
        el.appendChild(rail);
      }
      rail.innerHTML = buildBatch(28) + " • ";
    }
    render();
    setInterval(render, 25000);
  })();

  // -------------------------
  // Player stats loader (requires PUBKEY)
  // -------------------------
  async function loadPlayerStats() {
    const panel = document.getElementById("player-stats");
    if (!panel) return;
    if (!PUBKEY) { panel.hidden = true; return; }
    try {
      await ensureConfig();
      const cur = await jfetch(`${API}/rounds/current`);
      const entries = await jfetch(`${API}/rounds/${cur.round_id}/entries`).catch(() => []);
      const me = String(PUBKEY).toLowerCase();
      const you = (entries || []).filter(e => {
        const u = (e.user || e.user_pubkey || e.address || "").toString().toLowerCase();
        return u === me;
      });
      const yourTickets = you.reduce((s, e) => s + Number(e.tickets || 0), 0);
      let credit = 0, spent = 0, won = 0;
      try { const c = await jfetch(`${API}/credits/${PUBKEY}`); credit = Number(c?.credit || 0); } catch {}
      $("#ps-tickets")?.replaceChildren(document.createTextNode(yourTickets.toLocaleString()));
      $("#ps-credit")?.replaceChildren(document.createTextNode((credit / TEN_POW).toLocaleString()));
      $("#ps-spent")?.replaceChildren(document.createTextNode((spent / TEN_POW).toLocaleString()));
      $("#ps-won")?.replaceChildren(document.createTextNode((won / TEN_POW).toLocaleString()));
      panel.hidden = false;
    } catch (e) { console.error("loadPlayerStats", e); }
  }
  setInterval(loadPlayerStats, 15000);

  // -------------------------
  // SPL token helpers
  // -------------------------
  async function getOrCreateATA(owner, mintPk, payer) {
    const ownerPk   = new PublicKey(owner);
    const mintPkObj = new PublicKey(mintPk);
    const tokenProgramId = await getTokenProgramForMint(mintPkObj);
    const ata = getAssociatedTokenAddressSync(
      mintPkObj,
      ownerPk,
      true,
      tokenProgramId
    );
    const info = await connection.getAccountInfo(ata, "confirmed");
    if (info) {
      return { ata, ix: null, tokenProgramId };
    }
    const ix = createAssociatedTokenAccountIdempotentInstruction(
      new PublicKey(payer),
      ata,
      ownerPk,
      mintPkObj,
      tokenProgramId
    );
    return { ata, ix, tokenProgramId };
  }

  const MEMO_PROGRAM_ID_STR = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
  function memoIx(memoStr) {
    const data = new TextEncoder().encode(memoStr);
    return new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_ID_STR),
      keys: [],
      data,
    });
  }

  async function sendSignedTransaction(tx) {
    const provider = WALLET || getInjectedProvider();
    if (!provider) throw new Error("WALLET_NOT_FOUND");
    const payerPk =
      provider.publicKey ||
      (PUBKEY && new PublicKey(PUBKEY)) ||
      tx.feePayer;
    await ensureBlockhashAndPayer(connection, tx, payerPk);

    if (typeof provider.transact === "function") {
      const res = await provider.transact(async (w) => w.signAndSendTransaction(tx));
      return res?.signature || res;
    }
    if (typeof provider.signAndSendTransaction === "function") {
      const res = await provider.signAndSendTransaction(tx);
      return res?.signature || res;
    }
    if (typeof provider.signTransaction === "function") {
      const signed = await provider.signTransaction(tx);
      const raw = signed.serialize();
      const sig = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
      try { await connection.confirmTransaction(sig, "confirmed"); } catch {}
      return sig;
    }
    if (typeof provider.sendTransaction === "function") {
      const sig = await provider.sendTransaction(tx, connection);
      try { await connection.confirmTransaction(sig, "confirmed"); } catch {}
      return sig;
    }
    throw new Error("WALLET_NO_SEND_METHOD");
  }

  // -------------------------
  // Coin flip UI
  // -------------------------
  (function wireCoinFlipUI() {
    function getSpinMs() {
      const coin = document.getElementById("coin") || document.querySelector(".coin");
      if (!coin) return 1600;
      const s = getComputedStyle(coin).animationDuration || "1.6s";
      const n = parseFloat(s) || 1.6;
      return /ms$/i.test(s) ? n : n * 1000;
    }

    function simulateFlip() {
      const coin = document.getElementById("coin") || document.querySelector(".coin");
      if (coin) { coin.classList.remove("spin"); void coin.offsetWidth; coin.classList.add("spin"); }

      const form = document.getElementById("bet-form");
      const side = (form ? (new FormData(form)).get("side") : null) || "TRICK";

      setTimeout(() => {
        try {
          const landedTreat = Math.random() < 0.5;
          const landed = landedTreat ? "TREAT" : "TRICK";
          const chosen = String(side || "TRICK").toUpperCase();
          const win = (landed === chosen);

          if (coin) {
            coin.classList.remove("spin", "coin--show-trick", "coin--show-treat");
            coin.classList.add(landedTreat ? "coin--show-treat" : "coin--show-trick");
            void coin.offsetWidth;
          }
          try { setCoinVisual(landed); } catch (err) { console.warn("setCoinVisual failed", err); }
          try { playResultFX(landed); } catch (err) { console.warn("playResultFX failed", err); }
          try { showWinBanner(win ? `${landed} — YOU WIN! 🎉` : `${landed} — YOU LOSE 💀`); } catch (err) {}

          const statusEl = document.getElementById("cf-status");
          if (statusEl) {
            statusEl.textContent = (win ? `WIN — ${landed}` : `LOSS — ${landed}`);
            statusEl.setAttribute("role", "status");
            statusEl.setAttribute("aria-live", "polite");
          }
          if (window.__TREATZ_DEBUG) {
            console.log("[TREATZ] (SIM) coin flip result:", { chosen, landed, win });
          }
        } catch (err) {
          console.error("coin flip settle handler error", err);
        }
      }, getSpinMs());
    }

    async function handleFlip(e) {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      try {
        const connected = !!(window.PUBKEY || window.WALLET || (typeof PUBKEY !== "undefined" && PUBKEY));
        const canTransact = connected && !!(window.WALLET || (typeof WALLET !== "undefined" && WALLET));
        if (canTransact) {
          await placeCoinFlip();
        } else {
          toast("Simulating — connect wallet to play for real");
          simulateFlip();
        }
      } catch (err) {
        console.error("flip handler error", err);
        alert(err?.message || "Failed to place bet.");
      }
    }

    window.flipNow = handleFlip;

    const selectors = [
      "#cf-play",
      "#cf-place",
      "#flip-now",
      ".cf__play",
      'button[name="flip"]',
      '[data-action="flip"]'
    ];

    let bound = false;
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(btn => {
        if (!btn || btn.__treatzFlipBound) return;
        btn.addEventListener("click", handleFlip, { passive: false });
        btn.__treatzFlipBound = true;
        bound = true;
      });
    }

    const betForm = document.getElementById("bet-form");
    if (betForm && !betForm.__treatzFlipBound) {
      betForm.addEventListener("submit", handleFlip, { passive: false });
      betForm.__treatzFlipBound = true;
      bound = true;
    }

    if (!bound) {
      document.addEventListener("click", (e) => {
        const btn = e.target.closest?.('[data-action="flip"], #cf-play, #cf-place, #flip-now, .cf__play, button[name="flip"]');
        if (btn) handleFlip(e);
      }, { passive: false });
    }
  })();

  // placeCoinFlip: full backend flow when wallet available
  async function placeCoinFlip() {
    try {
      console.log("[TREATZ][diag] placeCoinFlip start", {
        PUBKEY,
        WALLET,
        windowPUBKEY: window.PUBKEY,
        provider: !!window.provider,
        can_signTx: !!(WALLET && (WALLET.signTransaction || WALLET.signAndSendTransaction || WALLET.sendTransaction)),
        providerEvents: typeof (WALLET?.on) === 'function'
      });

      await ensureConfig();
      if (!PUBKEY) throw new Error("Wallet not connected");
      if (!window.solanaWeb3 || !window.splToken || !WALLET) throw new Error("Wallet libraries not loaded");
      const amountHuman = Number(document.getElementById("bet-amount").value || "0");
      const side = (new FormData(document.getElementById("bet-form"))).get("side") || "TRICK";
      if (!amountHuman || amountHuman <= 0) throw new Error("Enter a positive amount.");

      const bet = await jfetch(`${API}/bets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: Math.floor(amountHuman * TEN_POW), side })
      });
      const betId = bet.bet_id;
      $("#bet-deposit")?.replaceChildren(document.createTextNode(bet.deposit));
      $("#bet-memo")?.replaceChildren(document.createTextNode(bet.memo));

      {
        const edge = document.getElementById("edge-line");
        if (edge && bet.server_seed_hash) {
          edge.textContent = `Commit: ${bet.server_seed_hash.slice(0, 12)}… (revealed on settle)`;
        }
      }

      const mintPk = new PublicKey(CONFIG.token.mint);

      let destAtaPk, createDestIx = null;
      if (CONFIG.vaults?.game_vault_ata) {
        destAtaPk = new PublicKey(CONFIG.vaults.game_vault_ata);
      } else {
        const vaultOwner =
          CONFIG.vaults?.game_vault ||
          CONFIG.vaults?.game_owner ||
          CONFIG.vaults?.receiver;
        if (!vaultOwner) throw new Error("Vault owner not configured");
        const got = await getOrCreateATA(vaultOwner, mintPk, new PublicKey(PUBKEY));
        destAtaPk = got.ata;
        createDestIx = got.ix;
      }

      const payerRaw = PUBKEY;
      const payerPub = (typeof payerRaw === "string") ? new PublicKey(payerRaw) : payerRaw;

      const { ata: computedAta, ix: createSrc, tokenProgramId } =
        await getOrCreateATA(payerPub, mintPk, payerPub);

      let realSrc = computedAta;

      const found = await connection.getTokenAccountsByOwner(
        payerPub,
        { mint: mintPk },
        "confirmed"
      ).catch(() => null);

      if (found?.value?.length) {
        let best = { pubkey: computedAta, amt: -1 };
        for (const it of found.value) {
          const b = await connection.getTokenAccountBalance(it.pubkey, "confirmed").catch(() => null);
          const amt = Number(b?.value?.uiAmount ?? 0);
          if (amt > best.amt) best = { pubkey: it.pubkey, amt };
        }
        realSrc = best.pubkey;
      }

      const bal = await connection.getTokenAccountBalance(realSrc, "confirmed").catch(() => null);
      const uiBal = Number(bal?.value?.uiAmount || 0);
      const needHuman = Number(amountHuman);
      if (uiBal < needHuman) {
        toast(`Insufficient ${TOKEN.symbol}: have ${uiBal.toLocaleString()}, need ${needHuman.toLocaleString()}`);
        return;
      }

      try {
        const info = await connection.getParsedAccountInfo(realSrc, "confirmed");
        const ownerStr = info?.value?.data?.parsed?.info?.owner;
        if (ownerStr && ownerStr !== payerPub.toBase58()) {
          throw new Error("Token account is not owned by connected wallet");
        }
      } catch {}

      const ixs = [];
      if (createSrc) ixs.push(createSrc);
      if (createDestIx) ixs.push(createDestIx);
      const amountBase = BigInt(Math.floor(amountHuman * TEN_POW)); // bigint ✅
      ixs.push(
        createTransferCheckedInstruction(
          realSrc,
          mintPk,
          destAtaPk,
          payerPub,
          amountBase, // bigint ✅
          DECIMALS,
          [],
          tokenProgramId
        ),
        memoIx(bet.memo)
      );

      const bh = (await jfetch(`${API}/cluster/latest_blockhash`)).blockhash;
      const tx = new Transaction({ feePayer: payerPub });
      tx.recentBlockhash = bh;
      tx.add(...ixs);
      const signature = await sendSignedTransaction(tx);
      $("#cf-status")?.replaceChildren(document.createTextNode(signature ? `Sent: ${signature.slice(0, 10)}…` : "Sent"));
      const coin = $("#coin");
      if (coin) { coin.classList.remove("spin"); void coin.offsetWidth; coin.classList.add("spin"); }
      pollBetUntilSettle(betId).catch(() => { });
    } catch (e) {
      console.error(e);
      alert(e.message || "Bet failed.");
    }
  }

  async function pollBetUntilSettle(betId, timeoutMs = 45_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const b = await jfetch(`${API}/bets/${betId}`);
        if ((b.status || "").toUpperCase() === "SETTLED") {
          const win = !!b.win;
          const result = win ? "TREAT" : "TRICK";

          setCoinVisual(result);
          playResultFX(result);
          showWinBanner(win ? "🎉 TREATZ! You win!" : "💀 TRICKZ! Maybe next time…");

          $("#cf-status")?.replaceChildren(document.createTextNode(win ? "WIN!" : "LOSS"));
          return;
        }
      } catch {}
    }
    $("#cf-status")?.replaceChildren(document.createTextNode("Waiting for network / webhook…"));
  }

  $("#cf-place")?.addEventListener("click", (e) => { e.preventDefault(); placeCoinFlip().catch(() => {}); });

  function showWinBanner(text) {
    try {
      const el = document.createElement("div");
      el.textContent = text;
      Object.assign(el.style, {
        position: "fixed", left: "50%", top: "18px", transform: "translateX(-50%)",
        background: "linear-gradient(90deg,#2aff6b,#9bff2a)",
        color: "#032316", padding: "10px 14px", fontWeight: "900",
        borderRadius: "999px", zIndex: 10000, boxShadow: "0 8px 24px rgba(0,0,0,.35)"
      });
      document.body.appendChild(el);
      setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .35s"; setTimeout(() => el.remove(), 400); }, 1800);
    } catch (e) { console.warn("showWinBanner failed", e); }
  }

  // ==========================
  // Wheel of Fate — Frontend
  // ==========================
  (function initWheel() {
    const API = (window.TREATZ_CONFIG?.apiBase || "/api").replace(/\/$/, "");
    const DECIMALS = Number(window.TREATZ_CONFIG?.token?.decimals || 6);
    const TEN = 10 ** DECIMALS;

    // DOM refs
    const elSvg = document.getElementById("wheel-svg");
    const elSpin = document.getElementById("wheel-spin");
    const elFreeBtn = document.getElementById("wheel-freespin");
    const elPrice = document.getElementById("wheel-price");
    const elPriceBtn = document.getElementById("wheel-price-btn");
    const elCommit = document.getElementById("wheel-commit");
    const elToast = document.getElementById("wheel-toast");
    const elFree = document.getElementById("wheel-free");
    const elStatus = document.getElementById("wheel-status");
    const elConnect = document.getElementById("wheel-connect");
    const elOpenPh = document.getElementById("wheel-open-in-phantom");
    const elAddr    = document.getElementById("wheel-addr");
    const elMode    = document.getElementById("wheel-mode");
    const elHist = document.getElementById("wheel-history");
    const elHistList = document.getElementById("wheel-history-list");

    if (!elSvg || !elSpin) return;

    // Prize model
    const PRIZES = [
      { label:"💀 Ghosted",           type:"loss", amount:0,        w:0.16 },
      { label:"🕸️ Cobwebs",           type:"loss", amount:0,        w:0.12 },
      { label:"🧟 Haunted Detour",    type:"loss", amount:0,        w:0.10 },
      { label:"🕯️ Candle Went Out",  type:"loss", amount:0,        w:0.08 },
      { label:"🎃 Pumpkin Smash",     type:"loss", amount:0,        w:0.06 },
      { label:"🧙‍♀️ Witch Tax",       type:"loss", amount:0,        w:0.04 },
      { label:"👻 Phantom Fees",      type:"loss", amount:0,        w:0.02 },

      { label:"🍬 50,000",            type:"win",  amount:50_000,    w:0.09 },
      { label:"🍬 100,000",           type:"win",  amount:100_000,   w:0.07 },
      { label:"🍬 250,000",           type:"win",  amount:250_000,   w:0.05 },
      { label:"🍬 500,000",           type:"win",  amount:500_000,   w:0.04 },
      { label:"🍬 1,000,000",         type:"win",  amount:1_000_000, w:0.03 },
      { label:"🍬 2,000,000",         type:"win",  amount:2_000_000, w:0.02 },

      { label:"🎁 Free Spin x1",      type:"free", amount:0,         w:0.08, free:1 },
      { label:"🎁 Free Spin x2",      type:"free", amount:0,         w:0.03, free:2 },
      { label:"🎁 Free Spin x3",      type:"free", amount:0,         w:0.01, free:3 },
    ];

    // Draw wheel slices
    function drawWheel() {
      const cx=200, cy=200, r=190;
      elSvg.innerHTML = "";
      const sumW = PRIZES.reduce((s,p)=>s+p.w,0);
      let a0 = -Math.PI/2;
      PRIZES.forEach((p)=>{
        const a1 = a0 + 2*Math.PI*(p.w/sumW);
        const x0 = cx + r*Math.cos(a0), y0 = cy + r*Math.sin(a0);
        const x1 = cx + r*Math.cos(a1), y1 = cy + r*Math.sin(a1);
        const large = (a1-a0) > Math.PI ? 1:0;
        const path = document.createElementNS("http://www.w3.org/2000/svg","path");
        path.setAttribute("d", `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`);
        path.setAttribute("class", p.type === "win" ? "slice-win" : (p.type==="free"?"slice-free":"slice-loss"));
        elSvg.appendChild(path);

        const am = (a0+a1)/2, lr = r*0.68;
        const lx = cx + lr*Math.cos(am), ly = cy + lr*Math.sin(am);
        const t = document.createElementNS("http://www.w3.org/2000/svg","text");
        t.setAttribute("x", lx.toFixed(1));
        t.setAttribute("y", ly.toFixed(1));
        t.setAttribute("class","slice-label");
        t.textContent = p.label;
        elSvg.appendChild(t);

        a0 = a1;
      });
      const ring = document.createElementNS("http://www.w3.org/2000/svg","circle");
      ring.setAttribute("cx",cx); ring.setAttribute("cy",cy); ring.setAttribute("r",r-6);
      ring.setAttribute("stroke","rgba(106,0,255,.45)"); ring.setAttribute("stroke-width","8"); ring.setAttribute("fill","none");
      ring.setAttribute("class","wheel-glow");
      elSvg.appendChild(ring);
    }
    drawWheel();

    // Wallet UI state
    function short(k) { return k ? (k.slice(0,4) + "…" + k.slice(-4)) : ""; }
    function updateWheelWalletUI() {
      const connected = !!(window.PUBKEY && window.WALLET);
      if (connected) {
        elConnect.hidden = true;
        elAddr.hidden = false;
        elAddr.textContent = short(PUBKEY);
        elOpenPh.hidden = false;
        try { elOpenPh.href = `https://phantom.app/ul/browse/${location.origin}`; } catch {}
        elMode.textContent = "On-chain mode";
      } else {
        elConnect.hidden = false;
        elAddr.hidden = true;
        elOpenPh.hidden = true;
        elMode.textContent = "Simulated (no wallet)";
      }
    }
    updateWheelWalletUI();
    window.addEventListener("wallet:connected", updateWheelWalletUI);
    window.addEventListener("wallet:disconnected", updateWheelWalletUI);
    elConnect?.addEventListener("click", () => {
      const globalBtn = document.getElementById("btn-connect");
      if (globalBtn) globalBtn.click(); else window.open("https://phantom.app/", "_blank", "noopener");
    });

    // price label (from config; fallback to 100k)
    try {
      const envPrice = Number(window.TREATZ_CONFIG?.wheelPrice || 100_000);
      const txt = envPrice.toLocaleString();
      if (elPrice) elPrice.textContent = txt;
      if (elPriceBtn) elPriceBtn.textContent = txt;
    } catch (e) {
      // ignore
    }

    // toasts + history helpers
    function toastWheel(msg) {
      elToast.hidden = false;
      elToast.textContent = msg;
      setTimeout(()=>{ elToast.hidden = true; }, 4000);
    }
    function pushHistory(line) {
      elHist.hidden = false;
      const li = document.createElement("li");
      li.textContent = line;
      elHistList.prepend(li);
      while (elHistList.children.length > 10) elHistList.lastChild.remove();
    }

    // credit poller
    async function refreshWheelCredit() {
      try {
        if (!window.PUBKEY) { elFree.textContent = "0"; return; }
        const r = await fetch(`${API}/credits/${window.PUBKEY}`).then(r=>r.json());
        elFree.textContent = String(Number(r?.credit||0));
      } catch {}
    }
    setInterval(refreshWheelCredit, 12000);
    document.addEventListener("DOMContentLoaded", refreshWheelCredit);

    // animation math
    function spinToLabel(label) {
      const sumW = PRIZES.reduce((s,p)=>s+p.w,0);
      let a0 = -Math.PI/2;
      let targetAngle = 0;
      for (const p of PRIZES) {
        const a1 = a0 + 2*Math.PI*(p.w/sumW);
        if (p.label === label) {
          const am = (a0+a1)/2;
          targetAngle = (Math.PI*1.5) - am;
          break;
        }
        a0 = a1;
      }
      const turns = 6 + Math.random()*2;
      const deg = (turns*360) + (targetAngle*180/Math.PI);
      elSvg.classList.add("spinning");
      elSvg.style.transform = `rotate(${deg.toFixed(2)}deg)`;
    }

    function resultLine(outcome) {
      const msgsWin = [
        "TREATZ rain from the crypt! 🍬",
        "Summoned a sweet pump. 🎉",
        "Full-size bar unlocked! 🟩",
      ];
      const msgsLoss = [
        "Ghosts snatched your candy. 💀",
        "Cobwebs only… try again? 🕸️",
        "The cauldron cackles. 🧪",
      ];
      const msgsFree = [
        "A witch slips you a free spin. 🧙‍♀️",
        "The moon smiles—free spin granted. 🌕",
      ];
      if (outcome.type === "win") return `${outcome.label} — ${msgsWin[Math.floor(Math.random()*msgsWin.length)]}`;
      if (outcome.type === "free") return `${outcome.label} — ${msgsFree[Math.floor(Math.random()*msgsFree.length)]}`;
      return `${outcome.label} — ${msgsLoss[Math.floor(Math.random()*msgsLoss.length)]}`;
    }

    // polling for paid spin settlement
    async function pollSpin(spinId, timeoutMs=45000) {
      const t0 = Date.now();
      while (Date.now()-t0 < timeoutMs) {
        await new Promise(r=>setTimeout(r,1200));
        try {
          const s = await fetch(`${API}/wheel/spins/${spinId}`).then(r=>r.json());
          if ((s.status||"").toUpperCase()==="SETTLED") {
            const outcome = { label:s.outcome_label, type: (s.prize_amount>0?"win": (s.free_spins>0?"free":"loss")), amount:s.prize_amount||0, free:s.free_spins||0 };
            spinToLabel(outcome.label);
            setTimeout(()=>{
              try { playResultFX(outcome.type==="loss"?"LOSS":"WIN"); } catch{}
              toastWheel(resultLine(outcome));
              elStatus.textContent = outcome.type==="win" ? `WIN — ${outcome.label}` : (outcome.type==="free" ? `FREE — ${outcome.label}` : `LOSS — ${outcome.label}`);
              refreshWheelCredit();
              const amt = outcome.amount ? ` +${(outcome.amount / TEN).toLocaleString()} $TREATZ` : "";
              const fs  = outcome.free   ? ` +${outcome.free} free` : "";
              pushHistory(`[PAID] ${outcome.label}${amt}${fs}`);
            }, 4600);
            return;
          }
        } catch {}
      }
      toastWheel("Settlement taking longer than usual. Check history later.");
    }

    // simulate (no wallet)
    function simulateSpin() {
      const sumW = PRIZES.reduce((s,p)=>s+p.w,0);
      let r = Math.random()*sumW, pick = PRIZES[0];
      for (const p of PRIZES) { r -= p.w; if (r <= 0) { pick = p; break; } }
      elSvg.classList.add("spinning");
      spinToLabel(pick.label);
      setTimeout(()=>{
        try { playResultFX(pick.type==="loss"?"LOSS":"WIN"); } catch{}
        toastWheel(resultLine(pick));
        elStatus.textContent = (pick.type==="win" ? `WIN — ${pick.label}` : (pick.type==="free" ? `FREE — ${pick.label}` : `LOSS — ${pick.label}`));
        const amt = pick.amount ? ` +${pick.amount.toLocaleString()} $TREATZ` : "";
        const fs  = pick.free   ? ` +${pick.free} free` : "";
        pushHistory(`[SIM] ${pick.label}${amt}${fs}`);
      }, 4600);
    }

    // paid spin (on-chain)
    async function spinOnChain() {
      elStatus.textContent = "Preparing spin…";
      const body = { client_seed: Math.random().toString(16).slice(2) };
      const spin = await fetch(`${API}/wheel/spins`, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) }).then(r=>r.json());
      elCommit.textContent = `Commit: ${spin.server_seed_hash.slice(0,12)}…`;

      const { PublicKey, Transaction } = window.solanaWeb3 || {};
      const { createTransferCheckedInstruction, getAssociatedTokenAddress } = window.splToken || {};
      if (!PublicKey || !Transaction || !createTransferCheckedInstruction) { throw new Error("Wallet libs missing"); }

      function memoIxLocal(memo) {
        const pid = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
        const data = new TextEncoder().encode(memo || "");
        return new window.solanaWeb3.TransactionInstruction({ keys: [], programId: pid, data });
      }
      async function getOrCreateATALocal(owner, mint) {
        const ata = await getAssociatedTokenAddress(mint, owner);
        return { ata, ix: null };
      }
      async function sendSignedTransactionLocal(tx) {
        if (!window.WALLET || typeof window.WALLET.signAndSendTransaction !== "function") throw new Error("No wallet connected");
        const res = await window.WALLET.signAndSendTransaction(tx);
        return res?.signature || res;
      }
      async function jfetchLocal(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }

      const mintPk = new PublicKey(window.TREATZ_CONFIG?.token?.mint || "11111111111111111111111111111111");
      const payerPub = new PublicKey(window.PUBKEY);
      const dest = new PublicKey(spin.deposit);
      const { ata: srcAta } = await getOrCreateATALocal(payerPub, mintPk);
      const ixs = [
        createTransferCheckedInstruction(srcAta, mintPk, dest, payerPub, BigInt(spin.amount), DECIMALS),
        memoIxLocal(spin.memo)
      ];
      const bh = (await jfetchLocal(`${API}/cluster/latest_blockhash`)).blockhash;
      const tx = new Transaction({ feePayer: payerPub, recentBlockhash: bh });
      tx.add(...ixs);
      await sendSignedTransactionLocal(tx);

      elSvg.classList.add("spinning");
      elSvg.style.transform = `rotate(${(720).toFixed(2)}deg)`;
      pollSpin(spin.spin_id).catch(()=>{});
    }

    // Free spin via API (requires connected wallet)
    async function doFreeSpin() {
      if (!window.PUBKEY) { toastWheel("Connect wallet to use free spins."); return; }
      try {
        elFreeBtn.disabled = true;
        elSpin.disabled = true;
        elStatus.textContent = "Free spin casting…";
        elSvg.classList.add("spinning");
        elSvg.style.transform = `rotate(${(540).toFixed(2)}deg)`;

        const body = { wallet: window.PUBKEY, client_seed: Math.random().toString(16).slice(2) };
        const r = await fetch(`${API}/wheel/spins/free`, {
          method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body)
        }).then(r=>r.json());

        spinToLabel(r.outcome_label);
        setTimeout(()=>{
          const type = r.prize_amount>0 ? "win" : (r.free_spins>0 ? "free" : "loss");
          try { playResultFX(type==="loss"?"LOSS":"WIN"); } catch{}
          toastWheel(type==="win" ? `${r.outcome_label} — 🎉` : (type==="free" ? `${r.outcome_label} — 🌕` : `${r.outcome_label} — 💀`));
          elStatus.textContent = type.toUpperCase() + " — " + r.outcome_label;
          refreshWheelCredit();
          const amt = r.prize_amount ? ` +${(r.prize_amount / TEN).toLocaleString()} $TREATZ` : "";
          const fs  = r.free_spins ? ` +${r.free_spins} free` : "";
          pushHistory(`[FREE] ${r.outcome_label}${amt}${fs}`);
          elFreeBtn.disabled = false;
          elSpin.disabled = false;
        }, 4600);
      } catch (e) {
        elFreeBtn.disabled = false;
        elSpin.disabled = false;
        toastWheel("Free spin failed.");
      }
    }

    // Button handlers (simulate fallback if no wallet)
    elSpin.addEventListener("click", async (e)=>{
      e.preventDefault();
      try {
        const hasWallet = !!(window.PUBKEY && window.WALLET);
        if (hasWallet) return spinOnChain();
        toastWheel("Simulating — connect wallet to play for real.");
        simulateSpin();
      } catch (err) {
        alert(err?.message || "Spin failed.");
      }
    });
    elFreeBtn?.addEventListener("click", (e)=>{ e.preventDefault(); doFreeSpin(); });
  })();

  // -------------------------
  // Jackpot / Raffle UI
  // -------------------------
  document.getElementById("jp-buy")?.addEventListener("click", async () => {
    try {
      if (!PUBKEY && !window.PUBKEY) {
        toast("Connect wallet to buy tickets");
        const modal = document.getElementById("wallet-modal");
        if (modal) { modal.hidden = false; }
        return;
      }
      toast("Starting ticket purchase...");
      if (typeof window.startRafflePurchase === "function") {
        try {
          await window.startRafflePurchase({ tickets: 1 });
          return;
        } catch (err) { console.error("startRafflePurchase error", err); }
      }
      toast("Ticket purchase flow starting — backend action not wired in this build.");
    } catch (e) { console.error(e); alert(e?.message || "Ticket purchase failed."); }
  });

  // Safe raffle purchase helper
  window.startRafflePurchase = async function startRafflePurchase({ tickets = 1 } = {}) {
    try {
      await ensureConfig();
      const runtimePub = PUBKEY || window.PUBKEY || null;
      if (!runtimePub) throw new Error("Connect wallet to buy tickets");

      if (!WALLET && window.WALLET) WALLET = window.WALLET;
      if (!WALLET) throw new Error("Wallet provider not available to sign transaction");

      const round = await jfetch(`${API}/rounds/current`);
      const roundId = round?.round_id;
      if (!roundId) throw new Error("No active raffle round");

      const ticketBase = Number(CONFIG?.raffle?.ticket_price ?? CONFIG?.token?.ticket_price ?? 0);
      if (!ticketBase) console.warn("Ticket price not in config; will rely on purchase.amount");

      const purchase = await jfetch(`${API}/rounds/${encodeURIComponent(roundId)}/buy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tickets: Number(tickets || 1) })
      }).catch(() => null);

      if (!purchase || !purchase.memo) {
        console.warn("[TREATZ] buy endpoint returned no memo — purchase object:", purchase);
        throw new Error("Purchase API did not return required payment payload. Confirm endpoint /rounds/:id/buy exists.");
      }

      const amountBase = BigInt(purchase.amount ?? (ticketBase * Number(tickets || 1))); // bigint ✅

      $("#jp-deposit")?.replaceChildren(document.createTextNode(purchase.deposit || "—"));
      $("#jp-memo")?.replaceChildren(document.createTextNode(purchase.memo || "—"));

      const mintPk = new PublicKey(CONFIG.token.mint);

      let destAtaPk, createDestIx = null;
      if (CONFIG.vaults?.jackpot_vault_ata) {
        destAtaPk = new PublicKey(CONFIG.vaults.jackpot_vault_ata);
      } else {
        const jackpotOwner = CONFIG.vaults?.jackpot_vault || CONFIG.vaults?.jackpot_owner;
        if (!jackpotOwner) throw new Error("Jackpot vault owner not configured");
        const got = await getOrCreateATA(jackpotOwner, mintPk, new PublicKey(runtimePub));
        destAtaPk = got.ata;
        createDestIx = got.ix;
      }

      const payerPub = (typeof runtimePub === "string") ? new PublicKey(runtimePub) : runtimePub;

      const { ata: computedAta, ix: createSrc, tokenProgramId } =
        await getOrCreateATA(payerPub, mintPk, payerPub);

      let realSrc = computedAta;

      const found = await connection.getTokenAccountsByOwner(
        payerPub,
        { mint: mintPk },
        "confirmed"
      ).catch(() => null);

      if (found?.value?.length) {
        let best = { pubkey: computedAta, amt: -1 };
        for (const it of found.value) {
          const b = await connection.getTokenAccountBalance(it.pubkey, "confirmed").catch(() => null);
          const amt = Number(b?.value?.uiAmount ?? 0);
          if (amt > best.amt) best = { pubkey: it.pubkey, amt };
        }
        realSrc = best.pubkey;
      }

      const bal = await connection.getTokenAccountBalance(realSrc, "confirmed").catch(() => null);
      const haveBase = Number(bal?.value?.amount || 0);
      const needBase = Number(amountBase);
      if (haveBase < needBase) {
        const haveHuman = haveBase / (10 ** Number(DECIMALS || 6));
        const needHuman = needBase / (10 ** Number(DECIMALS || 6));
        toast(`Insufficient ${TOKEN.symbol}: have ${haveHuman.toLocaleString()}, need ${needHuman.toLocaleString()}`);
        return;
      }

      const ixs = [];
      if (createSrc) ixs.push(createSrc);
      if (createDestIx) ixs.push(createDestIx);
      ixs.push(
        createTransferCheckedInstruction(
          realSrc,
          mintPk,
          destAtaPk,
          payerPub,
          amountBase, // bigint ✅
          DECIMALS,
          [],
          tokenProgramId
        ),
        memoIx(purchase.memo || "")
      );

      const bh = (await jfetch(`${API}/cluster/latest_blockhash`)).blockhash;
      const tx = new Transaction({ feePayer: payerPub });
      tx.recentBlockhash = bh;
      tx.add(...ixs);

      const signature = await sendSignedTransaction(tx);
      if (!signature) throw new Error("Failed to send transaction");

      toast("Ticket purchase sent: " + signature.slice(0, 8) + "…");
      return signature;
    } catch (err) {
      console.error("startRafflePurchase failed", err);
      toast(err?.message || "Ticket purchase failed (see console)");
      throw err;
    }
  };

  let __recentCache = [];

  (async function initRaffleUI() {
    const errOut = (where, message) => {
      console.error(`[raffle:${where}]`, message);
      const schedule = document.getElementById("raffle-schedule");
      if (schedule) { schedule.textContent = `⚠️ ${message}`; schedule.style.color = "#ff9b9b"; }
    };
    try {
      const cfg = await jfetchStrict(`${API}/config?include_balances=true`);
      CONFIG = cfg;
      const decimals = Number(cfg?.token?.decimals ?? 6);
      DECIMALS = decimals;
      TEN_POW = 10 ** DECIMALS;
      const durationMin = Number(cfg?.raffle?.duration_minutes ?? cfg?.raffle?.round_minutes ?? 10);
      const breakMin = Number(cfg?.raffle?.break_minutes ?? 2);
      const priceBase = Number(cfg?.raffle?.ticket_price ?? cfg?.token?.ticket_price ?? 0);
      if (priceBase) {
        const human = priceBase / TEN_POW;
        const tpEl = document.getElementById("ticket-price");
        if (tpEl) tpEl.textContent = human.toLocaleString();
        window.__TREATZ_TICKET_BASE = priceBase;
        const inp = document.getElementById("jp-amount");
        const totalEl = document.getElementById("jp-total");
        const setTotal = () => {
          const t = Number(inp?.value || 1);
          if (totalEl) totalEl.textContent = (human * t).toLocaleString();
        };
        if (inp) { inp.addEventListener("input", setTotal); setTotal(); }
      }
      let round = await jfetchStrict(`${API}/rounds/current`);
      const elPot = document.getElementById("round-pot");
      const elId = document.getElementById("round-id");
      const elClose = document.getElementById("round-countdown");
      const elNext = document.getElementById("round-next-countdown");
      const elProg = document.getElementById("jp-progress");
      const schedEl = document.getElementById("raffle-schedule");
      const iso = (s) => String(s || "").replace(" ", "T").replace(/\.\d+/, "").replace(/Z?$/, "Z");
      let opensAt = new Date(iso(round.opens_at));
      let closesAt = new Date(iso(round.closes_at));
      const nextOpenIso = cfg?.timers?.next_opens_at ? iso(cfg.timers.next_opens_at) : null;
      const nextOpensAt = nextOpenIso ? new Date(nextOpenIso) : new Date(closesAt.getTime() + breakMin * 60 * 1000);
      if (elId) elId.textContent = round.round_id;
      if (elPot) elPot.textContent = (Number(round.pot || 0) / TEN_POW).toLocaleString();
      const commitEl = document.getElementById("seed-commit");
      const revealEl = document.getElementById("seed-reveal");
      if (commitEl) commitEl.textContent = round.server_seed_hash || "—";
      if (revealEl) revealEl.textContent = round.server_seed_reveal || "— (reveal after settlement)";
      if (schedEl) schedEl.textContent = `Each round: ${durationMin} min • Break: ${breakMin} min • Next opens: ${nextOpensAt.toLocaleTimeString()}`;
      const fmtClock = (ms) => {
        if (ms < 0) ms = 0;
        const s = Math.floor(ms / 1000);
        const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
        const ss = String(s % 60).padStart(2, "0");
        return `${hh}:${mm}:${ss}`;
      };
      const clamp01 = (x) => Math.max(0, Math.min(1, x));
      const tick = () => {
        const now = new Date();
        if (elClose) elClose.textContent = fmtClock(closesAt - now);
        if (elNext) elNext.textContent = fmtClock(nextOpensAt - now);
        if (elProg) {
          const total = closesAt - opensAt;
          const pct = clamp01((now - opensAt) / (total || 1)) * 100;
          elProg.style.width = `${pct}%`;
        }
      };
      tick(); setInterval(tick, 1000);
      const list = document.getElementById("recent-rounds");
      document.getElementById("jp-view-all")?.addEventListener("click", () => {
        document.getElementById("raffle-history")?.scrollIntoView({ behavior: "smooth" });
      });
      async function loadRecent() {
        if (!list) return;
        list.innerHTML = `<li class="muted">Loading…</li>`;
        try {
          const recent = await jfetchStrict(`${API}/rounds/recent?limit=6`);
          list.innerHTML = "";
          for (const r of recent) {
            const li = document.createElement("li");
            const potHuman = (Number(r.pot || 0) / TEN_POW).toLocaleString();
            const meta = [];
            if (typeof r.tickets !== "undefined") meta.push(`${r.tickets} tix`);
            if (typeof r.wallets !== "undefined") meta.push(`${r.wallets} wallets`);
            const metaStr = meta.length ? `<span class="muted small">${meta.join(" • ")}</span>` : "";
            li.innerHTML = `<span><b>${r.id || r.round_id || ''}</b> • ${potHuman} ${TOKEN.symbol}</span> ${metaStr}`;
            list.appendChild(li);
          }
          if (!recent.length) list.innerHTML = `<li class="muted">No recent rounds.</li>`;
        } catch (e) {
          console.error(e);
          list.innerHTML = `<li class="muted">Failed to load recent rounds.</li>`;
        }
      }
      await loadRecent();
      setInterval(loadRecent, 30000);

      async function refreshRound() {
        try {
          const up = await jfetchStrict(`${API}/rounds/current`);
          if (up && up.round_id && up.round_id !== round.round_id) {
            __recentCache = [];
            loadHistory();
            round = up;
            const newOpensAt = new Date(iso(round.opens_at));
            const newClosesAt = new Date(iso(round.closes_at));
            if (newOpensAt && !isNaN(newOpensAt)) opensAt = newOpensAt;
            if (newClosesAt && !isNaN(newClosesAt)) closesAt = newClosesAt;
            if (elId) elId.textContent = round.round_id;
            if (elPot) elPot.textContent = (Number(round.pot || 0) / TEN_POW).toLocaleString();
            const commitEl = document.getElementById("seed-commit");
            const revealEl = document.getElementById("seed-reveal");
            if (commitEl) commitEl.textContent = round.server_seed_hash || "—";
            if (revealEl) revealEl.textContent = round.server_seed_reveal || "— (reveal after settlement)";
          } else {
            if (up && elPot) elPot.textContent = (Number(up.pot || 0) / TEN_POW).toLocaleString();
          }
        } catch (err) { console.warn("refreshRound failed", err); }
      }
      refreshRound(); setInterval(refreshRound, 12000);
    } catch (e) { errOut("init", e.message || e); }
  })();

  // -------------------------
  // History table load
  // -------------------------
  async function loadHistory(query = "") {
    const tbody = document.querySelector("#history-table tbody"); if (!tbody) return;

    if (!__recentCache.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;
      try {
        const q = new URL(`${API}/rounds/recent`, location.origin);
        q.searchParams.set("limit", "25");
        const res = await fetch(q.toString(), { method: "GET" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        __recentCache = await res.json();
      } catch (e) {
        console.error(e);
        tbody.innerHTML = `<tr><td colspan="5" class="muted">Failed to load history from backend.</td></tr>`;
        return;
      }
    }

    const term = String(query || "").toLowerCase().trim();
    const recent = term
      ? __recentCache.filter(r => String(r.id || r.round_id || "").toLowerCase().includes(term))
      : __recentCache;

    if (!Array.isArray(recent) || recent.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted">No history.</td></tr>`;
      return;
    }

    const rows = [];
    for (const r of recent) {
      const roundId = r.id || r.round_id || r[0] || "unknown";
      let w = null;
      try { w = await jfetchStrict(`${API}/rounds/${encodeURIComponent(roundId)}/winner`); } catch (e) {}
      const potHuman = (Number(r.pot || 0) / TEN_POW).toLocaleString();
      const winner = w?.winner || "—";
      const payout = w?.payout_sig || "—";
      const proof = (w?.server_seed_hash || "-").slice(0, 10) + "…";
      rows.push(`<tr>
        <td>${roundId}</td>
        <td>${potHuman} ${TOKEN.symbol}</td>
        <td>${winner}</td>
        <td>${payout}</td>
        <td>${proof}</td>
      </tr>`);
    }
    tbody.innerHTML = rows.join("") || `<tr><td colspan="5" class="muted">No history.</td></tr>`;
  }

  document.getElementById("history-search")?.addEventListener("input", (e) => {
    const q = e.target.value;
    clearTimeout(window.__rf_hist_timer);
    window.__rf_hist_timer = setTimeout(() => loadHistory(q), 200);
  });
  loadHistory();

  (async () => {
    try {
      await ensureConfig();
      if (CONFIG?.raffle?.splits) {
        const s = CONFIG.raffle.splits || {};
        const pct = (x) => {
          const n = Number(x || 0);
          return !isFinite(n) ? 0 : (n <= 1 ? n * 100 : n);
        };
        const winner = pct(s.winner);
        const dev    = pct(s.dev);
        const burn   = pct(s.burn);
        const protocol = Math.max(0, dev + burn);
        const el = document.getElementById("edge-line");
        if (el) {
          el.textContent = `Protocol fee: ${protocol.toFixed(2)}% — Splits: ${winner.toFixed(2)}% winner • ${burn.toFixed(2)}% burn • ${dev.toFixed(2)}% dev`;
        }
      }
    } catch (e) { console.warn("could not load fee/splits info", e); }
  })();

  async function announceLastWinner() {
    try {
      const recent = await jfetch(`${API}/rounds/recent?limit=1`);
      const rid = recent?.[0]?.id; if (!rid) return;
      const w = await jfetch(`${API}/rounds/${rid}/winner`);
      if (w?.winner) {
        toast(`Winner: ${w.winner.slice(0, 4)}… — Pot ${fmtUnits(w.pot, DECIMALS)} ${TOKEN.symbol}`);
      }
    } catch (e) { console.error(e); }
  }

  // -------------------------
  // Ambient audio arm
  // -------------------------
  function armAmbient() {
    const a = document.getElementById("bg-ambient");
    if (!a) return;
    if (!a.src) {
      const cfgSrc = (window.TREATZ_CONFIG?.assets?.ambient) || a.getAttribute("data-src") || "/static/assets/ambient_loop.mp3";
      a.src = cfgSrc;
    }
    a.muted = true; a.volume = 0; a.loop = true;
    const start = async () => {
      try { await a.play(); } catch {}
      a.muted = false;
      let v = 0, tgt = 0.12;
      const fade = () => { v = Math.min(tgt, v + 0.02); a.volume = v; if (v < tgt) requestAnimationFrame(fade); };
      requestAnimationFrame(fade);
      ["click", "touchstart", "keydown"].forEach(evName => document.removeEventListener(evName, start));
    };
    ["click", "touchstart", "keydown"].forEach(evName => document.addEventListener(evName, start, { passive: true }));
  }
  armAmbient();

  // -------------------------
  // Back-to-top wiring & expose utilities
  // -------------------------
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#back-to-top');
    if (!b) return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const topFocus = document.querySelector('#page') || document.body;
    setTimeout(() => topFocus?.focus?.(), 600);
    e.preventDefault();
  });

  window.TREATZ = window.TREATZ || {};
  Object.assign(window.TREATZ, {
    playResultFX, rainTreatz, hauntTrick, announceLastWinner, setCoinVisual, spawnPiece
  });

  if (typeof window !== 'undefined') {
    window.setCoinVisual = setCoinVisual;
    window.setCoinFaces = setCoinFaces;
  }

  (function fxDebugWrap(){
    if (!window.playResultFX) return;
    const orig = window.playResultFX;
    window.playResultFX = function(result){
      try { console.log('[TREATZ FX] playResultFX ->', result, 'fxLayerChildren=', document.getElementById('fx-layer')?.children.length); } catch(e){}
      return orig.apply(this, arguments);
    };
  })();

  // Boot log
  document.addEventListener("DOMContentLoaded", () => { console.log("[TREATZ] Frontend initialized"); });

})();
