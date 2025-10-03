// ===== $TREATZ emergency diagnostics =====
(function(){
  if (!window.__TREATZ_DEBUG) return;

  function showDiag(msg, kind){
    if (!document.body) { document.addEventListener("DOMContentLoaded", () => showDiag(msg, kind)); return; }
    var bar = document.getElementById("__treatz_diag");
    if (!bar){
      bar = document.createElement("div");
      bar.id = "__treatz_diag";
      bar.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:99999;padding:10px 14px;font:14px/1.3 Rubik,system-ui,sans-serif;color:#fff;background:#c01;box-shadow:0 6px 20px rgba(0,0,0,.5)";
      document.body.appendChild(bar);
    }
    var span = document.createElement("div");
    span.textContent = "[TREATZ] " + msg;
    if (kind==="ok") { span.style.color = "#0f0"; }
    bar.appendChild(span);
  }

  window.addEventListener("error", (e)=> showDiag("JS error: " + (e.message||e.type), "err"));
  window.addEventListener("unhandledrejection", (e)=> showDiag("Promise rejection: " + (e.reason && e.reason.message || e.reason), "err"));

  document.addEventListener("DOMContentLoaded", async function(){
    try {
      showDiag("Booting diagnostics…");
      if (!window.solanaWeb3) showDiag("solanaWeb3 (web3.js) not loaded", "err"); else showDiag("web3.js ✓", "ok");
      if (!window.splToken)   showDiag("spl-token IIFE not loaded", "err");      else showDiag("@solana/spl-token ✓", "ok");

      var C = window.TREATZ_CONFIG || {};
      var API = (C.apiBase || "/api").replace(/\/$/, "");
      showDiag("API = " + API);
      try {
        const r = await fetch(API + "/health", {mode:"cors"});
        if (!r.ok) throw new Error(r.status+" "+r.statusText);
        const j = await r.json();
        showDiag("API /health OK (ts="+j.ts+")", "ok");
      } catch (e) {
        showDiag("API not reachable: " + (e.message || e), "err");
      }

      var btn1 = document.getElementById("btn-connect");
      var btn2 = document.getElementById("btn-connect-2");
      if (!btn1 && !btn2) showDiag("Connect buttons not found in DOM", "err"); else showDiag("Connect buttons present ✓", "ok");

      [btn1, btn2].filter(Boolean).forEach(b=>{
        b.addEventListener("click", function(){ showDiag("Connect button clicked (smoke)"); }, {once:true});
      });

      var a = document.getElementById("bg-ambient");
      if (!a) showDiag("Ambient audio element missing", "err"); else showDiag("Ambient audio tag ✓", "ok");
    } catch (e) {
      showDiag("Diagnostics failed: " + (e.message || e), "err");
    }
  });
})();

/* =========================================================
   $TREATZ — App Logic (clean + organized)
   ========================================================= */
(function () {
  "use strict";

  console.log("TREATZ app boot", {
    build: window.TREATZ_BUILD,
    hasPhantom: !!(window.phantom?.solana || window.solana),
    hasSolflare: !!window.solflare,
    hasBackpack: !!window.backpack?.solana
  });

  // Guard: alias globals and fail noiselessly if libs are missing
  const SolanaWeb3 = window.solanaWeb3;
  const splToken   = window.splToken;
  if (!SolanaWeb3 || !splToken) {
    console.error("[TREATZ] Solana libs missing — app will wait for loader.");
    return;
  }

/* ────────────────────────────────────────────────────────
   0) Config, Constants, Tiny Helpers
   ──────────────────────────────────────────────────────── */
  const C        = window.TREATZ_CONFIG || {};
  const API      = (C.apiBase || "/api").replace(/\/$/, "");
  const TOKEN    = C.token || { symbol: "$TREATZ", decimals: 6 };

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const pow10 = (n) => Math.pow(10, n);

  const fmtUnits = (units, decimals = TOKEN.decimals) => {
    if (units == null) return "—";
    const t = Number(units) / pow10(decimals);
    return t >= 1 ? t.toFixed(2) : t.toFixed(4);
  };

  const toast = (msg) => {
    let t = document.createElement("div");
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
    requestAnimationFrame(()=> t.style.opacity = 1);
    setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.remove(), 250); }, 2200);
  };

  const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const phantomDeepLinkForThisSite = () => {
    const url = location.href.split('#')[0];
    return `https://phantom.app/ul/browse/${encodeURIComponent(url)}`;
  };

  async function jfetch(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }

/* ────────────────────────────────────────────────────────
   1) FX + UI sugar
   ──────────────────────────────────────────────────────── */
  const fxRoot = (() => {
    let n = document.getElementById("fx-layer");
    if (!n) { n = document.createElement("div"); n.id = "fx-layer"; document.body.appendChild(n); }
    return n;
  })();

  const rand = (min, max) => Math.random() * (max - min) + min;

  const svgWrapper = () => `
<svg width="84" height="40" viewBox="0 0 84 40" xmlns="http://www.w3.org/2000/svg">
  <path class="w1" d="M8 14 L0 8 L8 10 L6 2 L14 12 Z"/>
  <rect class="w2" x="14" y="6" rx="6" ry="6" width="56" height="28"/>
  <path class="w1" d="M76 26 L84 32 L76 30 L78 38 L70 28 Z"/>
  <text x="42" y="26" text-anchor="middle" font-family="Creepster, Luckiest Guy, sans-serif" font-size="16" fill="#fff" class="w3">$TREATZ</text>
</svg>`;

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
    el.style.setProperty("--x", `${xvw}vw`);
    el.style.setProperty("--dur", `${duration}s`);
    el.style.left = `calc(${xvw}vw - 24px)`;
    el.style.top = `-60px`;
    el.style.transform = `translate(${xvw}vw, -10%) rotate(${Math.floor(rand(-30,30))}deg)`;
    el.style.setProperty("--r0", `${Math.floor(rand(-90,90))}deg`);
    el.style.setProperty("--r1", `${Math.floor(rand(240,720))}deg`);
    el.style.scale = String(sizeScale);

    const svg =
      kind === "fx-wrapper" ? svgWrapper() :
      kind === "fx-candy"   ? svgCandy()   :
      kind === "fx-ghost"   ? svgGhost()   :
      svgSkull();

    el.innerHTML = svg;
    fxRoot.appendChild(el);
    setTimeout(() => el.remove(), duration * 1000 + 200);
  }

  function rainTreatz({count=24, wrappers=true, candies=true, minDur=5, maxDur=8} = {}) {
    for (let i=0; i<count; i++){
      const x = rand(0, 100);
      const scale = rand(0.8, 1.25);
      const dur = rand(minDur, maxDur);
      if (wrappers) spawnPiece("fx-wrapper", x, scale, dur);
      if (candies)  spawnPiece("fx-candy",   x+rand(-4,4), rand(.7,1.1), dur+rand(-.5,.5));
    }
  }

  function hauntTrick({count=10, ghosts=true, skulls=true} = {}) {
    for (let i=0; i<count; i++){
      const x = rand(5, 95);
      const scale = rand(0.8, 1.3);
      const dur = rand(6, 9);
      if (ghosts) spawnPiece("fx-ghost", x, scale, dur);
      if (skulls) spawnPiece("fx-skull", x+rand(-6,6), rand(.9,1.2), dur+rand(-.7,.7));
    }
  }

  function playResultFX(result){
    if (String(result).toUpperCase() === "TRICK") {
      hauntTrick({count: 12});
      document.body.classList.add('flash');
      setTimeout(()=>document.body.classList.remove('flash'), 1200);
    } else {
      rainTreatz({count: 28, minDur: 4.5, maxDur: 7});
    }
  }
  window.playResultFX = playResultFX;

  function setCoinFaces(treatImg, trickImg) {
    const front = document.querySelector(".coin__face--front");
    const back  = document.querySelector(".coin__face--back");
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
  document.addEventListener("DOMContentLoaded", ()=>{
    setCoinFaces("assets/coin_treatz.png", "assets/coin_trickz.png");
  });

  function showWinBanner(text) {
    const el = document.createElement("div");
    el.textContent = text;
    Object.assign(el.style, {
      position:"fixed", left:"50%", top:"18px", transform:"translateX(-50%)",
      background:"linear-gradient(90deg,#2aff6b,#9bff2a)",
      color:"#032316", padding:"10px 14px", fontWeight:"900",
      borderRadius:"999px", zIndex:10000, boxShadow:"0 8px 24px rgba(0,0,0,.35)"
    });
    document.body.appendChild(el);
    setTimeout(()=>{ el.style.opacity="0"; el.style.transition="opacity .35s"; setTimeout(()=>el.remove(), 400); }, 1800);
  }

/* ────────────────────────────────────────────────────────
   2) Countdown (Halloween)
   ──────────────────────────────────────────────────────── */
  function nextHalloween() {
    const now  = new Date();
    const m    = now.getMonth(); // 0..11, Oct = 9
    const d    = now.getDate();
    const year = (m > 9 || (m === 9 && d >= 31)) ? now.getFullYear() + 1 : now.getFullYear();
    return new Date(year, 9, 31, 23, 59, 59, 0);
  }

  function formatDHMS(ms){
    let s = Math.max(0, Math.floor(ms/1000));
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600);  s %= 3600;
    const m = Math.floor(s / 60);    s %= 60;
    return `${d}d ${String(h).padStart(2,"0")}h ${String(m).padStart(2,"0")}m ${String(s).padStart(2,"0")}s`;
  }

  function initHalloweenCountdown(){
    try{
      const timerEl = document.getElementById("countdown-timer");
      const omenEl  = document.getElementById("countdown-omen");
      if (!timerEl) return;

      const omens = [
        "The wrappers rustle. Something’s awake.",
        "Candy fog thickens… footsteps in the mist.",
        "Lanterns flicker. The ritual nears.",
        "Whispers from the vault… tickets scratch.",
        "A second game stirs beneath the moon.",
        "The cauldron hums. Keys turn in the dark.",
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
      window.__treatz_cd_omen  && clearInterval(window.__treatz_cd_omen);
      window.__treatz_cd_omen  = setInterval(rotate, 12000);
    }catch(e){ console.error("Countdown init failed", e); }
  }

  initHalloweenCountdown();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) initHalloweenCountdown();
  });

/* ────────────────────────────────────────────────────────
   3) Static links, assets, token copy
   ──────────────────────────────────────────────────────── */
  const link = (id, href) => { const el = document.getElementById(id); if (el && href) el.href = href; };
  link("link-telegram",  C.links?.telegram);
  link("link-twitter",   C.links?.twitter);
  link("link-tiktok",    C.links?.tiktok);
  link("link-whitepaper",C.links?.whitepaper);
  link("btn-buy",        C.buyUrl);

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
  updateDeepLinkVisibility();
  document.addEventListener("DOMContentLoaded", updateDeepLinkVisibility);
  window.addEventListener("load", updateDeepLinkVisibility);
 
  const tokenEl = $("#token-address");
  if (tokenEl) tokenEl.textContent = C.tokenAddress || "—";

  const cdLogo  = $("#countdown-logo");
  if (C.assets?.logo && cdLogo) { cdLogo.src = C.assets.logo; cdLogo.alt = "$TREATZ"; }

  const mascotImg = $("#mascot-floater");
  if (mascotImg && C.assets?.mascot) {
    mascotImg.src = C.assets.mascot;
    mascotImg.alt = "Treatz Mascot";
    mascotImg.style.right = "auto";
    mascotImg.style.bottom = "auto";
    mascotImg.style.willChange = "transform";

    const MARGIN = 24;
    let x = 120, y = 120, tx = x, ty = y, t = 0;
    const SPEED = 0.008;

    const pickTarget = () => {
      const w = window.innerWidth, h = window.innerHeight;
      const rect = mascotImg.getBoundingClientRect();
      const elW = rect.width || 96, elH = rect.height || 96;
      tx = MARGIN + Math.random() * Math.max(1, w - elW - MARGIN*2);
      ty = MARGIN + Math.random() * Math.max(1, h - elH - MARGIN*2);
    };

    pickTarget();
    const step = () => {
      t += 1;
      x += (tx - x) * SPEED;
      y += (ty - y) * SPEED;
      if (Math.hypot(tx - x, ty - y) < 4) pickTarget();
      const bobX = Math.sin(t * 0.05) * 10;
      const bobY = Math.cos(t * 0.04) * 8;
      const rot  = Math.sin(t * 0.03) * 4;
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

/* ────────────────────────────────────────────────────────
   4) Wallet plumbing (multi-wallet)
   ──────────────────────────────────────────────────────── */
  function getPhantomProvider(){
    const p = window.phantom?.solana || window.solana;
    return (p && p.isPhantom) ? p : null;
  }
  function getSolflareProvider(){
    return (window.solflare && window.solflare.isSolflare) ? window.solflare : null;
  }
  function getBackpackProvider(){
    return window.backpack?.solana || null;
  }
  const getProviderByName = (name) => {
    name = (name || "").toLowerCase();
    const ph = (window.phantom && window.phantom.solana) || window.solana;
    if (name === "phantom"  && ph?.isPhantom)              return ph;
    if (name === "solflare" && window.solflare?.isSolflare) return window.solflare;
    if (name === "backpack" && window.backpack?.solana)     return window.backpack.solana;
    return null;
  };

  const modal = document.getElementById("wallet-modal");
  function openWalletModal(){ if (modal) modal.hidden = false; }
  function closeWalletModal(){ if (modal) modal.hidden = true; }
  modal?.addEventListener("click", (e)=>{ if (e.target.matches("[data-close], .wm__backdrop")) closeWalletModal(); });
  document.addEventListener("keydown", (e)=>{ if (e.key === "Escape") closeWalletModal(); });

  modal?.addEventListener("click", (e)=>{
    const b = e.target.closest(".wm__item[data-wallet]");
    if (!b) return;
    const w = b.getAttribute("data-wallet");
    closeWalletModal();
    connectWallet(w).catch(console.error);
  });

  const MEMO_PROGRAM_ID = new SolanaWeb3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

  async function fetchLatestBlockhash() {
    const r = await jfetch(`${API}/cluster/latest_blockhash`);
    if (!r?.blockhash) throw new Error("Blockhash unavailable");
    return r.blockhash;
  }
  async function fetchAccountExists(pubkeyStr) {
    const r = await jfetch(`${API}/accounts/${pubkeyStr}/exists`);
    return !!r?.exists;
  }

  let WALLET = null;
  let PUBKEY = null;
  let CONFIG = null;
  let DECIMALS = TOKEN.decimals;
  let TEN_POW = 10 ** DECIMALS;

  const toBaseUnits   = (human) => Math.floor(Number(human) * TEN_POW);
  const fromBaseUnits = (base)  => Number(base) / TEN_POW;

  function onProviderConnect(pk) {
    try {
      const k = pk?.toString?.() || pk?.publicKey?.toString?.() || WALLET?.publicKey?.toString?.();
      if (k) PUBKEY = new SolanaWeb3.PublicKey(k);
    } catch {}
    setWalletLabels();
    setTimeout(loadPlayerStats, 400);
  }
  function onProviderDisconnect() { PUBKEY = null; setWalletLabels(); }
  function wireProvider(p) {
    try {
      p?.on?.("connect",        (pubkey) => onProviderConnect(pubkey || p.publicKey));
      p?.on?.("disconnect",     onProviderDisconnect);
      p?.on?.("accountChanged", (pubkey) => onProviderConnect(pubkey));
    } catch {}
  }

  async function connectWallet(preferred) {
    if (PUBKEY) return PUBKEY;

    const order = [preferred, "phantom", "solflare", "backpack"].filter(Boolean);
    for (const name of order) {
      const p = getProviderByName(name);
      if (!p) continue;

      let res;
      try { res = await p.connect({ onlyIfTrusted: false }); }
      catch { continue; }

      WALLET = p;
      wireProvider(p);

      const got = (res?.publicKey?.toString?.() || res?.publicKey || res || p.publicKey)?.toString?.();
      if (!got) throw new Error("Wallet did not return a public key.");
      PUBKEY = new SolanaWeb3.PublicKey(got);

      setWalletLabels();
      setTimeout(loadPlayerStats, 500);
      return PUBKEY;
    }

    if (isMobile()) {
      location.href = phantomDeepLinkForThisSite();
      throw new Error("Opening in Phantom…");
    } else {
      window.open("https://phantom.app/", "_blank");
      throw new Error("Wallet not found");
    }
  }

  async function disconnectWallet() {
    try { await WALLET?.disconnect(); } catch {}
    PUBKEY = null;
    setWalletLabels();
  }

  function setWalletLabels() {
    const connectBtns = $$("#btn-connect, #btn-connect-2");
    const openBtns    = $$("#btn-openwallet, #btn-openwallet-2");
  
    if (PUBKEY) {
      const short = PUBKEY.toBase58().slice(0,4)+"…"+PUBKEY.toBase58().slice(-4);
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
        TEN_POW  = 10 ** DECIMALS;
      } catch (e) {
        console.error("Failed to load /config", e);
        toast("Backend not reachable (/config). Check CORS & Render logs.");
        throw e;
      }
    }
    return CONFIG;
  }

  $$("#btn-connect, #btn-connect-2").forEach(btn => btn?.addEventListener("click", async () => {
    try {
      if (PUBKEY) { await disconnectWallet(); return; }

      const present = [
        getPhantomProvider()  && "phantom",
        getSolflareProvider() && "solflare",
        getBackpackProvider() && "backpack",
      ].filter(Boolean);

      if (present.length === 1) {
        await connectWallet(present[0]);
        return;
      }

      openWalletModal();
      updateDeepLinkVisibility();

    } catch (err) {
      console.error("[btn-connect] error", err);
      alert(err?.message || "Failed to open wallet.");
    }
  }));

  const menu = document.getElementById("wallet-menu");
  menu?.addEventListener("click", (e)=>{
    const b = e.target.closest("button[data-wallet]");
    if (!b) return;
    const w = b.getAttribute("data-wallet");
    menu.hidden = true;
    connectWallet(w).catch(err=>console.error(err));
  });

  $$("#btn-openwallet, #btn-openwallet-2").forEach(btn => btn?.addEventListener("click", async ()=>{
    try {
      if (!PUBKEY) { await connectWallet("phantom"); return; }
      const short = PUBKEY.toBase58().slice(0,4)+"…"+PUBKEY.toBase58().slice(-4);
      alert(`Connected: ${short}`);
    } catch (e) { console.error(e); }
  }));
  
  setWalletLabels();
 
/* ────────────────────────────────────────────────────────
   5) Ticker + Player Stats
   ──────────────────────────────────────────────────────── */
(function initCoinFlipTicker(){
  const el = document.getElementById("fomo-ticker");
  if (!el) return;

  const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randFrom = (arr) => arr[randInt(0, arr.length - 1)];
  const randWallet = () => {
    const n = () => Array.from({length:4}, ()=> randFrom(ALPH)).join("");
    return `${n()}…${n()}`;
  };
  const fmt = (n) => n.toLocaleString();

  function makeLine(){
    const who = randWallet();
    const isWin = Math.random() < 0.58;
    const amount = [5_000, 10_000, 25_000, 50_000, 75_000, 100_000, 150_000, 250_000, 500_000][randInt(0,8)];
    const verb = isWin ? "won" : "lost";
    const emoji = isWin ? "🎉" : "💀";
    const cls = isWin ? "tick-win" : "tick-loss";
    return `<span class="${cls}">${who} ${verb} ${fmt(amount)} $TREATZ ${emoji}</span>`;
  }

  function buildBatch(len=30){
    const lines = [];
    for (let i=0;i<len;i++) lines.push(makeLine());
    return lines.concat(lines.slice(0,5)).join(" • ");
  }

  function render(){
    el.innerHTML = "";
    const inner = document.createElement("div");
    inner.className = "ticker__inner";
    inner.innerHTML = buildBatch(28) + " • ";
    el.appendChild(inner);
  }

  render();
  setInterval(render, 25000);
})();

  async function loadPlayerStats(){
    const panel = document.getElementById("player-stats");
    if (!panel) return;
    if (!PUBKEY) { panel.hidden = true; return; }

    try{
      await ensureConfig();

      const cur = await jfetch(`${API}/rounds/current`);
      const entries = await jfetch(`${API}/rounds/${cur.round_id}/entries`).catch(()=>[]);

      const me = String(PUBKEY.toBase58()).toLowerCase();
      const you = (entries || []).filter(e=>{
        const u = (e.user || e.user_pubkey || e.address || "").toString().toLowerCase();
        return u === me;
      });
      
      const yourTickets = you.reduce((s,e)=> s + Number(e.tickets||0), 0);

      let credit = 0, spent = 0, won = 0;
      try {
        const c = await jfetch(`${API}/credits/${PUBKEY.toBase58()}`);
        credit = Number(c?.credit || 0);
      } catch {}

      $("#ps-tickets")?.replaceChildren(document.createTextNode(yourTickets.toLocaleString()));
      $("#ps-credit") ?.replaceChildren(document.createTextNode((credit / TEN_POW).toLocaleString()));
      $("#ps-spent")  ?.replaceChildren(document.createTextNode((spent  / TEN_POW).toLocaleString()));
      $("#ps-won")    ?.replaceChildren(document.createTextNode((won    / TEN_POW).toLocaleString()));

      panel.hidden = false;
    }catch(e){ console.error("loadPlayerStats", e); }
  }
  setInterval(loadPlayerStats, 15000);

/* ────────────────────────────────────────────────────────
   6) SPL Helpers (ATA + Memo)
   ──────────────────────────────────────────────────────── */
  async function getOrCreateATA(owner, mintPk, payer) {
    const ata = await splToken.getAssociatedTokenAddress(
      mintPk, owner, false, splToken.TOKEN_PROGRAM_ID, splToken.ASSOCIATED_TOKEN_PROGRAM_ID
    );
    let exists = false;
    try {
      const r = await jfetch(`${API}/accounts/${ata.toBase58()}/exists`);
      exists = !!r?.exists;
    } catch (_){}
    if (!exists) {
      return {
        ata,
        ix: splToken.createAssociatedTokenAccountInstruction(
          payer, ata, owner, mintPk,
          splToken.TOKEN_PROGRAM_ID, splToken.ASSOCIATED_TOKEN_PROGRAM_ID
        )
      };
    }
    return { ata, ix: null };
  }

  const memoIx = (memoStr) => {
    const data = new TextEncoder().encode(memoStr);
    return new SolanaWeb3.TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data });
  };

/* ────────────────────────────────────────────────────────
   7) Coin Flip — place wager
   ──────────────────────────────────────────────────────── */
    $("#cf-play")?.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!PUBKEY) {
       // local demo spin for instant feedback
      const coin = $("#coin"); if (coin) { coin.classList.remove("spin"); void coin.offsetWidth; coin.classList.add("spin"); }
      rainTreatz({ count: 18 });
      const side = (new FormData(document.getElementById("bet-form"))).get("side") || "TRICK";
      playResultFX(side);
      showWinBanner(side === "TREAT" ? "🎉 TREATZ! You win!" : "💀 TRICKZ! Maybe next time…");
    }
    await placeCoinFlip();
  });

  async function placeCoinFlip() {
    try {
      await ensureConfig();
      if (!PUBKEY) await connectWallet("phantom");
  
      const amountHuman = Number(document.getElementById("bet-amount").value || "0");
      const side = (new FormData(document.getElementById("bet-form"))).get("side") || "TRICK";
      if (!amountHuman || amountHuman <= 0) throw new Error("Enter a positive amount.");
  
      const bet = await jfetch(`${API}/bets`, {
        method: "POST",
        headers: { "content-type":"application/json" },
        body: JSON.stringify({ amount: toBaseUnits(amountHuman), side })
      });
      const betId = bet.bet_id;
  
      $("#bet-deposit")?.replaceChildren(document.createTextNode(bet.deposit));
      $("#bet-memo")?.replaceChildren(document.createTextNode(bet.memo));
  
      const mintPk = new SolanaWeb3.PublicKey(CONFIG.token.mint);
      const destAta = new SolanaWeb3.PublicKey(CONFIG.vaults.game_vault_ata || CONFIG.vaults.game_vault);
      const payer   = PUBKEY;
  
      const { ata: srcAta, ix: createSrc } = await getOrCreateATA(payer, mintPk, payer);
      const ixs = [];
      if (createSrc) ixs.push(createSrc);
      ixs.push(
        splToken.createTransferInstruction(
          srcAta, destAta, payer, toBaseUnits(amountHuman), [], splToken.TOKEN_PROGRAM_ID
        ),
        memoIx(bet.memo)
      );
  
      const bh = await fetchLatestBlockhash();
      const tx = new SolanaWeb3.Transaction({ feePayer: payer });
      tx.recentBlockhash = bh;
      tx.add(...ixs);
  
      const sigRes = await WALLET.signAndSendTransaction(tx);
      const signature = typeof sigRes === "string" ? sigRes : sigRes?.signature;
      $("#cf-status")?.replaceChildren(document.createTextNode(signature ? `Sent: ${signature.slice(0,10)}…` : "Sent"));
  
      const coin = $("#coin");
      if (coin) { coin.classList.remove("spin"); void coin.offsetWidth; coin.classList.add("spin"); }
      rainTreatz({ count: 22 });
  
      pollBetUntilSettle(betId).catch(()=>{});
    } catch (e) {
      console.error(e);
      alert(e.message || "Bet failed.");
    }
  }
  
  async function pollBetUntilSettle(betId, timeoutMs = 45_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise(r=>setTimeout(r, 1500));
      try {
        const b = await jfetch(`${API}/bets/${betId}`);
        if ((b.status || "").toUpperCase() === "SETTLED") {
          const win = !!b.win;
          playResultFX(win ? "TREAT" : "TRICK");
          showWinBanner(win ? "🎉 TREATZ! You win!" : "💀 TRICKZ! Maybe next time…");
          $("#cf-status")?.replaceChildren(document.createTextNode(win ? "WIN!" : "LOSS"));
          return;
        }
      } catch {}
    }
    $("#cf-status")?.replaceChildren(document.createTextNode("Waiting for network / webhook…"));
  }

/* ────────────────────────────────────────────────────────
   8) Jackpot — buy tickets + raffle UI
   ──────────────────────────────────────────────────────── */
  document.getElementById("jp-buy")?.addEventListener("click", async ()=>{
    try {
      await ensureConfig();
      if (!PUBKEY) await connectWallet("phantom");

      const nTickets = Math.max(1, Number(document.getElementById("jp-amount").value || "1"));
      const ticketPriceBase = Number(CONFIG?.token?.ticket_price || 0);
      if (!ticketPriceBase) throw new Error("Ticket price unavailable.");
      const amountBase = nTickets * ticketPriceBase;

      const cur = await jfetch(`${API}/rounds/current`);
      const memoStr = `JP:${cur.round_id}`;

      const mintPk = new SolanaWeb3.PublicKey(CONFIG.token.mint);
      const jackAtaStr = CONFIG?.vaults?.jackpot_vault_ata;
      if (!jackAtaStr) throw new Error("Jackpot vault ATA not configured on the server.");
      const destAta = new SolanaWeb3.PublicKey(jackAtaStr);
      const payer = PUBKEY;

      const { ata: srcAta, ix: createSrc } = await getOrCreateATA(payer, mintPk, payer);
      const ixs = [];
      if (createSrc) ixs.push(createSrc);
      ixs.push(
        splToken.createTransferInstruction(srcAta, destAta, payer, amountBase, [], splToken.TOKEN_PROGRAM_ID),
        memoIx(memoStr)
      );

      const bh = await fetchLatestBlockhash();
      const tx = new SolanaWeb3.Transaction({ feePayer: payer });
      tx.recentBlockhash = bh;
      tx.add(...ixs);

      const sigRes = await WALLET.signAndSendTransaction(tx);
      const signature = typeof sigRes === "string" ? sigRes : sigRes?.signature;
      toast(`Tickets purchased! Tx: ${signature ? signature.slice(0,8) + "…" : "pending"}`);
    } catch (e) {
      console.error(e);
      alert(e.message || "Ticket purchase failed.");
    }
  });

  (async function initRaffleUI(){
    try {
      const cfg = await jfetch(`${API}/config?include_balances=true`);
      CONFIG = cfg; DECIMALS = Number(cfg?.token?.decimals || 6); TEN_POW = 10 ** DECIMALS;

      const priceBase = Number(cfg?.token?.ticket_price || 0);
      const elTicket = $("#ticket-price");
      if (elTicket) elTicket.textContent = (priceBase / TEN_POW).toLocaleString();

      const round = await jfetch(`${API}/rounds/current`);

      const elPot   = $("#round-pot");
      const elId    = $("#round-id");
      const elClose = $("#round-countdown");
      const elNext  = $("#round-next-countdown");
      const elProg  = $("#jp-progress");

      if (elId)  elId.textContent  = round.round_id;
      if (elPot) elPot.textContent = (Number(round.pot||0) / TEN_POW).toLocaleString();

      const sanitizeISO = (s) => String(s || "")
        .replace(" ", "T")
        .replace(/\.\d+/, "")
        .replace(/Z?$/, "Z");
      const opensAt     = new Date(sanitizeISO(round.opens_at));
      const closesAt    = new Date(sanitizeISO(round.closes_at));
      const nextVal = cfg?.timers?.next_opens_at
        ? sanitizeISO(cfg.timers.next_opens_at)
        : (closesAt.getTime() + (cfg?.raffle?.break_minutes||0)*60*1000);
      const nextOpensAt = new Date(nextVal);
      const schedEl = document.getElementById("raffle-schedule");
      if (schedEl) {
        const mins = Number(cfg?.raffle?.duration_minutes || 0);
        const brk  = Number(cfg?.raffle?.break_minutes || 0);
        schedEl.textContent = `Each round: ${mins} min • Break: ${brk} min • Next opens: ${nextOpensAt.toLocaleTimeString()}`;
      }
      const fmt = (ms)=>{ if (ms<0) ms=0; const s=Math.floor(ms/1000);
        const h=String(Math.floor((s%86400)/3600)).padStart(2,"0");
        const m=String(Math.floor((s%3600)/60)).padStart(2,"0");
        const sec=String(s%60).padStart(2,"0"); return `${h}:${m}:${sec}`; };
      const clamp01 = (x)=> Math.max(0, Math.min(1, x));

      const tick = ()=>{
        const now = new Date();
        if (elClose) elClose.textContent = fmt(closesAt - now);
        if (elNext)  elNext.textContent  = fmt(nextOpensAt - now);
        if (elProg) {
          const total = closesAt - opensAt;
          const pct = clamp01((now - opensAt) / (total || 1)) * 100;
          elProg.style.width = `${pct}%`;
        }
      };
      tick(); setInterval(tick, 1000);

      const list = $("#recent-rounds");
      document.getElementById("jp-view-all")?.addEventListener("click", () => {
      document.getElementById("raffle-history")?.scrollIntoView({ behavior: "smooth" });
    });
      async function loadRecent(){
        if (!list) return;
        list.innerHTML = `<li class="muted">Loading…</li>`;
        try {
          const recent = await jfetch(`${API}/rounds/recent?limit=10`);
          list.innerHTML = "";
          recent.forEach(r=>{
            const id  = r.round_id ?? r.id;
            const pot = (Number(r.pot||0)/TEN_POW).toLocaleString();
            const li = document.createElement("li");
            li.className = "mini-table__row";
            li.innerHTML = `
              <span>#${id}</span>
              <span>${pot}</span>
              <button class="btn btn--ghost" data-r="${id}">Proof</button>
            `;
            list.appendChild(li);
          });
        } catch { list.innerHTML = `<li class="muted">Failed to load.</li>`; }
      }
      await loadRecent();
      setInterval(loadRecent, 30000);

      list?.addEventListener("click", async (ev)=>{
        const target = ev.target.closest("button[data-r]");
        if (!target) return;
        const rid = target.getAttribute("data-r");
        const p = await jfetch(`${API}/rounds/${rid}/winner`);
        const msg = [
          `Round: ${p.round_id}`,
          `Winner: ${p.winner ? p.winner.slice(0,4)+"…"+p.winner.slice(-4) : "TBD"}`,
          `Pot: ${(Number(p.pot||0)/TEN_POW).toLocaleString()} $TREATZ`,
          `SeedHash: ${p.server_seed_hash || "-"}`,
          `Reveal: ${p.server_seed_reveal ? p.server_seed_reveal.slice(0,10)+"…" : "-"}`,
          `Entropy: ${p.entropy || "-"}`,
          `Tx: ${p.payout_sig || "-"}`,
        ].join("\n");
        alert(msg);
      });
    } catch (e) { console.error("initRaffleUI", e); }
  })();

/* ────────────────────────────────────────────────────────
   9) History + edge + ambience
   ──────────────────────────────────────────────────────── */
  async function loadHistory(query=""){
    const tbody = document.querySelector("#history-table tbody"); if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;
    try {
      const base = await jfetch(`${API}/rounds/recent?limit=10`);
      const ids  = (query && /^R\d+$/i.test(query)) ? base.filter(x=>x.id===query) : base;
      const rows = [];
      for (const r of ids){
        const w = await jfetch(`${API}/rounds/${r.id}/winner`).catch(()=>null);
        rows.push(`<tr>
          <td>#${r.id}</td>
          <td>${fmtUnits(r.pot, DECIMALS)} ${TOKEN.symbol}</td>
          <td>${w?.winner ? w.winner.slice(0,4)+"…"+w.winner.slice(-4) : "—"}</td>
          <td>${w?.payout_sig||"—"}</td>
          <td>${(w?.server_seed_hash||"-").slice(0,10)}…</td>
        </tr>`);
      }
      tbody.innerHTML = rows.join("") || `<tr><td colspan="5">No history.</td></tr>`;
    } catch(e){ console.error(e); }
  }
  document.getElementById("history-search")?.addEventListener("change",(e)=>loadHistory(e.target.value.trim()));
  loadHistory();

  (async()=>{
    await ensureConfig();
    if (CONFIG?.raffle?.splits) {
      const s = CONFIG.raffle.splits;
      const bps = 10000 - (s.winner + s.dev + s.burn);
      const el = document.getElementById("edge-line");
      if (el) el.textContent = `House edge: ${(bps/100).toFixed(2)}%`;
    }
  })();

  async function announceLastWinner(){
    try {
      const recent = await jfetch(`${API}/rounds/recent?limit=1`);
      const rid = recent?.[0]?.id; if (!rid) return;
      const w = await jfetch(`${API}/rounds/${rid}/winner`);
      if (w?.winner){
        toast(`Winner: ${w.winner.slice(0,4)}… — Pot ${fmtUnits(w.pot, DECIMALS)} ${TOKEN.symbol}`);
      }
    } catch(e){ console.error(e); }
  }

  function armAmbient(){
    const a = document.getElementById("bg-ambient"); 
    if (!a) return;

    if (!a.src) {
      const cfgSrc = (window.TREATZ_CONFIG?.assets?.ambient) || a.getAttribute("data-src") || "assets/ambient.mp3";
      a.src = cfgSrc;
    }

    a.muted = true; a.volume = 0; a.loop = true;

    const start = async ()=>{
      try { await a.play(); } catch {}
      a.muted = false;

      let v = 0, tgt = 0.12;
      const fade = () => { v = Math.min(tgt, v + 0.02); a.volume = v; if (v < tgt) requestAnimationFrame(fade); };
      requestAnimationFrame(fade);

      ["click","touchstart","keydown"].forEach(evName=>document.removeEventListener(evName, start));
    };

    ["click","touchstart","keydown"].forEach(evName=>document.addEventListener(evName, start, { passive:true }));
  }
  armAmbient();

})(); // IIFE
