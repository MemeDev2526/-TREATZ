// app.js — reorganized, resilient, complete drop-in for TREATZ
// - keeps FX, countdown, raffle UI, coin flip animation, ticker, mascot, ambient audio
// - tolerant to missing solana libs/providers (no TDZ / ReferenceError)
// - uses jfetch / jfetchStrict helpers and defensive DOM access
// app.js

// 1️⃣ Solana + SPL-Token imports (ESM)
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";

// === SHIM: expose imported libs onto window for legacy diagnostics / IIFEs ===
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

// 2️⃣ RPC connection setup
const RPC_URL = "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

// 3️⃣ Helper functions (can be imported or inline)
export async function getAta(owner, mint) {
  // This helper returns the ATA PublicKey for owner + mint.
  // Accepts string or PublicKey-like inputs.
  const ownerPk = new PublicKey(owner);
  const mintPk = new PublicKey(mint);
  const ata = await getAssociatedTokenAddress(mintPk, ownerPk);
  console.log("ATA:", ata.toBase58());
  return ata;
}

// 4️⃣ Rest of your app.js (DOM hooks, connect wallet, etc.)
document.addEventListener("DOMContentLoaded", () => {
  console.log("[TREATZ] Frontend initialized");
});

(function () {
  "use strict";

  // -------------------------
  // Boot diagnostics (optional)
  // -------------------------
  (function diag() {
    if (!window.__TREATZ_DEBUG) return;
    function showDiag(msg, kind) {
      if (!document.body) { document.addEventListener("DOMContentLoaded", () => showDiag(msg, kind)); return; }
      var bar = document.getElementById("__treatz_diag");
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "__treatz_diag";
        bar.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:99999;padding:10px 14px;font:14px/1.3 Rubik,system-ui,sans-serif;color:#fff;background:#c01;box-shadow:0 6px 20px rgba(0,0,0,.5)";
        document.body.appendChild(bar);
      }
      var span = document.createElement("div");
      span.textContent = "[TREATZ] " + msg;
      if (kind === "ok") { span.style.color = "#0f0"; }
      bar.appendChild(span);
    }

    window.addEventListener("error", (e) => showDiag("JS error: " + (e.message || e.type), "err"));
    window.addEventListener("unhandledrejection", (e) => showDiag("Promise rejection: " + (e.reason && e.reason.message || e.reason), "err"));

    document.addEventListener("DOMContentLoaded", async function () {
      try {
        showDiag("Booting diagnostics…");
        // Prefer checking imported symbols too (but shim above already helps)
        if (!window.solanaWeb3) showDiag("solanaWeb3 (web3.js) not loaded", "err"); else showDiag("web3.js ✓", "ok");
        if (!window.splToken) showDiag("spl-token IIFE not loaded", "err"); else showDiag("@solana/spl-token ✓", "ok");

        var C = window.TREATZ_CONFIG || {};
        var API = (C.apiBase || "/api").replace(/\/$/, "");
        showDiag("API = " + API);
        try {
          const r = await fetch(API + "/health", { mode: "cors" });
          if (!r.ok) throw new Error(r.status + " " + r.statusText);
          const j = await r.json();
          showDiag("API /health OK (ts=" + j.ts + ")", "ok");
        } catch (e) {
          showDiag("API not reachable: " + (e.message || e), "err");
        }

        var btn1 = document.getElementById("btn-connect");
        var btn2 = document.getElementById("btn-connect-2");
        if (!btn1 && !btn2) showDiag("Connect buttons not found in DOM", "err"); else showDiag("Connect buttons present ✓", "ok");

        [btn1, btn2].filter(Boolean).forEach(b => {
          b.addEventListener("click", function () { showDiag("Connect button clicked (smoke)"); }, { once: true });
        });

        var a = document.getElementById("bg-ambient");
        if (!a) showDiag("Ambient audio element missing", "err"); else showDiag("Ambient audio tag ✓", "ok");
      } catch (e) {
        showDiag("Diagnostics failed: " + (e.message || e), "err");
      }
    });
  })();

  // -------------------------
  // Globals & helpers
  // -------------------------
  const C = window.TREATZ_CONFIG || {};
  const API = (C.apiBase || "/api").replace(/\/$/, "");
  const TOKEN = C.token || { symbol: "$TREATZ", decimals: 6 };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const pow10 = (n) => Math.pow(10, n);
  const fmtUnits = (units, decimals = TOKEN.decimals) => {
    if (units == null) return "—";
    const t = Number(units) / pow10(decimals);
    return t >= 1 ? t.toFixed(2) : t.toFixed(4);
  };

  const toast = (msg) => {
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
  };

  const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || "");
  const phantomDeepLinkForThisSite = () => {
    const url = location.href.split('#')[0];
    return `https://phantom.app/ul/browse/${encodeURIComponent(url)}`;
  };

  async function jfetch(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }
  async function jfetchStrict(url, opts) { // identical but separate name for clarity
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }

  // -------------------------
  // FX helpers: particles, effects, coin faces
  // -------------------------
  const fxRoot = (() => {
    let n = document.getElementById("fx-layer");
    if (!n) { n = document.createElement("div"); n.id = "fx-layer"; document.body.appendChild(n); }
    return n;
  })();

  const rand = (min, max) => Math.random() * (max - min) + min;

  // svgWrapper(color) => returns a wrapper SVG string tinted with `color`.
  // color should be a CSS color string like "#6b2393". If omitted, default orange used.
  function svgWrapper(color = "#FF6B00") {
    // return a compact solid-fill wrapper; JS passes color in so it's fully solid
  return `
<svg width="84" height="40" viewBox="0 0 84 40" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="$TREATZ">
  <g>
    <!-- left twist -->
    <path d="M10 14 L2 8 L10 10 L8 2 L16 12 Z" fill="${color}" />
    <!-- wrapper body (solid) -->
    <rect x="16" y="6" rx="6" ry="6" width="52" height="28" fill="${color}" />
    <!-- right twist -->
    <path d="M74 26 L82 32 L74 30 L76 38 L68 28 Z" fill="${color}" />
    <!-- white label -->
    <text x="42" y="26" text-anchor="middle" font-family="Creepster, Luckiest Guy, sans-serif" font-size="14" fill="#ffffff" font-weight="700">$TREATZ</text>
  </g>
</svg>`;
}

  // small candy (keeps previous shape but with a nicer gradient)
  function svgCandy() {
    return `
<svg width="42" height="32" viewBox="0 0 42 32" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="candy">
  <defs>
    <linearGradient id="candyG" x1="0" x2="1">
      <stop offset="0" stop-color="#FFB27A"/>
      <stop offset="1" stop-color="#FF6B00"/>
    </linearGradient>
  </defs>
  <path d="M4 16 L0 10 L6 12 L6 4 L12 10" fill="#F7F7F8"/>
  <rect x="8" y="6" rx="6" ry="6" width="26" height="20" fill="url(#candyG)" stroke="rgba(0,0,0,0.12)"/>
  <path d="M38 16 L42 22 L36 20 L36 28 L30 22" fill="#F7F7F8"/>
  <rect x="16" y="10" width="10" height="12" rx="3" fill="#0D0D0D" />
</svg>`;
  }

  // ghost SVG improved — softer fill + subtle inner shadow for depth
  function svgGhost() {
    return `
<svg width="44" height="56" viewBox="0 0 44 56" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ghost">
  <defs>
    <linearGradient id="gGhost" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.98"/>
      <stop offset="1" stop-color="#cfefff" stop-opacity="0.9"/>
    </linearGradient>
    <filter id="gShadow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <g filter="url(#gShadow)">
    <path d="M22 2c11 0 20 9 20 20v24c0 3-3 3-6 2-3-1-5 0-8 1s-6-2-9-2-6 3-9 2-5-2-8-1c-3 1-6 1-6-2V22C2 11 11 2 22 2z" fill="url(#gGhost)"/>
    <circle cx="16" cy="22" r="4" fill="#0D0D0D"/>
    <circle cx="28" cy="22" r="4" fill="#0D0D0D"/>
    <path d="M14 34 Q18 30 22 34 Q26 38 30 34" fill="rgba(0,0,0,0.06)"/>
  </g>
</svg>`;
  }

// skull SVG with crossbones
function svgSkull() {
  return `
<svg width="56" height="48" viewBox="0 0 56 48" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="skull">
  <g>
    <!-- skull head (bone white) -->
    <path d="M28 6c9 0 16 6 16 14 0 6-3 9-5 12H17c-2-3-5-6-5-12 0-8 7-14 16-14z" fill="#f6f6f6" stroke="#0b0b0b" stroke-width="0.8"/>
    <!-- eyes -->
    <circle cx="20" cy="20" r="4.4" fill="#0b0b0b"/>
    <circle cx="36" cy="20" r="4.4" fill="#0b0b0b"/>
    <!-- teeth -->
    <rect x="22" y="30" width="12" height="6" rx="2" fill="#0b0b0b"/>
    <!-- subtle shading -->
    <path d="M16 36 q8 6 24 0" fill="rgba(0,0,0,0.05)"/>
    <!-- crossbones behind skull: two rounded rectangles, rotated -->
    <g transform="translate(28,38)">
      <g transform="rotate(24)">
        <rect x="-26" y="-4" width="52" height="8" rx="4" fill="#f6f6f6" stroke="#0b0b0b" stroke-width="0.6"/>
      </g>
      <g transform="rotate(-24)">
        <rect x="-26" y="-4" width="52" height="8" rx="4" fill="#f6f6f6" stroke="#0b0b0b" stroke-width="0.6"/>
      </g>
    </g>
  </g>
</svg>`;
} 

// spawnPiece(kind, xvw, sizeScale, duration, opts)
  // opts: { color } - used for wrapper tinting
  function spawnPiece(kind, xvw, sizeScale, duration, opts = {}) {
    const el = document.createElement("div");
    el.className = `fx-piece ${kind}`;
    // position relative to viewport percent; small negative to start above
    el.style.left = `calc(${xvw}vw - 32px)`;
    el.style.top = `-80px`;
    el.style.transform = `translate(${xvw}vw, -10%) rotate(${Math.floor(rand(-30, 30))}deg)`;
    el.style.setProperty("--x", `${xvw}vw`);
    el.style.setProperty("--dur", `${duration}s`);
    el.style.setProperty("--r0", `${Math.floor(rand(-90, 90))}deg`);
    el.style.setProperty("--r1", `${Math.floor(rand(240, 720))}deg`);
    el.style.scale = String(sizeScale || 1);

    // Choose SVG based on kind. For wrappers we allow inline color.
    let svg = "";
    if (kind === "fx-wrapper") {
      const color = opts.color || opts.colorHex || "#FF6B00";
      svg = svgWrapper(color);
      el.classList.add("fx-piece--win");
    } else if (kind === "fx-candy") {
      svg = svgCandy();
      el.classList.add("fx-piece--win");
    } else if (kind === "fx-ghost") {
      svg = svgGhost();
      el.classList.add("fx-piece--loss");
    } else { // skull
      svg = svgSkull();
      el.classList.add("fx-piece--loss");
    }

    el.innerHTML = svg;
    fxRoot.appendChild(el);
    // auto-remove after duration + small buffer
    setTimeout(() => el.remove(), Math.max(800, (duration * 1000) + 300));
  }

  const WRAP_COLORS = ['#6b2393', '#00c96b', '#ff7a00']; // witch purple, slime green, orange

  function rainTreatz({ count = 24, wrappers = true, candies = true, minDur = 4.5, maxDur = 7 } = {}) {
    for (let i = 0; i < count; i++) {
      const x = rand(0, 100);
      const scale = rand(0.78, 1.22);
      const dur = rand(minDur, maxDur);
      if (wrappers) {
        const color = WRAP_COLORS[Math.floor(rand(0, WRAP_COLORS.length))];
        spawnPiece("fx-wrapper", x, scale, dur, { color });
      }
      if (candies) {
        spawnPiece("fx-candy", x + rand(-4, 4), rand(.7, 1.05), dur + rand(-.5, .5));
      }
    }
  }

  function hauntTrick({ count = 10, ghosts = true, skulls = true } = {}) {
    for (let i = 0; i < count; i++) {
      const x = rand(5, 95);
      const scale = rand(0.85, 1.28);
      const dur = rand(5.6, 9);
      // alternate ghosts & skulls for mixed effect
      if (ghosts && Math.random() < 0.66) spawnPiece("fx-ghost", x + rand(-6, 6), scale, dur);
      if (skulls && Math.random() < 0.66) spawnPiece("fx-skull", x + rand(-6, 6), rand(.9, 1.18), dur + rand(-.7, .7));
    }
  }

  function playResultFX(result) {
    const r = String(result || "").toUpperCase();
    if (r === "TRICK" || r === "LOSS") {
      // Loss: more spooky, fewer wrappers
      hauntTrick({ count: 10, ghosts: true, skulls: true });
      document.body.classList.add('flash');
      setTimeout(() => document.body.classList.remove('flash'), 1100);
      // a small delayed secondary burst for oomph
      setTimeout(() => hauntTrick({ count: 6, ghosts: true, skulls: true }), 300);
    } else {
      // Win: more wrappers + candies; colors randomized
      rainTreatz({ count: 28, wrappers: true, candies: true, minDur: 4.2, maxDur: 7 });
      // small extra quick sprinkle
      setTimeout(() => rainTreatz({ count: 12, wrappers: true, candies: false, minDur: 3.6, maxDur: 5.6 }), 220);
    }
  }
  window.playResultFX = playResultFX;

  function setCoinFaces(treatImg, trickImg) {
    const front = document.querySelector(".coin__face--front");
    const back = document.querySelector(".coin__face--back");
    if (!front || !back) return;
    Object.assign(front.style, {
      background: `center/contain no-repeat url('${treatImg}')`,
      border: "none", textIndent: "-9999px"
    });
    Object.assign(back.style, {
      background: `center/contain no-repeat url('${trickImg}')`,
      border: "none", textIndent: "-9999px", transform: "rotateY(180deg)"
    });
  }

  // Prefer config assets, fallback to /static/...
  document.addEventListener("DOMContentLoaded", () => {
    const treatImg = (window.TREATZ_CONFIG?.assets?.coin_treat) || "/static/assets/coin_treatz.png";
    const trickImg = (window.TREATZ_CONFIG?.assets?.coin_trick) || "/static/assets/coin_trickz.png";
    setCoinFaces(treatImg, trickImg);
  });

  function showWinBanner(text) {
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
  }

  // -------------------------
  // Countdown: Halloween global and raffle-specific
  // -------------------------
  function nextHalloween() {
    const now = new Date();
    const m = now.getMonth(); // 0..11
    const d = now.getDate();
    const year = (m > 9 || (m === 9 && d >= 31)) ? now.getFullYear() + 1 : now.getFullYear();
    return new Date(year, 9, 31, 00, 00, 00, 0);
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
  
    // Build HTML with separate spans for number + unit so CSS can style them individually
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
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) initHalloweenCountdown();
  });

  // -------------------------
  // Static links, asset wiring, mascot float + token address copy
  // -------------------------
  const link = (id, href) => { const el = document.getElementById(id); if (el && href) el.href = href; };
  link("link-telegram", C.links?.telegram);
  link("link-twitter", C.links?.twitter);
  link("link-tiktok", C.links?.tiktok);
  link("link-whitepaper", C.links?.whitepaper);
  link("btn-buy", C.buyUrl);

  const deepLinks = [
    document.getElementById("btn-open-in-phantom"),
    document.getElementById("btn-open-in-phantom-2"),
    document.getElementById("btn-open-in-phantom-modal"),
  ].filter(Boolean);

  function updateDeepLinkVisibility() {
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
  document.addEventListener("DOMContentLoaded", updateDeepLinkVisibility);
  window.addEventListener("load", updateDeepLinkVisibility);

  const tokenEl = $("#token-address");
  if (tokenEl) tokenEl.textContent = C.tokenAddress || "—";

  const cdLogo = $("#countdown-logo");
  if (C.assets?.logo && cdLogo) { cdLogo.src = C.assets.logo; cdLogo.alt = "$TREATZ"; }

  // Mascot float (defensive)
  const mascotImg = $("#mascot-floater");
  if (mascotImg && C.assets?.mascot) {
    mascotImg.src = C.assets.mascot;
    mascotImg.alt = "Treatz Mascot";
    mascotImg.style.willChange = "transform";
    mascotImg.style.position = "fixed";
    mascotImg.style.left = "35px";
    mascotImg.style.top = "35px";

    const MARGIN = 24;
    let x = 120, y = 120, tx = x, ty = y, t = 0;
    const SPEED = 0.01;

    const pickTarget = () => {
      const w = window.innerWidth, h = window.innerHeight;
      const rect = mascotImg.getBoundingClientRect();
      const elW = rect.width || 96, elH = rect.height || 96;
      tx = MARGIN + Math.random() * Math.max(1, w - elW - MARGIN * 2);
      ty = MARGIN + Math.random() * Math.max(1, h - elH - MARGIN * 2);
    };

    pickTarget();
    const step = () => {
      t += 1;
      x += (tx - x) * SPEED;
      y += (ty - y) * SPEED;
      if (Math.hypot(tx - x, ty - y) < 4) pickTarget();
      const bobX = Math.sin(t * 0.05) * 10;
      const bobY = Math.cos(t * 0.04) * 8;
      const rot = Math.sin(t * 0.03) * 4;
      mascotImg.style.transform = `translate(${x + bobX}px, ${y + bobY}px) rotate(${rot}deg)`;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    window.addEventListener("resize", pickTarget);
  }

  $("#btn-copy")?.addEventListener("click", () => {
    navigator.clipboard.writeText(C.tokenAddress || "").then(
      () => toast("Token address copied"),
      () => toast("Copy failed")
    );
  });

  // -------------------------
  // Wallet plumbing (lazy, provider-agnostic)
  // -------------------------
  // Keep these functions as "declarative" functions so they're hoisted and safe to call.
  function getPhantomProvider() {
    const p = (window.phantom && window.phantom.solana) || window.solana;
    return (p && p.isPhantom) ? p : null;
  }
  function getSolflareProvider() {
    return (window.solflare && window.solflare.isSolflare) ? window.solflare : null;
  }
  function getBackpackProvider() {
    return window.backpack?.solana || null;
  }
  const getProviderByName = (name) => {
    name = (name || "").toLowerCase();
    const ph = (window.phantom && window.phantom.solana) || window.solana;
    if (name === "phantom" && ph?.isPhantom) return ph;
    if (name === "solflare" && window.solflare?.isSolflare) return window.solflare;
    if (name === "backpack" && window.backpack?.solana) return window.backpack.solana;
    return null;
  };

  // wallet state (may exist even if libs not loaded)
  let WALLET = null;
  let PUBKEY = null;
  let CONFIG = null;
  let DECIMALS = Number(TOKEN.decimals || 6);
  let TEN_POW = 10 ** DECIMALS;

  const toBaseUnits = (human) => Math.floor(Number(human) * TEN_POW);
  const fromBaseUnits = (base) => Number(base) / TEN_POW;

  function setWalletLabels() {
    const connectBtns = $$("#btn-connect, #btn-connect-2");
    const openBtns = $$("#btn-openwallet, #btn-openwallet-2");

    if (PUBKEY) {
      const short = typeof PUBKEY === "string" ? (PUBKEY.slice(0, 4) + "…" + PUBKEY.slice(-4)) : (PUBKEY.toBase58 ? (PUBKEY.toBase58().slice(0, 4) + "…" + PUBKEY.toBase58().slice(-4)) : "wallet");
      connectBtns.forEach(b => b && (b.textContent = "Disconnect"));
      openBtns.forEach(b => {
        if (!b) return;
        b.textContent = `Wallet (${short})`;
        b.hidden = false;
      });
    } else {
      connectBtns.forEach(b => b && (b.textContent = "Connect Wallet"));
      openBtns.forEach(b => b && (b.hidden = true));
    }
    updateDeepLinkVisibility();
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

  // Lightweight wallet connect flow (only UI; full wallet plumbing left for later)
  $$("#btn-connect, #btn-connect-2").forEach(btn => btn?.addEventListener("click", async () => {
    try {
      // For now we just toggle a mock connected state (since wallet plumbing is paused)
      if (PUBKEY) {
        PUBKEY = null;
        WALLET = null;
        setWalletLabels();
        toast("Disconnected");
        return;
      }

      // If a single provider is present, simulate connect
      const present = [
        getPhantomProvider() && "phantom",
        getSolflareProvider() && "solflare",
        getBackpackProvider() && "backpack",
      ].filter(Boolean);

      if (present.length === 1) {
        // attempt to use real provider if available
        const name = present[0];
        const p = getProviderByName(name);
        try {
          if (p && p.connect) {
            const res = await p.connect({ onlyIfTrusted: false }).catch(() => null);
            if (res?.publicKey) {
              PUBKEY = typeof res.publicKey.toString === "function" ? res.publicKey.toString() : res.publicKey;
              WALLET = p;
              setWalletLabels();
              toast("Wallet connected");
              return;
            }
          }
        } catch (e) {
          console.warn("wallet connect failed", e);
        }
      }

      // Otherwise show wallet modal
      const modal = document.getElementById("wallet-modal");
      if (modal) modal.hidden = false;
    } catch (err) {
      console.error("[btn-connect] error", err);
      alert(err?.message || "Failed to open wallet.");
    }
  }));

  // Wallet modal handlers
  const menu = document.getElementById("wallet-menu");
  menu?.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-wallet]");
    if (!b) return;
    const w = b.getAttribute("data-wallet");
    const modal = document.getElementById("wallet-modal");
    if (modal) modal.hidden = true;
    // attempt to connect if provider exists
    (async () => {
      try {
        const p = getProviderByName(w);
        if (p && p.connect) {
          const res = await p.connect({ onlyIfTrusted: false });
          const got = (res?.publicKey?.toString?.() || res?.publicKey || res)?.toString?.();
          PUBKEY = got;
          WALLET = p;
          setWalletLabels();
          toast("Wallet connected");
        } else {
          // redirect to phantom if none found
          if (w === "phantom") window.open("https://phantom.app/", "_blank");
        }
      } catch (e) {
        console.error("connect from modal failed", e);
      }
    })();
  });

  // -------------------------
  // Ticker (faux transaction feed)
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
      // wrap each tick in ticker__item so spacing CSS applies
      return `<span class="ticker__item ${cls}">${who} ${verb} ${fmt(amount)} $TREATZ ${emoji}</span>`;
    }

    function buildBatch(len = 30) {
      const lines = [];
      for (let i = 0; i < len; i++) lines.push(makeLine());
      // repeat a few items for a smooth loop and use a styled separator element
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
      try {
        const c = await jfetch(`${API}/credits/${PUBKEY}`);
        credit = Number(c?.credit || 0);
      } catch { }

      $("#ps-tickets")?.replaceChildren(document.createTextNode(yourTickets.toLocaleString()));
      $("#ps-credit")?.replaceChildren(document.createTextNode((credit / TEN_POW).toLocaleString()));
      $("#ps-spent")?.replaceChildren(document.createTextNode((spent / TEN_POW).toLocaleString()));
      $("#ps-won")?.replaceChildren(document.createTextNode((won / TEN_POW).toLocaleString()));

      panel.hidden = false;
    } catch (e) { console.error("loadPlayerStats", e); }
  }
  setInterval(loadPlayerStats, 15000);

  // -------------------------
  // SPL helpers (defer using Solana libs until present)
  // -------------------------
  // ESM version (uses imported functions & PublicKey)
  async function getOrCreateATA(owner, mintPk, payer) {
    const ownerPk = new PublicKey(owner);
    const mintPkObj = new PublicKey(mintPk);
    const ata = await getAssociatedTokenAddress(mintPkObj, ownerPk);
  
    // check existence via backend endpoint
    let exists = false;
    try {
      const r = await jfetch(`${API}/accounts/${ata.toBase58()}/exists`);
      exists = !!r?.exists;
    } catch (_) {}
  
    if (!exists) {
      // createAssociatedTokenAccountInstruction (imported from @solana/spl-token)
      const ix = createAssociatedTokenAccountInstruction(
        payer,               // payer (publicKey or string)
        ata,                 // associated token account pubkey
        ownerPk,             // owner pubkey
        mintPkObj            // mint pubkey
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

  // Robust wallet send helper — supports several provider APIs
  async function sendSignedTransaction(tx) {
    // Ensure feePayer is a PublicKey
    if (tx.feePayer && typeof tx.feePayer === "string") {
      try { tx.feePayer = new PublicKey(tx.feePayer); } catch (e) { /* ignore */ }
    }

    // 1) signAndSendTransaction (Backpack / some providers)
    if (WALLET?.signAndSendTransaction) {
      try {
        const res = await WALLET.signAndSendTransaction(tx);
        return typeof res === "string" ? res : res?.signature;
      } catch (e) {
        console.warn("signAndSendTransaction failed", e);
      }
    }

    // 2) signTransaction (Phantom style) + sendRawTransaction
    if (WALLET?.signTransaction) {
      try {
        const signed = await WALLET.signTransaction(tx);
        const raw = signed.serialize();
        const sig = await connection.sendRawTransaction(raw);
        // confirm
        try { await connection.confirmTransaction(sig, "confirmed"); } catch(_) {}
        return sig;
      } catch (e) {
        console.warn("signTransaction/sendRaw failed", e);
      }
    }

    // 3) sendTransaction (Phantom newer helper)
    if (WALLET?.sendTransaction) {
      try {
        const sig = await WALLET.sendTransaction(tx, connection);
        try { await connection.confirmTransaction(sig, "confirmed"); } catch(_) {}
        return sig;
      } catch (e) {
        console.warn("sendTransaction failed", e);
      }
    }

    throw new Error("Wallet provider does not support known transaction send methods");
  }

  // -------------------------
  // Coin flip UI (local animation + demo)
  // -------------------------
  (function wireCoinFlipUI() {
    const cfPlay = document.getElementById("cf-play");
    if (!cfPlay) return;

    cfPlay.addEventListener("click", async (e) => {
      e.preventDefault();
      const coin = $("#coin");
      if (coin) { coin.classList.remove("spin"); void coin.offsetWidth; coin.classList.add("spin"); }

      // read chosen side from form (but we'll randomize result)
      const form = document.getElementById("bet-form");
      const side = (new FormData(form)).get("side") || "TRICK";

      // create short delay to simulate spin+settle (matches CSS .spin duration)
      setTimeout(() => {
        const landedTreat = Math.random() < 0.5;
        const landed = landedTreat ? "TREAT" : "TRICK";

        // orient coin final face (simple transform; the .spin keyframes handle rotation)
        if (coin) coin.style.transform = landedTreat ? "rotateY(180deg)" : "rotateY(0deg)";

        // FX + banner
        playResultFX(landed);
        showWinBanner(landed === "TREATZ" ? "🎉 TREATZ! You win!" : "💀 TRICKZ! Maybe next time…");

        // status text
        $("#cf-status")?.replaceChildren(document.createTextNode(landed === "TREAT" ? "WIN!" : "LOSS"));

      }, 1150); // matches animation timing
    });
  })();

  // placeCoinFlip: the full backend flow (used when wallet + backend available)
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

      // use imported PublicKey (consistent)
      const mintPk = new PublicKey(CONFIG.token.mint);
      const destAta = new PublicKey(CONFIG.vaults.game_vault_ata || CONFIG.vaults.game_vault);

      // ensure payer is a PublicKey instance
      const payerRaw = PUBKEY;
      const payerPub = (typeof payerRaw === "string") ? new PublicKey(payerRaw) : payerRaw;

      const { ata: srcAta, ix: createSrc } = await getOrCreateATA(payerPub, mintPk, payerPub);
      const ixs = [];
      if (createSrc) ixs.push(createSrc);
      // createTransferCheckedInstruction expects (source, mint, destination, owner, amount, decimals, signers?)
      ixs.push(
        createTransferCheckedInstruction(
          srcAta,           // source ATA (PublicKey)
          mintPk,           // mint (PublicKey)
          destAta,          // dest ATA (PublicKey)
          payerPub,         // owner of source (PublicKey)
          toBaseUnits(amountHuman),
          DECIMALS
        ),
        memoIx(bet.memo)
      );

      // fetch latest blockhash via backend helper
      const bh = (await jfetch(`${API}/cluster/latest_blockhash`)).blockhash;
      const tx = new Transaction({ feePayer: payerPub });
      tx.recentBlockhash = bh;
      tx.add(...ixs);

      // sign & send using robust helper
      const signature = await sendSignedTransaction(tx);
      $("#cf-status")?.replaceChildren(document.createTextNode(signature ? `Sent: ${signature.slice(0, 10)}…` : "Sent"));

      // Spin + FX
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
          playResultFX(win ? "TREAT" : "TRICK");
          showWinBanner(win ? "🎉 TREATZ! You win!" : "💀 TRICKZ! Maybe next time…");
          $("#cf-status")?.replaceChildren(document.createTextNode(win ? "WIN!" : "LOSS"));
          return;
        }
      } catch { }
    }
    $("#cf-status")?.replaceChildren(document.createTextNode("Waiting for network / webhook…"));
  }

  // -------------------------
  // Jackpot / Raffle UI
  // -------------------------
  document.getElementById("jp-buy")?.addEventListener("click", async () => {
    try {
      // until wallet plumbing is fully enabled, disallow purchases
      if (!PUBKEY) { toast("Connect wallet to buy tickets"); return; }
      // full buy flow would be placedCoinFlip-style and use getOrCreateATA, transfers, and memo
      toast("Ticket purchase flow requires wallet plumbing — coming soon");
    } catch (e) {
      console.error(e);
      alert(e?.message || "Ticket purchase failed.");
    }
  });

  (async function initRaffleUI() {
    const errOut = (where, message) => {
      console.error(`[raffle:${where}]`, message);
      const schedule = document.getElementById("raffle-schedule");
      if (schedule) {
        schedule.textContent = `⚠️ ${message}`;
        schedule.style.color = "#ff9b9b";
      }
    };

    try {
      // load config (backend-controlled schedule & ticket price)
      const cfg = await jfetchStrict(`${API}/config?include_balances=true`);
      CONFIG = cfg;
      const decimals = Number(cfg?.token?.decimals ?? 6);
      DECIMALS = decimals;
      TEN_POW = 10 ** DECIMALS;

      const durationMin = Number(cfg?.raffle?.duration_minutes ?? cfg?.raffle?.round_minutes ?? 10);
      const breakMin = Number(cfg?.raffle?.break_minutes ?? 2);

      // ticket price display
      const priceBase = Number(cfg?.token?.ticket_price ?? 0);
      if (priceBase && document.getElementById("ticket-price")) {
        document.getElementById("ticket-price").textContent = (priceBase / TEN_POW).toLocaleString();
      }

      // current round
      const round = await jfetchStrict(`${API}/rounds/current`);
      const elPot = document.getElementById("round-pot");
      const elId = document.getElementById("round-id");
      const elClose = document.getElementById("round-countdown");
      const elNext = document.getElementById("round-next-countdown");
      const elProg = document.getElementById("jp-progress");
      const schedEl = document.getElementById("raffle-schedule");

      const iso = (s) => String(s || "").replace(" ", "T").replace(/\.\d+/, "").replace(/Z?$/, "Z");
      const opensAt = new Date(iso(round.opens_at));
      const closesAt = new Date(iso(round.closes_at));

      const nextOpenIso = cfg?.timers?.next_opens_at ? iso(cfg.timers.next_opens_at) : null;
      const nextOpensAt = nextOpenIso ? new Date(nextOpenIso) : new Date(closesAt.getTime() + breakMin * 60 * 1000);

      if (elId) elId.textContent = round.round_id;
      if (elPot) elPot.textContent = (Number(round.pot || 0) / TEN_POW).toLocaleString();

      if (schedEl) {
        schedEl.textContent = `Each round: ${durationMin} min • Break: ${breakMin} min • Next opens: ${nextOpensAt.toLocaleTimeString()}`;
      }

      const fmtClock = (ms) => { if (ms < 0) ms = 0; const s = Math.floor(ms / 1000); const h = String(Math.floor((s % 86400) / 3600)).padStart(2, "0"); const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0"); const sec = String(s % 60).padStart(2, "0"); return `${h}:${m}:${sec}`; };
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

      // recent rounds
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
            li.innerHTML = `<span><b>${r.id}</b> • ${potHuman} ${TOKEN.symbol}</span> ${metaStr}`;
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

    } catch (e) {
      errOut("init", e.message || e);
    }
  })();

  // -------------------------
  // History table load
  // -------------------------
  async function loadHistory(query = "") {
    const tbody = document.querySelector("#history-table tbody"); if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;
    try {
      // server provides /rounds/recent; use that for search/listing
      // we request a reasonable limit and then fetch individual winner details
      const q = new URL(`${API}/rounds/recent`, location.origin);
      q.searchParams.set("limit", "25");
      // If you later add a real search param server-side, you can append it here
      const res = await fetch(q.toString(), { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const recent = await res.json(); // expecting array [{ id, pot }, ...]
      if (!Array.isArray(recent) || recent.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="muted">No history.</td></tr>`;
        return;
      }
  
      const rows = [];
      for (const r of recent) {
        // r.id is expected; some servers return 'id' or 'round_id' — normalize:
        const roundId = r.id || r.round_id || r[0] || "unknown";
        // fetch winner/details (swallow errors)
        let w = null;
        try { w = await jfetchStrict(`${API}/rounds/${encodeURIComponent(roundId)}/winner`); } catch (e) { /* ignore per-row errors */ }
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
    // debounce 200ms
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
    } catch (e) {
      console.warn("could not load edge info", e);
    }
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

  // Expose a few utilities for debugging
  window.TREATZ = window.TREATZ || {};
  window.TREATZ.playResultFX = playResultFX;
  window.TREATZ.rainTreatz = rainTreatz;
  window.TREATZ.hauntTrick = hauntTrick;
  window.TREATZ.announceLastWinner = announceLastWinner;

})();