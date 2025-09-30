/* =========================================================
   $TREATZ — App Logic
   ========================================================= */
(function () {
  "use strict";

  /* =========================
     Config & Constants
     ========================= */
  const C   = window.TREATZ_CONFIG || {};
  const API = (C.apiBase || "/api").replace(/\/$/, "");

  const TOKEN = C.token || { symbol: "$TREATZ", decimals: 9 }; // SPL token (bets)
  const SOL_DECIMALS = 9;                                      // for lamports → SOL formatting

  /* =========================
     Tiny Helpers
     ========================= */
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const pow10 = (n) => Math.pow(10, n);

  const fmtUnits = (units, decimals = 9) => {
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
    setTimeout(() => {
      t.style.opacity = 0;
      setTimeout(() => t.remove(), 250);
    }, 2200);
  };

  /* =========================================================
     FX: Falling Wrappers / Candy / Ghosts
     ========================================================= */
  const fxRoot = (() => {
    let n = document.getElementById("fx-layer");
    if (!n) { n = document.createElement("div"); n.id = "fx-layer"; document.body.appendChild(n); }
    return n;
  })();

  const rand = (min, max) => Math.random() * (max - min) + min;

  // --- SVG factories (inline, no external assets) ---
  function svgWrapper() {
    return `
<svg width="84" height="40" viewBox="0 0 84 40" xmlns="http://www.w3.org/2000/svg">
  <path class="w1" d="M8 14 L0 8 L8 10 L6 2 L14 12 Z"/>
  <rect class="w2" x="14" y="6" rx="6" ry="6" width="56" height="28"/>
  <path class="w1" d="M76 26 L84 32 L76 30 L78 38 L70 28 Z"/>
  <text x="42" y="26" text-anchor="middle" font-family="Luckiest Guy, Creepster, sans-serif" font-size="16" fill="#fff" class="w3">$TREATZ</text>
</svg>`;
  }
  function svgCandy() {
    return `
<svg width="42" height="32" viewBox="0 0 42 32" xmlns="http://www.w3.org/2000/svg">
  <path class="c1" d="M4 16 L0 10 L6 12 L6 4 L12 10"/>
  <rect class="c2" x="8" y="6" rx="6" ry="6" width="26" height="20"/>
  <path class="c1" d="M38 16 L42 22 L36 20 L36 28 L30 22"/>
  <rect x="16" y="10" width="10" height="12" rx="3" fill="#0D0D0D" />
</svg>`;
  }
  function svgGhost() {
    return `
<svg width="44" height="56" viewBox="0 0 44 56" xmlns="http://www.w3.org/2000/svg">
  <path d="M22 2c11 0 20 9 20 20v28c-4-2-8-2-12 0-4-2-8-2-12 0-4-2-8-2-12 0V22C6 11 11 2 22 2z" fill="rgba(200,200,255,.9)"/>
  <circle cx="16" cy="22" r="4" fill="#0D0D0D"/>
  <circle cx="28" cy="22" r="4" fill="#0D0D0D"/>
</svg>`;
  }
  function svgSkull() {
    return `
<svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
  <path d="M24 4c11 0 20 8 20 18 0 10-9 14-9 18H13c0-4-9-8-9-18C4 12 13 4 24 4z" fill="#f1f1f1"/>
  <circle cx="17" cy="22" r="5" fill="#0D0D0D"/>
  <circle cx="31" cy="22" r="5" fill="#0D0D0D"/>
  <rect x="21" y="30" width="6" height="8" rx="2" fill="#0D0D0D"/>
</svg>`;
  }

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

  // Public hook for real settlement results
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

  /* =========================================================
     Halloween Countdown (ominous)
     ========================================================= */
  function nextHalloween() {
    const now  = new Date();
    const m    = now.getMonth(); // 0=Jan ... 9=Oct
    const d    = now.getDate();
    const year = (m > 9 || (m === 9 && d >= 31)) ? now.getFullYear() + 1 : now.getFullYear();
    // Oct 31, 23:59:59 local time
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
    const timerEl = $("#countdown-timer");
    const omenEl  = $("#countdown-omen");
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
    let omenIdx = Math.floor(Math.random() * omens.length);

    let target = nextHalloween();
    function tick(){
      const diff = target - Date.now();
      if (diff <= 0) target = nextHalloween(); // roll over after midnight
      timerEl.textContent = formatDHMS(target - Date.now());
    }
    tick();
    setInterval(tick, 1000);

    function rotateOmen(){
      omenIdx = (omenIdx + 1) % omens.length;
      if (omenEl) omenEl.textContent = omens[omenIdx];
    }
    rotateOmen();
    setInterval(rotateOmen, 12000);
  }

  /* =========================================================
     Link Wiring & Static Elements
     ========================================================= */
  const link = (id, href) => { const el = document.getElementById(id); if (el && href) el.href = href; };
  link("link-discord",   C.links?.discord);
  link("link-telegram",  C.links?.telegram);
  link("link-twitter",   C.links?.twitter);
  link("link-whitepaper",C.links?.whitepaper);
  link("btn-buy",        C.buyUrl);

  const tokenEl = $("#token-address");
  if (tokenEl) tokenEl.textContent = C.tokenAddress || "—";

  // Assets (logo + mascot)
  const logoImg = $("#site-logo");
  if (logoImg && C.assets?.logo) {
    logoImg.src = C.assets.logo;
    logoImg.alt = "$TREATZ";
  }

  const mascotImg = $("#mascot-floater");
  if (mascotImg && C.assets?.mascot) {
    mascotImg.src = C.assets.mascot;
    mascotImg.alt = "Treatz Mascot";
    // gentle float via rAF
    let t = 0;
    const drift = () => {
      t += 0.02;
      mascotImg.style.transform =
        `translate(${Math.sin(t) * 6}px, ${Math.cos(t * 0.8) * 6}px) rotate(${Math.sin(t*0.6)*2}deg)`;
      requestAnimationFrame(drift);
    };
    requestAnimationFrame(drift);
  }

  // Copy token
  $("#btn-copy")?.addEventListener("click", () => {
    navigator.clipboard.writeText(C.tokenAddress || "").then(
      () => toast("Token address copied"),
      () => toast("Copy failed")
    );
  });

  /* =========================================================
     Jackpot: Current Round + Countdown + Recent Rounds
     ========================================================= */
  const elRoundId   = $("#round-id");
  const elPot       = $("#round-pot");        // shown as SOL
  const elCountdown = $("#round-countdown");  // mm:ss
  const elProgress  = $("#jp-progress");

  let countdownTimer = null;

  async function loadCurrentRound() {
    try {
      const r = await fetch(`${API}/rounds/current`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      elRoundId && (elRoundId.textContent = data.round_id || "—");
      elPot     && (elPot.textContent     = fmtUnits(data.pot, SOL_DECIMALS));

      // countdown sync
      if (elCountdown && data.closes_at) {
        const closesAt = new Date(data.closes_at).getTime();
        const opensAt  = data.opens_at ? new Date(data.opens_at).getTime() : null;

        if (countdownTimer) clearInterval(countdownTimer);
        countdownTimer = setInterval(() => {
          const diff = Math.max(0, closesAt - Date.now());
          const s    = Math.floor(diff / 1000);
          const m    = Math.floor(s / 60);
          const ss   = String(s % 60).padStart(2, "0");
          elCountdown.textContent = `${m}:${ss}`;

          if (elProgress && opensAt) {
            const total = Math.max(1, (closesAt - opensAt));
            const pct   = Math.min(100, Math.max(0, ((Date.now() - opensAt) / total) * 100));
            elProgress.style.width = `${pct}%`;
          }

          if (diff <= 0) {
            clearInterval(countdownTimer);
            elCountdown.textContent = "0:00";
            setTimeout(loadCurrentRound, 1500);
            setTimeout(loadRecentRounds, 1500);
          }
        }, 250);
      }
    } catch (e) {
      console.error(e);
      toast("Failed to load current round");
    }
  }

  const recentList = $("#recent-rounds");
  async function loadRecentRounds() {
    if (!recentList) return;
    recentList.innerHTML = `<li class="muted">Loading…</li>`;
    try {
      const r = await fetch(`${API}/rounds/recent?limit=10`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = await r.json();
      if (!rows?.length) {
        recentList.innerHTML = `<li class="muted">No rounds yet.</li>`;
        return;
      }
      recentList.innerHTML = rows
        .map(row => `<li><span>${row.id}</span><span>${fmtUnits(row.pot, SOL_DECIMALS)} SOL</span></li>`)
        .join("");
    } catch (e) {
      console.error(e);
      recentList.innerHTML = `<li class="muted">Failed to load.</li>`;
    }
  }

  /* =========================================================
     Coin Flip — UI & Bet Create (MVP)
     ========================================================= */
  const coin    = $("#coin");
  const betForm = $("#bet-form");

  // Single click handler: spin + candy FX + (optional) demo resolve
  $("#cf-play")?.addEventListener("click", () => {
    if (!coin) return;

    // spin
    const turns = 5 + Math.floor(Math.random() * 4);
    coin.style.transition = "transform 1.2s cubic-bezier(.2,.8,.2,1)";
    coin.style.transform  = `rotateY(${turns * 180}deg)`;
    setTimeout(() => { coin.style.transition = ""; }, 1300);

    // candy rain feedback
    rainTreatz({ count: 18 });

    // demo visual result (replace with real webhook settlement when ready)
    setTimeout(() => {
      const side = (new FormData(document.getElementById("bet-form"))).get("side") || "TRICK";
      playResultFX(side);
    }, 1300);
  });

  // Create bet → shows deposit & memo
  if (betForm) {
    betForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(betForm);

      const tokens = Number(fd.get("amount") || 0);                 // user types whole tokens
      const amountSmallest = Math.round(tokens * pow10(TOKEN.decimals));
      const side = (fd.get("side") || "TRICK").toString();

      try {
        const r = await fetch(`${API}/bets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: amountSmallest, side })
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();

        toast(`Bet created. Send ${tokens} ${TOKEN.symbol} with the memo below.`);
        $("#bet-deposit") && ($("#bet-deposit").textContent = data.deposit || "—");
        $("#bet-memo")    && ($("#bet-memo").textContent    = data.memo || "—");
      } catch (e) {
        console.error(e);
        toast("Bet failed");
      }
    });
  }

  /* =========================================================
     Init
     ========================================================= */
  loadCurrentRound();
  loadRecentRounds();
  setInterval(loadCurrentRound, 15000);
  setInterval(loadRecentRounds, 30000);
  initHalloweenCountdown();
})();
