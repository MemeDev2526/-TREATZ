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

  // fetch helper (throws on !ok)
  async function jfetch(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }

/* ────────────────────────────────────────────────────────
   1) FX: Wrappers / Candy / Ghosts
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
  <text x="42" y="26" text-anchor="middle" font-family="Luckiest Guy, Creepster, sans-serif" font-size="16" fill="#fff" class="w3">$TREATZ</text>
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

  // Coin faces from images
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

  // Win banner (cute, brief)
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
    return new Date(year, 9, 31, 23, 59, 59, 0); // local time
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

  // run regardless of script load order
  initHalloweenCountdown();
  document.addEventListener("DOMContentLoaded", initHalloweenCountdown);
  window.addEventListener("load", initHalloweenCountdown);

/* ────────────────────────────────────────────────────────
   3) Static links, logo/mascot assets, token copy
   ──────────────────────────────────────────────────────── */
  const link = (id, href) => { const el = document.getElementById(id); if (el && href) el.href = href; };
  link("link-telegram",  C.links?.telegram);
  link("link-twitter",   C.links?.twitter);
  link("link-tiktok",    C.links?.tiktok);       // NEW
  link("link-whitepaper",C.links?.whitepaper);
  link("btn-buy",        C.buyUrl);

  // Deep-link button(s): show only on mobile with NO provider and when NOT connected
  const deepLinks = [
    document.getElementById("btn-open-in-phantom"),
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

  // Countdown logo + mascot
  const cdLogo  = $("#countdown-logo");
  if (C.assets?.logo && cdLogo) {
    cdLogo.src  = C.assets.logo;
    cdLogo.alt  = "$TREATZ";
  }

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
   4) Wallet plumbing (multi-wallet; Phantom/Solflare/Backpack)
   ──────────────────────────────────────────────────────── */

  // Provider getters (robust to new injection paths)
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
    if (name === "phantom"  && ph?.isPhantom)        return ph;
    if (name === "solflare" && window.solflare?.isSolflare) return window.solflare;
    if (name === "backpack" && window.backpack?.solana)     return window.backpack.solana;
    return null;
  };

  // Simple modal control (matches your HTML/CSS)
  const modal = document.getElementById("wallet-modal");
  function openWalletModal(){ if (modal) modal.hidden = false; }
  function closeWalletModal(){ if (modal) modal.hidden = true; }
  modal?.addEventListener("click", (e)=>{ if (e.target.matches("[data-close], .wm__backdrop")) closeWalletModal(); });
  document.addEventListener("keydown", (e)=>{ if (e.key === "Escape") closeWalletModal(); });

  // Modal list click → connect
  modal?.addEventListener("click", (e)=>{
    const b = e.target.closest(".wm__item[data-wallet]");
    if (!b) return;
    const w = b.getAttribute("data-wallet");
    closeWalletModal();
    connectWallet(w).catch(console.error);
  });

  const MEMO_PROGRAM_ID = new solanaWeb3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  const CONNECTION = new solanaWeb3.Connection(
    (window.TREATZ_CONFIG?.rpcUrl || "https://api.mainnet-beta.solana.com"),
    "confirmed"
  );

  let WALLET = null;     // provider
  let PUBKEY = null;     // solanaWeb3.PublicKey
  let CONFIG = null;     // /api/config payload
  let DECIMALS = TOKEN.decimals;
  let TEN_POW = 10 ** DECIMALS;

  const toBaseUnits   = (human) => Math.floor(Number(human) * TEN_POW);
  const fromBaseUnits = (base)  => Number(base) / TEN_POW;

  function onProviderConnect(pk) {
    try {
      const k = pk?.toString?.() || pk?.publicKey?.toString?.() || WALLET?.publicKey?.toString?.();
      if (k) PUBKEY = new solanaWeb3.PublicKey(k);
    } catch {}
    setWalletLabels();
    setTimeout(loadPlayerStats, 400);
  }

  function onProviderDisconnect() {
    PUBKEY = null;
    setWalletLabels();
  }

  function wireProvider(p) {
    try {
      p?.on?.("connect",        (pubkey) => onProviderConnect(pubkey || p.publicKey));
      p?.on?.("disconnect",     onProviderDisconnect);
      p?.on?.("accountChanged", (pubkey) => onProviderConnect(pubkey));
    } catch {}
  }

  async function connectWallet(preferred) {
    if (PUBKEY) return PUBKEY;

    // must be called in direct user gesture; callers should be click handlers
    const order = [preferred, "phantom", "solflare", "backpack"].filter(Boolean);
    for (const name of order) {
      const p = getProviderByName(name);
      if (!p) continue;

      let res;
      try {
        res = await p.connect({ onlyIfTrusted: false });
      } catch (e) {
        // user closed or rejected; try next provider
        continue;
      }

      WALLET = p;
      wireProvider(p);

      const got = (res?.publicKey?.toString?.() || res?.publicKey || res || p.publicKey)?.toString?.();
      if (!got) throw new Error("Wallet did not return a public key.");
      PUBKEY = new solanaWeb3.PublicKey(got);

      setWalletLabels();
      setTimeout(loadPlayerStats, 500);
      return PUBKEY;
    }

    // No provider found → install or deep link
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
    const btnConnect = document.getElementById("btn-connect");
    const btnOpen    = document.getElementById("btn-openwallet");
    if (!btnConnect || !btnOpen) return;

    if (PUBKEY) {
      const short = PUBKEY.toBase58().slice(0,4)+"…"+PUBKEY.toBase58().slice(-4);
      btnConnect.textContent = "Disconnect";
      btnOpen.textContent    = `Wallet (${short})`;
      btnOpen.hidden = false;
    } else {
      btnConnect.textContent = "Connect Wallet";
      btnOpen.hidden = true;
    }
    updateDeepLinkVisibility();
  }

  async function ensureConfig() {
    if (!CONFIG) {
      const r = await jfetch(`${API}/config?include_balances=true`);
      CONFIG = r;
      DECIMALS = Number(CONFIG?.token?.decimals || TOKEN.decimals || 6);
      TEN_POW  = 10 ** DECIMALS;
    }
    return CONFIG;
  }

  // PRIMARY connect button (modal-first logic)
  document.getElementById("btn-connect")?.addEventListener("click", async () => {
    try {
      if (PUBKEY) { await disconnectWallet(); return; }

      const present = [
        getPhantomProvider()  && "phantom",
        getSolflareProvider() && "solflare",
        getBackpackProvider() && "backpack",
      ].filter(Boolean);

      if (present.length === 0) {           // no providers → show modal + deep link
        openWalletModal();
        updateDeepLinkVisibility();
        return;
      }
      if (present.length === 1) {           // exactly one → connect immediately
        await connectWallet(present[0]);
        return;
      }
      openWalletModal();                     // 2+ → let the user pick
    } catch (err) {
      console.error("[btn-connect] error", err);
      alert(err.message || "Failed to open wallet.");
    }
  });

  // (Optional) legacy dropdown fallback (if present in DOM)
  const menu = document.getElementById("wallet-menu");
  menu?.addEventListener("click", (e)=>{
    const b = e.target.closest("button[data-wallet]");
    if (!b) return;
    const w = b.getAttribute("data-wallet");
    menu.hidden = true;
    connectWallet(w).catch(err=>console.error(err));
  });

  document.getElementById("btn-openwallet")?.addEventListener("click", async ()=>{
    try {
      if (!PUBKEY) { await connectWallet("phantom"); return; }
      const short = PUBKEY.toBase58().slice(0,4)+"…"+PUBKEY.toBase58().slice(-4);
      alert(`Connected: ${short}`);
    } catch (e) { console.error(e); }
  });

  setWalletLabels();
  document.addEventListener("DOMContentLoaded", updateDeepLinkVisibility);
  window.addEventListener("load", updateDeepLinkVisibility);

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

      const you = (entries || []).filter(e=> String(e.user).toLowerCase() === String(PUBKEY.toBase58()).toLowerCase());
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
    const info = await CONNECTION.getAccountInfo(ata);
    if (!info) {
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

  const MEMO_PROGRAM_ID_CONST = MEMO_PROGRAM_ID; // alias for clarity
  const memoIx = (memoStr) => {
    const data = new TextEncoder().encode(memoStr);
    return new solanaWeb3.TransactionInstruction({ programId: MEMO_PROGRAM_ID_CONST, keys: [], data });
  };

/* ────────────────────────────────────────────────────────
   7) Coin Flip — place wager
   ──────────────────────────────────────────────────────── */
  document.getElementById("bet-form")?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    try {
      await ensureConfig();
      if (!PUBKEY) await connectWallet("phantom");
  
      const amountHuman = Number(document.getElementById("bet-amount").value || "0");
      const side = (new FormData(e.target).get("side") || "TRICK").toString();
      if (!amountHuman || amountHuman <= 0) throw new Error("Enter a positive amount.");
  
      const bet = await jfetch(`${API}/bets`, {
        method: "POST",
        headers: { "content-type":"application/json" },
        body: JSON.stringify({ amount: toBaseUnits(amountHuman), side })
      });

      const betId = bet.bet_id; // NEW: keep for polling
  
      $("#bet-deposit").textContent = bet.deposit;
      $("#bet-memo").textContent    = bet.memo;
  
      const mintPk = new solanaWeb3.PublicKey(CONFIG.token.mint);
      const gameAtaStr = CONFIG?.vaults?.game_vault_ata;
      if (!gameAtaStr) throw new Error("Game vault ATA not configured on the server.");
      const destAta = new solanaWeb3.PublicKey(gameAtaStr);
      const payer = PUBKEY;
  
      const { ata: srcAta, ix: createSrc } = await getOrCreateATA(payer, mintPk, payer);
      const ixs = [];
      if (createSrc) ixs.push(createSrc);
      ixs.push(
        splToken.createTransferInstruction(
          srcAta, destAta, payer, toBaseUnits(amountHuman), [], splToken.TOKEN_PROGRAM_ID
        ),
        memoIx(bet.memo)
      );

   (

  // Visual spin + FX button
  $("#cf-play")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const coin = $("#coin"); if (!coin) return;
    coin.classList.remove("spin"); void coin.offsetWidth; coin.classList.add("spin");
    rainTreatz({ count: 22 });
    setTimeout(() => {
      const side = (new FormData(document.getElementById("bet-form"))).get("side") || "TRICK";
      playResultFX(side);
      const msg = side === "TREAT" ? "🎉 TREATZ! You win!" : "💀 TRICKZ! Maybe next time…";
      showWinBanner(msg);
    }, 1120);
  });

  // NEW: neutralize dead "#" anchors globally
  document.querySelectorAll('a[href="#"]').forEach(a =>
    a.addEventListener("click", ev => ev.preventDefault())
  );

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

      const mintPk = new solanaWeb3.PublicKey(CONFIG.token.mint);
      const jackAtaStr = CONFIG?.vaults?.jackpot_vault_ata;
      if (!jackAtaStr) throw new Error("Jackpot vault ATA not configured on the server.");
      const destAta = new solanaWeb3.PublicKey(jackAtaStr);
      const payer = PUBKEY;

      const { ata: srcAta, ix: createSrc } = await getOrCreateATA(payer, mintPk, payer);
      const ixs = [];
      if (createSrc) ixs.push(createSrc);
      ixs.push(
        splToken.createTransferInstruction(srcAta, destAta, payer, amountBase, [], splToken.TOKEN_PROGRAM_ID),
        memoIx(memoStr)
      );

      const { blockhash } = await CONNECTION.getLatestBlockhash("finalized");
      const tx = new solanaWeb3.Transaction({ feePayer: payer });
      tx.recentBlockhash = blockhash;
      tx.add(...ixs);

      const sigRes = await WALLET.signAndSendTransaction(tx);
      const signature = typeof sigRes === "string" ? sigRes : sigRes?.signature;
      alert(`Tickets purchased! Tx: ${signature ? signature.slice(0,8) + "…" : "pending"}`);
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
        .replace(/\.\d+/, "")   // strip microseconds
      .replace(/Z?$/, "Z");   // force Z
      const opensAt     = new Date(sanitizeISO(round.opens_at));
      const closesAt    = new Date(sanitizeISO(round.closes_at));
      const nextOpensAt = new Date(sanitizeISO(cfg?.timers?.next_opens_at) || (closesAt.getTime() + (cfg?.raffle?.break_minutes||0)*60*1000));
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

      // Recent rounds
      const list = $("#recent-rounds");
      async function loadRecent(){
        if (!list) return;
        list.innerHTML = `<li class="muted">Loading…</li>`;
        try {
          const recent = await jfetch(`${API}/rounds/recent?limit=10`);
          list.innerHTML = "";
          recent.forEach(r=>{
            const li = document.createElement("li");
            li.className = "mini-table__row";
            li.innerHTML = `
              <span>#${r.id}</span>
              <span>${(Number(r.pot||0)/TEN_POW).toLocaleString()}</span>
              <button class="btn btn--ghost" data-r="${r.id}">Proof</button>
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
          `Winner: ${p.winner || "TBD"}`,
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
   9) History table, House edge, Misc ambience
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
          <td>${fmtUnits(r.pot, TOKEN.decimals)} ${TOKEN.symbol}</td>
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
        toast(`Winner: ${w.winner.slice(0,4)}… — Pot ${fmtUnits(w.pot, TOKEN.decimals)} ${TOKEN.symbol}`);
      }
    } catch(e){ console.error(e); }
  }

  function armAmbient(){
    const a = document.getElementById("bg-ambient"); 
    if (!a) return;

    // ensure a real src exists (from config or default)
    if (!a.src) {
      const cfgSrc = (window.TREATZ_CONFIG?.assets?.ambient) || a.getAttribute("data-src") || "assets/ambient.mp3";
      a.src = cfgSrc;
    }

    a.muted = true; a.volume = 0; a.loop = true;

    const start = async ()=>{
      try { await a.play(); } catch { /* Safari blocks until gesture; we’re inside one */ }
      a.muted = false;

      // fade in
      let v = 0, tgt = 0.12;
      const fade = () => { v = Math.min(tgt, v + 0.02); a.volume = v; if (v < tgt) requestAnimationFrame(fade); };
      requestAnimationFrame(fade);

      ["click","touchstart","keydown"].forEach(evName=>document.removeEventListener(evName, start));
    };

    ["click","touchstart","keydown"].forEach(evName=>document.addEventListener(evName, start, { passive:true }));
  }
  armAmbient();

/* ────────────────────────────────────────────────────────
   10) Boot
   ──────────────────────────────────────────────────────── */
  initHalloweenCountdown();
  document.addEventListener("DOMContentLoaded", initHalloweenCountdown);

})(); // IIFE
