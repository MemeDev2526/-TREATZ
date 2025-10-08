// app.js — reorganized, resilient, complete drop-in for TREATZ
// - cleaned structure: sections for imports, shims, config, helpers, FX, countdown,
//   wallet plumbing, UI wiring, raffle/history, ambient audio, exports.
// - defensive DOM access, robust wallet APIs, no TDZ/reference errors if libs missing.
// - preserves all existing behaviors (coin flip UI, FX, mascot, ambient audio).
//
// NOTE: This is intended as a drop-in replacement for the original app.js at:
// https://github.com/MemeDev2526/-TREATZ/blob/9a0930dc1809002caca7111194c6d2c34ac27c6f/app.js

// 1) Solana + SPL Token imports (ESM)
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
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
    createAssociatedTokenAccountInstruction,
    createTransferCheckedInstruction,
  };
}

// 2) RPC connection
const RPC_URL = "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

// 3) Exported helper (used by other modules / tests)
export async function getAta(owner, mint) {
  const ownerPk = new PublicKey(owner);
  const mintPk = new PublicKey(mint);
  const ata = await getAssociatedTokenAddress(mintPk, ownerPk);
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

  // DOM helpers (defensive)
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel || ""));

  // Number formatting helpers
  let DECIMALS = Number(TOKEN.decimals || 6);
  let TEN_POW = 10 ** DECIMALS;
  const pow10 = (n) => Math.pow(10, n);
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

  // Ensure top-level to avoid transformed ancestor clipping
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

  // spawn piece primitive — robust: resolves fxRoot at call time, uses animationend to cleanup
  function spawnPiece(kind, xvw = 50, sizeScale = 1, duration = 4.2, opts = {}) {
    try {
      // resolve fxRoot dynamically so we don't rely on a closure-captured value
      let root = document.getElementById("fx-layer") || fxRoot;
      if (!root) {
        // fallback: create it (very defensive)
        root = document.createElement("div");
        root.id = "fx-layer";
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

      // sensible randomized visuals
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

      // decide SVG / content by kind
      let svg = "";
      if (kind === "fx-wrapper") {
        const color = opts.color || opts.colorHex || "#FF6B00";
        el.style.setProperty("--fx-color", color);
        el.style.color = color; // ensure currentColor works in SVG
        el.classList.add("fx-piece--win");
        svg = svgWrapper(color);
      } else if (kind === "fx-candy") {
        el.classList.add("fx-piece--win");
        svg = svgCandy();
      } else if (kind === "fx-ghost") {
        el.classList.add("fx-piece--loss");
        el.classList.add("fx-piece--ghost");
        svg = svgGhost();
      } else if (kind === "fx-skull" || kind === "fx-loss" || kind === "fx-bone") {
        el.classList.add("fx-piece--loss");
        svg = svgSkull();
      } else {
        el.classList.add("fx-piece--loss");
        svg = svgSkull();
      }
  
      el.innerHTML = svg;

      // GPU hints
      el.style.willChange = "transform, opacity";

      // append and force reflow to kick animations
      root.appendChild(el);
      // important: ensure styles apply before we rely on animationstart
      void el.offsetWidth;

      // explicit initial transform (non-blocking)
      el.style.transform = `translateY(-6%) rotate(${Math.floor(rand(-20,20))}deg) scale(${scaleVal})`;

      // cleanup: prefer animationend but keep a fallback timeout
      let removed = false;
      const removeNow = () => {
        if (removed) return;
        removed = true;
        try { el.remove(); } catch (e) { /* ignore */ }
      };

      // remove when animation ends (covers most browsers)
      el.addEventListener("animationend", () => removeNow(), { once: true });

      // fallback: remove after the expected duration + safety margin
      const removeAfter = Math.max(900, Math.round(Number(duration) * 1000) + 750);
      el.__treatz_rm = setTimeout(removeNow, removeAfter);

      return el;
    } catch (e) {
      console.warn("spawnPiece failed", e);
      return null;
    }
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
    // FRONT is labeled TRICK in HTML, so front should get trickImg
    Object.assign(front.style, {
      background: `center/contain no-repeat url('${trickImg}')`,
      border: "none", textIndent: "-9999px"
    });
    Object.assign(back.style, {
      background: `center/contain no-repeat url('${treatImg}')`,
      border: "none", textIndent: "-9999px", transform: "rotateY(180deg)"
    });
  }

  function setCoinVisual(landed) {
    const result = String(landed || "").toUpperCase();
    const isTreat = (result === "TREAT");
    const treatImg = (window.TREATZ_CONFIG?.assets?.coin_treat) || "/static/assets/coin_treatz.png";
    const trickImg = (window.TREATZ_CONFIG?.assets?.coin_trick) || "/static/assets/coin_trickz.png";
    if (typeof setCoinFaces === "function") {
      try { setCoinFaces(trickImg, treatImg); } catch (_) { /* ignore */ }
    }
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

  // Set initial coin faces on DOMContentLoaded
  document.addEventListener("DOMContentLoaded", () => {
    const treatImg = (window.TREATZ_CONFIG?.assets?.coin_treat) || "/static/assets/coin_treatz.png";
    const trickImg = (window.TREATZ_CONFIG?.assets?.coin_trick) || "/static/assets/coin_trickz.png";
    setCoinFaces(trickImg, treatImg);
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
      const short = typeof PUBKEY === "string" ? (PUBKEY.slice(0, 4) + "…" + PUBKEY.slice(-4)) : (PUBKEY.toBase58 ? (PUBKEY.toBase58().slice(0, 4) + "…" + PUBKEY.toBase58().slice(-4)) : "wallet");
      connectBtns.forEach(b => b && (b.textContent = "Disconnect"));
      openBtns.forEach(b => { if (!b) return; b.textContent = `Wallet (${short})`; b.hidden = false; });
    } else {
      connectBtns.forEach(b => b && (b.textContent = "Connect Wallet"));
      openBtns.forEach(b => b && (b.hidden = true));
    }
    updateDeepLinkVisibility(PUBKEY);
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

  // Minimal connect toggles — real wallet plumbing used elsewhere
  $$("#btn-connect, #btn-connect-2").forEach(btn => btn?.addEventListener("click", async () => {
    try {
      // disconnect if currently connected
      if (PUBKEY) {
        PUBKEY = null; WALLET = null;
        // also clear globals so other modules see the disconnect
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

      // if only one provider available, attempt connect inline
      if (present.length === 1) {
        const name = present[0], p = getProviderByName(name);
        try {
          if (p && p.connect) {
            // keep a global pointer to the provider
            window.provider = p;
            window.WALLET = p;
            const res = await p.connect({ onlyIfTrusted: false }).catch(() => null);
            // resolve public key from various provider shapes
            const resolved = (res?.publicKey?.toString?.() || p.publicKey?.toString?.() || window.solana?.publicKey?.toString?.() || null);
            if (resolved) {
              PUBKEY = resolved;
              WALLET = p;
              // mirror to globals for other modules & built bundles
              window.PUBKEY = PUBKEY;
              window.WALLET = WALLET;
              window.provider = p;
              // expose a walletPlumbing flag for legacy guards
              window.walletPlumbingReady = !!PUBKEY && !!p;
              // attach connect/disconnect handlers if provider supports them
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
                } catch (ee) { /* ignore event wiring errors */ }
              }
              setWalletLabels();
              toast("Wallet connected");
              return;
            }
          }
        } catch (e) { console.warn("wallet connect failed", e); }
      }

      // fallback: open wallet modal
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
          // keep global refs
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
          // mirror to globals
          window.PUBKEY = PUBKEY;
          window.WALLET = WALLET;
          window.provider = p;
          window.walletPlumbingReady = !!PUBKEY && !!p;

          // attach connect/disconnect handlers if available
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
            } catch (_) { /* ignore */ }
          }

          setWalletLabels();
          toast("Wallet connected");
        } else {
          if (w === "phantom") window.open("https://phantom.app/", "_blank");
        }
      } catch (e) { console.error("connect from modal failed", e); toast("Wallet connect failed"); }
    })();
  });

  // On load: if an injected provider already has a publicKey, populate globals
(function hydrateProviderOnLoad() {
  try {
    const p = getPhantomProvider() || getSolflareProvider() || getBackpackProvider() || window.solana;
    // Some providers expose publicKey immediately (trusted connection) — hydrate app state with it
    const foundPk = p?.publicKey || window.solana?.publicKey;
    if (p && foundPk) {
      const s = (p.publicKey && typeof p.publicKey.toString === 'function' && p.publicKey.toString()) ||
                (window.solana?.publicKey && typeof window.solana.publicKey.toString === 'function' && window.solana.publicKey.toString()) ||
                null;
      if (s) {
        PUBKEY = s;
        WALLET = p;
        // mirror to globals for other script modules and the built bundle to read
        window.PUBKEY = s;
        window.WALLET = p;
        window.provider = p;
        window.walletPlumbingReady = true;
        setWalletLabels();
        console.log("[TREATZ] hydrated provider on load ->", s);

        // wire connect/disconnect events if provider supports them
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
          } catch (_) { /* ignore event wiring errors */ }
        }
      }
    }
  } catch (e) { /* ignore hydration errors */ }
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
  // SPL token helpers (use imports when available)
  // -------------------------
  async function getOrCreateATA(owner, mintPk, payer) {
    const ownerPk = new PublicKey(owner);
    const mintPkObj = new PublicKey(mintPk);
    const ata = await getAssociatedTokenAddress(mintPkObj, ownerPk);
    let exists = false;
    try {
      const r = await jfetch(`${API}/accounts/${ata.toBase58()}/exists`);
      exists = !!r?.exists;
    } catch (_) {}
    if (!exists) {
      const ix = createAssociatedTokenAccountInstruction(
        payer,
        ata,
        ownerPk,
        mintPkObj
      );
      return { ata, ix };
    }
    return { ata, ix: null };
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
    if (tx.feePayer && typeof tx.feePayer === "string") {
      try { tx.feePayer = new PublicKey(tx.feePayer); } catch (e) { /* ignore */ }
    }
    if (WALLET?.signAndSendTransaction) {
      try {
        const res = await WALLET.signAndSendTransaction(tx);
        return typeof res === "string" ? res : res?.signature;
      } catch (e) { console.warn("signAndSendTransaction failed", e); }
    }
    if (WALLET?.signTransaction) {
      try {
        const signed = await WALLET.signTransaction(tx);
        const raw = signed.serialize();
        const sig = await connection.sendRawTransaction(raw);
        try { await connection.confirmTransaction(sig, "confirmed"); } catch(_) {}
        return sig;
      } catch (e) { console.warn("signTransaction/sendRaw failed", e); }
    }
    if (WALLET?.sendTransaction) {
      try {
        const sig = await WALLET.sendTransaction(tx, connection);
        try { await connection.confirmTransaction(sig, "confirmed"); } catch(_) {}
        return sig;
      } catch (e) { console.warn("sendTransaction failed", e); }
    }
    throw new Error("Wallet provider does not support known transaction send methods");
  }

  // -------------------------
  // Coin flip UI (local animation)
  // -------------------------
  (function wireCoinFlipUI() {
    const cfPlay = document.getElementById("cf-play");
    if (!cfPlay) return;

    cfPlay.addEventListener("click", async (e) => {
      try {
        e.preventDefault();

        const coin = document.getElementById("coin") || document.querySelector(".coin");
        if (coin) { coin.classList.remove("spin"); void coin.offsetWidth; coin.classList.add("spin"); }

        // read chosen side from form (defensive)
        const form = document.getElementById("bet-form");
        const side = (form ? (new FormData(form)).get("side") : null) || "TRICK";

        // small helper for logging (no-op in prod)
        if (window.__TREATZ_DEBUG) {
          console.log("[TREATZ] coin flip clicked — chosen:", side);
        }

        // simulate spin/settle delay to match CSS .spin duration
        setTimeout(() => {
          try {
            const landedTreat = Math.random() < 0.5;
            const landed = landedTreat ? "TREAT" : "TRICK";
            const chosen = String(side || "TRICK").toUpperCase();
            const win = (landed === chosen);

            // update visuals first (face images & classes)
            try { setCoinVisual(landed); } catch (err) { console.warn("setCoinVisual failed", err); }

            // set final orientation via classes (avoid inline transform clobber)
            if (coin) {
              coin.classList.remove("coin--final-trick", "coin--final-treat");
              coin.classList.add(landedTreat ? "coin--final-treat" : "coin--final-trick");
            }

            // trigger FX and banner based on actual comparison
            try { playResultFX(landed); } catch (err) { console.warn("playResultFX failed", err); }
            try { showWinBanner(win ? `${landed} — YOU WIN! 🎉` : `${landed} — YOU LOSE 💀`); } catch (err) {}

            // update status text under coin
            const statusEl = document.getElementById("cf-status");
            if (statusEl) {
              statusEl.textContent = (win ? `WIN — ${landed}` : `LOSS — ${landed}`);
              // accessibility: announce via aria-live if present
              statusEl.setAttribute("role", "status");
              statusEl.setAttribute("aria-live", "polite");
            }

            if (window.__TREATZ_DEBUG) {
              console.log("[TREATZ] coin flip result:", { chosen, landed, win });
            }
          } catch (err) {
            console.error("coin flip settle handler error", err);
          }
        }, 1150); // matches CSS spin animation duration

      } catch (err) {
        console.error("cfPlay handler error", err);
      }
    }, { passive: false });
  })();

  // placeCoinFlip: full backend flow when wallet available
  async function placeCoinFlip() {
    try {
      await ensureConfig();
      if (!PUBKEY) throw new Error("Wallet not connected");
      if (!window.solanaWeb3 || !window.splToken || !WALLET) throw new Error("Wallet libraries not loaded");
      const amountHuman = Number(document.getElementById("bet-amount").value || "0");
      const side = (new FormData(document.getElementById("bet-form"))).get("side") || "TRICK";
      if (!amountHuman || amountHuman <= 0) throw new Error("Enter a positive amount.");
      const bet = await jfetch(`${API}/bets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: toBaseUnits(amountHuman), side })
      });
      const betId = bet.bet_id;
      $("#bet-deposit")?.replaceChildren(document.createTextNode(bet.deposit));
      $("#bet-memo")?.replaceChildren(document.createTextNode(bet.memo));
      const mintPk = new PublicKey(CONFIG.token.mint);
      const destAta = new PublicKey(CONFIG.vaults.game_vault_ata || CONFIG.vaults.game_vault);
      const payerRaw = PUBKEY;
      const payerPub = (typeof payerRaw === "string") ? new PublicKey(payerRaw) : payerRaw;
      const { ata: srcAta, ix: createSrc } = await getOrCreateATA(payerPub, mintPk, payerPub);
      const ixs = [];
      if (createSrc) ixs.push(createSrc);
      ixs.push(
        createTransferCheckedInstruction(
          srcAta,
          mintPk,
          destAta,
          payerPub,
          toBaseUnits(amountHuman),
          DECIMALS
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
      rainTreatz({ count: 22 });
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
      } catch { /* ignore */ }
    }
    $("#cf-status")?.replaceChildren(document.createTextNode("Waiting for network / webhook…"));
  }

  // Coin flip place button wiring for real flow (if you want to hook it)
  $("#cf-place")?.addEventListener("click", (e) => { e.preventDefault(); placeCoinFlip().catch(() => {}); });

  // show banner on win/loss
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

  // -------------------------
  // Jackpot / Raffle UI
  // -------------------------
  document.getElementById("jp-buy")?.addEventListener("click", async () => {
    try {
      // prefer the canonical runtime check (local and global)
      if (!PUBKEY && !window.PUBKEY) {
        toast("Connect wallet to buy tickets");
        // open wallet modal to make it easy for users to connect
        const modal = document.getElementById("wallet-modal");
        if (modal) {
          modal.hidden = false;
        } else {
          // fallback: highlight wallet menu if present
          const menu = document.getElementById("wallet-menu") || document.querySelector(".wm__list");
          if (menu) menu.style.outline = "2px solid rgba(255,255,255,0.08)";
        }
        return;
      }

      // At this point we have a pubkey. Proceed or delegate to a purchase function if implemented.
      toast("Starting ticket purchase...");
      // If you implemented a purchase helper, call it. Otherwise this is a safe placeholder:
      if (typeof window.startRafflePurchase === "function") {
        try { await window.startRafflePurchase(); return; } catch (err) { console.error("startRafflePurchase failed", err); }
      }

      // fallback informational message (no backend call here)
      toast("Ticket purchase flow starting — backend action not wired in this build.");
    } catch (e) { console.error(e); alert(e?.message || "Ticket purchase failed."); }
  });

  
  
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
      const priceBase = Number(cfg?.token?.ticket_price ?? 0);
      if (priceBase && document.getElementById("ticket-price")) {
        document.getElementById("ticket-price").textContent = (priceBase / TEN_POW).toLocaleString();
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
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;
    try {
      const q = new URL(`${API}/rounds/recent`, location.origin);
      q.searchParams.set("limit", "25");
      const res = await fetch(q.toString(), { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const recent = await res.json();
      if (!Array.isArray(recent) || recent.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="muted">No history.</td></tr>`;
        return;
      }
      const rows = [];
      for (const r of recent) {
        const roundId = r.id || r.round_id || r[0] || "unknown";
        let w = null;
        try { w = await jfetchStrict(`${API}/rounds/${encodeURIComponent(roundId)}/winner`); } catch (e) { /* ignore per-row */ }
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
    } catch (e) {
      console.error(e);
      tbody.innerHTML = `<tr><td colspan="5" class="muted">Failed to load history from backend.</td></tr>`;
    }
  }
  document.getElementById("history-search")?.addEventListener("input", (e) => {
    const q = e.target.value.trim();
    clearTimeout(window.__rf_hist_timer);
    window.__rf_hist_timer = setTimeout(() => loadHistory(q), 200);
  });
  loadHistory();

  (async () => {
    try {
      await ensureConfig();
      if (CONFIG?.raffle?.splits) {
        const s = CONFIG.raffle.splits;
        const bps = 10000 - (s.winner + s.dev + s.burn);
        const el = document.getElementById("edge-line");
        if (el) el.textContent = `House edge: ${(bps / 100).toFixed(2)}%`;
      }
    } catch (e) { console.warn("could not load edge info", e); }
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
      try { await a.play(); } catch { }
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

  // expose both under window.TREATZ and as direct globals for console/dev convenience
  window.TREATZ = window.TREATZ || {};
  Object.assign(window.TREATZ, {
    playResultFX, rainTreatz, hauntTrick, announceLastWinner, setCoinVisual, spawnPiece
  });

  // make setCoinVisual directly callable from console/tests
  if (typeof window !== 'undefined') {
    window.setCoinVisual = setCoinVisual;
    // optionally also expose setCoinFaces
    window.setCoinFaces = setCoinFaces;
  }

  // FX debug wrapper
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
