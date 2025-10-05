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

// 2️⃣ RPC connection setup
const RPC_URL = "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

// 3️⃣ Helper functions (can be imported or inline)
export async function getAta(owner, mint) {
  const ata = await getAssociatedTokenAddress(
    new PublicKey(mint),
    new PublicKey(owner)
  );
  console.log("ATA:", ata.toBase58());
  return ata;
}

// expose to window for diagnostics / legacy checks (optional, safe)
if (typeof window !== "undefined") {
  window.solanaWeb3 = window.solanaWeb3 || { Connection, PublicKey, Transaction, TransactionInstruction };
  window.splToken = window.splToken || {
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createTransferCheckedInstruction
  };
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

  const svgWrapper = () => `...`.replace("...", `
<svg width="84" height="40" viewBox="0 0 84 40" xmlns="http://www.w3.org/2000/svg">
  <path class="w1" d="M8 14 L0 8 L8 10 L6 2 L14 12 Z"/>
  <rect class="w2" x="14" y="6" rx="6" ry="6" width="56" height="28"/>
  <path class="w1" d="M76 26 L84 32 L76 30 L78 38 L70 28 Z"/>
  <text x="42" y="26" text-anchor="middle" font-family="Creepster, Luckiest Guy, sans-serif" font-size="16" fill="#fff" class="w3">$TREATZ</text>
</svg>`);

  const svgCandy = () => `
<svg width="42" height="32" viewBox="0 0 42 32" xmlns="http://www.w3.org/2000/svg">
  <path class="c1" d="M4 16 L0 10 L6 12 L6 4 L12 10"/>
  <rect class="c2" x="8" y="6" rx="6" ry="6" width="26" height="20"/>
  <path class="c1" d="M38 16 L42 22 L36 20 L36 28 L30 22"/>
  <rect x="16" y="10" width="10" height="12" rx="3" fill="#0D0D0D" />
</svg>`;

  const svgGhost = () => `
<svg width="44" height="56" viewBox="0 0 44 56" xmlns="http://www.w3.org/2000/svg">
  <path d="M22 2c11 0 20 9 20 20v28c-4-2-8-2-12 0-4-2-8-2-12 0V22C6 11 11 2 22 2z" fill="rgba(200,200,255,.9)"/>
  <circle cx="16" cy="22" r="4" fill="#0D0D0D"/>
  <circle cx="28" cy="22" r="4" fill="#0D0D0D"/>
</svg>`;

  const svgSkull = () => `
<svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
  <path d="M24 4c11 0 20 8 20 18 0 10-9 14-9 18H13c0-4-9-8-9-18C4 12 13 4 24 4z" fill="#f1f1f1"/>
  <circle cx="17" cy="22" r="5" fill="#0D0D0D"/>
  <circle cx="31" cy="22" r="5" fill="#0D0D0D"/>
  <rect x="21" y="30" width="6" height="8" rx="2" fill="#0D0D0D"/>
</svg>`;

  function spawnPiece(kind, xvw, sizeScale, duration) {
    const el = document.createElement("div");
    el.className = `fx-piece ${kind}`;
    el.style.left = `calc(${xvw}vw - 24px)`;
    el.style.top = `-60px`;
    el.style.transform = `translate(${xvw}vw, -10%) rotate(${Math.floor(rand(-30, 30))}deg)`;
    el.style.setProperty("--x", `${xvw}vw`);
    el.style.setProperty("--dur", `${duration}s`);
    el.style.setProperty("--r0", `${Math.floor(rand(-90, 90))}deg`);
    el.style.setProperty("--r1", `${Math.floor(rand(240, 720))}deg`);
    el.style.scale = String(sizeScale);

    const svg =
      kind === "fx-wrapper" ? svgWrapper() :
        kind === "fx-candy" ? svgCandy() :
          kind === "fx-ghost" ? svgGhost() :
            svgSkull();

    el.innerHTML = svg;
    fxRoot.appendChild(el);
    setTimeout(() => el.remove(), (duration * 1000) + 300);
  }

  function rainTreatz({ count = 24, wrappers = true, candies = true, minDur = 5, maxDur = 8 } = {}) {
    for (let i = 0; i < count; i++) {
      const x = rand(0, 100);
      const scale = rand(0.8, 1.25);
      const dur = rand(minDur, maxDur);
      if (wrappers) spawnPiece("fx-wrapper", x, scale, dur);
      if (candies) spawnPiece("fx-candy", x + rand(-4, 4), rand(.7, 1.1), dur + rand(-.5, .5));
    }
  }

  function hauntTrick({ count = 10, ghosts = true, skulls = true } = {}) {
    for (let i = 0; i < count; i++) {
      const x = rand(5, 95);
      const scale = rand(0.8, 1.3);
      const dur = rand(6, 9);
      if (ghosts) spawnPiece("fx-ghost", x, scale, dur);
      if (skulls) spawnPiece("fx-skull", x + rand(-6, 6), rand(.9, 1.2), dur + rand(-.7, .7));
    }
  }

  function playResultFX(result) {
    if (String(result).toUpperCase() === "TRICK") {
      hauntTrick({ count: 12 });
      document.body.classList.add('flash');
      setTimeout(() => document.body.classList.remove('flash'), 1200);
    } else {
      rainTreatz({ count: 28, minDur: 4.5, maxDur: 7 });
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
  document.addEventListener("DOMContentLoaded", () => {
    // set images if assets exist in expected paths
    setCoinFaces("assets/coin_treatz.png", "assets/coin_trickz.png");
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
    return new Date(year, 9, 31, 23, 59, 59, 0);
  }

  function formatDHMS(ms) {
    let s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60); s %= 60;
    return `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
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
        timerEl.textContent = formatDHMS(target - Date.now());
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
    mascotImg.style.left = "30px";
    mascotImg.style.top = "30px";

    const MARGIN = 24;
    let x = 120, y = 120, tx = x, ty = y, t = 0;
    const SPEED = 0.008;

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
      const amount = [5_000, 10_000, 25_000, 50_000, 75_000, 100_000, 150_000, 250_000, 500_000][randInt(0, 8)];
      const verb = isWin ? "won" : "lost";
      const emoji = isWin ? "🎉" : "💀";
      const cls = isWin ? "tick-win" : "tick-loss";
      return `<span class="${cls}">${who} ${verb} ${fmt(amount)} $TREATZ ${emoji}</span>`;
    }

    function buildBatch(len = 30) {
      const lines = [];
      for (let i = 0; i < len; i++) lines.push(makeLine());
      return lines.concat(lines.slice(0, 5)).join(" • ");
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
        showWinBanner(landed === "TREAT" ? "🎉 TREATZ! You win!" : "💀 TRICKZ! Maybe next time…");

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

      const mintPk = new PublicKey(CONFIG.token.mint);
      const destAta = new PublicKey(CONFIG.vaults.game_vault_ata || CONFIG.vaults.game_vault);
      const payer = PUBKEY;

      const { ata: srcAta, ix: createSrc } = await getOrCreateATA(payer, mintPk, payer);
      const ixs = [];
      if (createSrc) ixs.push(createSrc);
      // createTransferCheckedInstruction expects (source, mint, destination, owner, amount, decimals, signers?)
      ixs.push(
        createTransferCheckedInstruction(
          srcAta,           // source ATA (PublicKey)
          mintPk,           // mint (PublicKey)
          destAta,          // dest ATA (PublicKey)
          payer,            // owner of source (PublicKey)
          toBaseUnits(amountHuman),
          DECIMALS
        ),
        memoIx(bet.memo)
      );

      // fetch latest blockhash via backend helper
      const bh = (await jfetch(`${API}/cluster/latest_blockhash`)).blockhash;
      const tx = new Transaction({ feePayer: payer });
      tx.recentBlockhash = bh;
      tx.add(...ixs);

      // sign & send using provider if available
      if (!WALLET?.signAndSendTransaction) throw new Error("Wallet provider doesn't support signAndSendTransaction in this environment");
      const sigRes = await WALLET.signAndSendTransaction(tx);
      const signature = typeof sigRes === "string" ? sigRes : sigRes?.signature;
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
      const recent = await jfetchStrict(`${API}/rounds/recent?limit=10`);
      const items = (query && /^R\d+$/i.test(query)) ? recent.filter(x => String(x.id).toUpperCase() === query.toUpperCase()) : recent;
      const rows = [];
      for (const r of items) {
        let w = null;
        try { w = await jfetchStrict(`${API}/rounds/${r.id}/winner`); } catch (e) { /* ignore */ }
        const potHuman = (Number(r.pot || 0) / TEN_POW).toLocaleString();
        const winner = w?.winner ? w.winner : "—";
        const payout = w?.payout_sig || "—";
        const proof = (w?.server_seed_hash || "-").slice(0, 10) + "…";
        rows.push(`<tr>
          <td>#${r.id}</td>
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
  document.getElementById("history-search")?.addEventListener("change", (e) => loadHistory(e.target.value.trim()));
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
      const cfgSrc = (window.TREATZ_CONFIG?.assets?.ambient) || a.getAttribute("data-src") || "assets/ambient_loop.mp3";
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