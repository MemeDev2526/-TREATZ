<!-- app.js (drop-in) -->
<script>
/* ========= $TREATZ Emergency Diagnostics ========= */
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
      if (document.getElementById("bg-ambient")) showDiag("Ambient audio tag ✓", "ok");
    } catch (e) {
      showDiag("Diagnostics failed: " + (e.message || e), "err");
    }
  });
})();

/* ========= $TREATZ App ========= */
(function () {
  "use strict";

  // ——— 0) Globals / Config (declare BEFORE anything that might read them) ———
  const SolanaWeb3 = window.solanaWeb3 || null;
  const splToken   = window.splToken   || null;

  const C        = window.TREATZ_CONFIG || {};
  const API      = (C.apiBase || "/api").replace(/\/$/, "");
  const TOKEN    = C.token || { symbol: "$TREATZ", decimals: 6 };

  // TDZ-safe early declarations
  let WALLET   = null;
  let PUBKEY   = null;
  let CONFIG   = null;
  let DECIMALS = TOKEN.decimals;
  let TEN_POW  = 10 ** DECIMALS;

  // Utilities
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const pow10 = (n) => Math.pow(10, n);

  function fmtUnits(units, decimals = TOKEN.decimals){
    if (units == null) return "—";
    const t = Number(units) / pow10(decimals);
    return t >= 1 ? t.toFixed(2) : t.toFixed(4);
  }

  const toast = (msg) => {
    let t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    Object.assign(t.style, {
      position: "fixed", right: "16px", bottom: "16px",
      background: "rgba(0,0,0,.75)", color: "#fff",
      padding: "10px 12px", borderRadius: "8px", zIndex: 9999,
      fontFamily: "Rubik,system-ui,sans-serif", fontSize: "14px",
      opacity: 0, transition: "opacity .2s ease"
    });
    document.body.appendChild(t);
    requestAnimationFrame(()=> t.style.opacity = 1);
    setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.remove(), 250); }, 2200);
  };

  const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const phantomDeepLinkForThisSite = () => `https://phantom.app/ul/browse/${encodeURIComponent(location.href.split('#')[0])}`;

  async function jfetchStrict(url, opts){
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }

  // ——— 1) FX + UI sugar ———
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
    el.innerHTML =
      (kind === "fx-wrapper" && svgWrapper()) ||
      (kind === "fx-candy"   && svgCandy())   ||
      (kind === "fx-ghost"   && svgGhost())   ||
      svgSkull();
    fxRoot.appendChild(el);
    setTimeout(() => el.remove(), duration * 1000 + 200);
  }

  function rainTreatz(opts={}) {
    const {count=24, wrappers=true, candies=true, minDur=5, maxDur=8} = opts;
    for (let i=0; i<count; i++){
      const x = rand(0, 100);
      const dur = rand(minDur, maxDur);
      if (wrappers) spawnPiece("fx-wrapper", x, rand(0.8, 1.25), dur);
      if (candies)  spawnPiece("fx-candy",   x+rand(-4,4), rand(.7,1.1), dur+rand(-.5,.5));
    }
  }
  function hauntTrick(opts={}) {
    const {count=10, ghosts=true, skulls=true} = opts;
    for (let i=0; i<count; i++){
      const x = rand(5, 95), dur = rand(6, 9);
      if (ghosts) spawnPiece("fx-ghost", x, rand(0.8, 1.3), dur);
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

  // ——— 2) Countdown ———
  function nextHalloween() {
    const now = new Date();
    const m = now.getMonth(); // Oct=9
    const d = now.getDate();
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
      clearInterval(window.__treatz_cd_timer);   window.__treatz_cd_timer = setInterval(tick, 1000);
      clearInterval(window.__treatz_cd_omen);    window.__treatz_cd_omen  = setInterval(rotate, 12000);
    }catch(e){ console.error("Countdown init failed", e); }
  }
  initHalloweenCountdown();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) initHalloweenCountdown(); });

  // ——— 3) Static links, assets, token copy ———
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

  function getPhantomProvider(){ const p = window.phantom?.solana || window.solana; return (p && p.isPhantom) ? p : null; }
  function getSolflareProvider(){ return (window.solflare && window.solflare.isSolflare) ? window.solflare : null; }
  function getBackpackProvider(){ return window.backpack?.solana || null; }

  function updateDeepLinkVisibility() {
    if (!deepLinks.length) return;
    const href = phantomDeepLinkForThisSite();
    const hasProvider = !!(getPhantomProvider() || getSolflareProvider() || getBackpackProvider());
    // TDZ-safe check for PUBKEY
    const hasPk = (typeof PUBKEY !== "undefined" && PUBKEY);
    const shouldShow = isMobile() && !hasProvider && !hasPk;
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
    const MARGIN = 24; let x = 120, y = 120, tx = x, ty = y, t = 0; const SPEED = 0.008;
    const pickTarget = () => {
      const w = window.innerWidth, h = window.innerHeight;
      const rect = mascotImg.getBoundingClientRect();
      const elW = rect.width || 96, elH = rect.height || 96;
      tx = MARGIN + Math.random() * Math.max(1, w - elW - MARGIN*2);
      ty = MARGIN + Math.random() * Math.max(1, h - elH - MARGIN*2);
    };
    pickTarget();
    const step = () => {
      t += 1; x += (tx - x) * SPEED; y += (ty - y) * SPEED;
      if (Math.hypot(tx - x, ty - y) < 4) pickTarget();
      const bobX = Math.sin(t * 0.05) * 10; const bobY = Math.cos(t * 0.04) * 8; const rot  = Math.sin(t * 0.03) * 4;
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

  // ——— 4) (Kept but Hard-Guarded) Wallet plumbing ———
  const MEMO_PROGRAM_ID = (SolanaWeb3 && SolanaWeb3.PublicKey)
    ? new SolanaWeb3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
    : null;

  async function ensureConfig() {
    if (!CONFIG) {
      const r = await jfetchStrict(`${API}/config?include_balances=true`);
      CONFIG   = r;
      DECIMALS = Number(CONFIG?.token?.decimals || TOKEN.decimals || 6);
      TEN_POW  = 10 ** DECIMALS;
    }
    return CONFIG;
  }

  // ——— 5) Scrolling ticker ———
  (function initCoinFlipTicker(){
    const el = document.getElementById("fomo-ticker");
    if (!el) return;
    const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const ri = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const rf = (arr) => arr[ri(0, arr.length - 1)];
    const randWallet = () => { const n = () => Array.from({length:4}, ()=> rf(ALPH)).join(""); return `${n()}…${n()}`; };
    const fmt = (n) => n.toLocaleString();
    function makeLine(){
      const who = randWallet();
      const isWin = Math.random() < 0.58;
      const amount = [5_000, 10_000, 25_000, 50_000, 75_000, 100_000, 150_000, 250_000, 500_000][ri(0,8)];
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
      inner.className = "ticker__inner";            // IMPORTANT: match CSS animation class
      inner.innerHTML = buildBatch(28) + " • ";
      el.appendChild(inner);
    }
    render();
    setInterval(render, 25000);
  })();

  // ——— 6) Coin Flip (frontend-only spin + FX for now) ———
  $("#cf-play")?.addEventListener("click", (e) => {
    e.preventDefault();
    const coin = $("#coin");
    if (coin) { coin.classList.remove("spin"); void coin.offsetWidth; coin.classList.add("spin"); }
    const form = document.getElementById("bet-form");
    const side = (new FormData(form)).get("side") || "TRICK";
    setTimeout(() => {
      const landedTreat = Math.random() < 0.5;
      const landed = landedTreat ? "TREAT" : "TRICK";
      if (coin) coin.style.transform = landedTreat ? "rotateY(180deg)" : "rotateY(0deg)";
      playResultFX(landed);
      showWinBanner(landed === "TREAT" ? "🎉 TREATZ! You win!" : "💀 TRICKZ! Maybe next time…");
      $("#cf-status")?.replaceChildren(document.createTextNode(landed === "TREAT" ? "WIN!" : "LOSS"));
    }, 1200);
  });

  // ——— 7) Jackpot UI (real backend; graceful failure) ———
  (async function initRaffleUI(){
    const errOut = (where, message) => {
      console.error(`[raffle:${where}]`, message);
      const schedule = document.getElementById("raffle-schedule");
      if (schedule) { schedule.textContent = `⚠️ ${message}`; schedule.style.color = "#ff9b9b"; }
    };
    try {
      const cfg = await ensureConfig();
      const priceBase = Number(cfg?.token?.ticket_price ?? 0);
      if (priceBase && document.getElementById("ticket-price")) {
        document.getElementById("ticket-price").textContent = (priceBase / TEN_POW).toLocaleString();
      }
      const round = await jfetchStrict(`${API}/rounds/current`);
      const elPot   = document.getElementById("round-pot");
      const elId    = document.getElementById("round-id");
      const elClose = document.getElementById("round-countdown");
      const elNext  = document.getElementById("round-next-countdown");
      const elProg  = document.getElementById("jp-progress");
      const schedEl = document.getElementById("raffle-schedule");
      const iso = (s)=> String(s||"").replace(" ", "T").replace(/\.\d+/, "").replace(/Z?$/, "Z");
      const opensAt  = new Date(iso(round.opens_at));
      const closesAt = new Date(iso(round.closes_at));
      const durationMin = Number(cfg?.raffle?.duration_minutes ?? 10);
      const breakMin    = Number(cfg?.raffle?.break_minutes ?? 2);
      const nextOpenIso = cfg?.timers?.next_opens_at ? iso(cfg.timers.next_opens_at) : null;
      const nextOpensAt = nextOpenIso ? new Date(nextOpenIso) : new Date(closesAt.getTime() + breakMin * 60 * 1000);
      if (elId)  elId.textContent  = round.round_id;
      if (elPot) elPot.textContent = (Number(round.pot||0) / TEN_POW).toLocaleString();
      if (schedEl) schedEl.textContent = `Each round: ${durationMin} min • Break: ${breakMin} min • Next opens: ${nextOpensAt.toLocaleTimeString()}`;
      const fmtClock = (ms)=>{ if (ms<0) ms=0; const s=Math.floor(ms/1000);
        const h=String(Math.floor((s%86400)/3600)).padStart(2,"0");
        const m=String(Math.floor((s%3600)/60)).padStart(2,"0");
        const sec=String(s%60).padStart(2,"0"); return `${h}:${m}:${sec}`; };
      const clamp01 = (x)=> Math.max(0, Math.min(1, x));
      const tick = ()=>{
        const now = new Date();
        if (elClose) elClose.textContent = fmtClock(closesAt - now);
        if (elNext)  elNext.textContent  = fmtClock(nextOpensAt - now);
        if (elProg) {
          const total = closesAt - opensAt;
          elProg.style.width = `${clamp01((now - opensAt) / (total || 1)) * 100}%`;
        }
      };
      tick(); setInterval(tick, 1000);

      // Recent rounds
      const list = document.getElementById("recent-rounds");
      document.getElementById("jp-view-all")?.addEventListener("click", () => {
        document.getElementById("raffle-history")?.scrollIntoView({ behavior: "smooth" });
      });
      async function loadRecent(){
        if (!list) return;
        list.innerHTML = `<li class="muted">Loading…</li>`;
        try {
          const recent = await jfetchStrict(`${API}/rounds/recent?limit=6`);
          list.innerHTML = "";
          for (const r of recent) {
            const li = document.createElement("li");
            const potHuman = (Number(r.pot||0)/TEN_POW).toLocaleString();
            const meta = [];
            if (typeof r.tickets !== "undefined") meta.push(`${r.tickets} tix`);
            if (typeof r.wallets !== "undefined") meta.push(`${r.wallets} wallets`);
            const metaStr = meta.length ? `<span class="muted small">${meta.join(" • ")}</span>` : "";
            li.innerHTML = `<span><b>${r.id}</b> • ${potHuman} ${TOKEN.symbol}</span>${metaStr}`;
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

  // ——— 8) History + house edge ———
  async function loadHistory(query=""){
    const tbody = document.querySelector("#history-table tbody"); if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;
    try {
      const recent = await jfetchStrict(`${API}/rounds/recent?limit=10`);
      const items = (query && /^R\d+$/i.test(query))
        ? recent.filter(x => String(x.id).toUpperCase() === query.toUpperCase())
        : recent;
      const rows = [];
      for (const r of items){
        let w = null;
        try { w = await jfetchStrict(`${API}/rounds/${r.id}/winner`); } catch {}
        const potHuman = (Number(r.pot||0)/TEN_POW).toLocaleString();
        const winner   = w?.winner ? w.winner : "—";
        const payout   = w?.payout_sig || "—";
        const proof    = (w?.server_seed_hash||"-").slice(0,10) + "…";
        rows.push(`<tr>
          <td>#${r.id}</td>
          <td>${potHuman} ${TOKEN.symbol}</td>
          <td>${winner}</td>
          <td>${payout}</td>
          <td>${proof}</td>
        </tr>`);
      }
      tbody.innerHTML = rows.join("") || `<tr><td colspan="5" class="muted">No history.</td></tr>`;
    } catch(e){
      console.error(e);
      tbody.innerHTML = `<tr><td colspan="5" class="muted">Failed to load history from backend.</td></tr>`;
    }
  }
  document.getElementById("history-search")?.addEventListener("change",(e)=>loadHistory(e.target.value.trim()));
  loadHistory();

  (async()=>{
    try{
      await ensureConfig();
      if (CONFIG?.raffle?.splits) {
        const s = CONFIG.raffle.splits;
        const bps = 10000 - (Number(s.winner||0) + Number(s.dev||0) + Number(s.burn||0));
        const el = document.getElementById("edge-line");
        if (el) el.textContent = `House edge: ${(bps/100).toFixed(2)}%`;
      }
    }catch{}
  })();

  // ——— 9) Ambient audio ———
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
</script>