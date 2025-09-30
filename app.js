/* ========== $TREATZ App Logic (refined) ======= */
(function () {
  const C = window.TREATZ_CONFIG || {};
  const API = (C.apiBase || "/api").replace(/\/$/, "");

  // ------- helpers -------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const toast = (msg) => {
    console.log(msg);
    let t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    Object.assign(t.style, {
      position: "fixed", right: "16px", bottom: "16px",
      background: "rgba(0,0,0,.75)", color: "#fff",
      padding: "10px 12px", borderRadius: "8px", zIndex: 9999,
      fontFamily: "Rubik, system-ui, sans-serif", fontSize: "14px"
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  };

  // --- formats & unit helpers (SPL token) ---
  const TOKEN = C.token || { symbol: "$TREATZ", decimals: 9 };
  const pow10 = (n) => Math.pow(10, n);
  const fmtToken = (units) => {
    if (units == null) return "—";
    const t = Number(units) / pow10(TOKEN.decimals);
    return t >= 1 ? t.toFixed(2) : t.toFixed(4);
  };
  // Use for jackpot pot display (pot is stored in smallest units)
  const fmtPot = fmtToken;

  // ------- link wiring -------
  const link = (id, href) => {
    const el = document.getElementById(id);
    if (el && href) el.href = href;
  };
  link("link-discord", C.links?.discord);
  link("link-telegram", C.links?.telegram);
  link("link-twitter", C.links?.twitter);
  link("link-whitepaper", C.links?.whitepaper);
  link("btn-buy", C.buyUrl);

  const tokenEl = document.getElementById("token-address");
  if (tokenEl) tokenEl.textContent = C.tokenAddress || "—";

  // ------- assets (logo + mascot) -------
  const logoImg = document.getElementById("site-logo");
  if (logoImg && C.assets?.logo) {
    logoImg.src = C.assets.logo;
    logoImg.alt = "$TREATZ";
  }

  const mascotImg = document.getElementById("mascot-floater");
  if (mascotImg && C.assets?.mascot) {
    mascotImg.src = C.assets.mascot;
    mascotImg.alt = "Treatz Mascot";
    // gentle float
    let t = 0;
    setInterval(() => {
      t += 0.02;
      mascotImg.style.transform =
        `translate(${Math.sin(t) * 6}px, ${Math.cos(t * 0.8) * 6}px) rotate(${Math.sin(t*0.6)*2}deg)`;
    }, 16);
  }

  // ------- copy token -------
  const copyBtn = document.getElementById("btn-copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(C.tokenAddress || "").then(
        () => toast("Token address copied"),
        () => toast("Copy failed")
      );
    });
  }

  // ------- jackpot: current round + countdown -------
  const elRoundId = $("#round-id");
  const elPot = $("#round-pot");
  const elCountdown = $("#round-countdown");
  const elProgress = $("#jp-progress"); // optional progress bar

  let countdownTimer = null;

  async function loadCurrentRound() {
    try {
      const r = await fetch(`${API}/rounds/current`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      if (elRoundId) elRoundId.textContent = data.round_id || "—";
      if (elPot) elPot.textContent = fmtPot(data.pot);

      // countdown sync
      if (elCountdown && data.closes_at) {
        const closesAt = new Date(data.closes_at).getTime();
        if (countdownTimer) clearInterval(countdownTimer);
        countdownTimer = setInterval(() => {
          const diff = Math.max(0, closesAt - Date.now());
          const s = Math.floor(diff / 1000);
          const m = Math.floor(s / 60);
          const ss = (s % 60).toString().padStart(2, "0");
          elCountdown.textContent = `${m}:${ss}`;

          if (elProgress && data.opens_at) {
            const opensAt = new Date(data.opens_at).getTime();
            const total = Math.max(1, (closesAt - opensAt));
            const pct = Math.min(100, Math.max(0, ((Date.now() - opensAt) / total) * 100));
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

  // ------- recent rounds -------
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
        .map(row => `<li><span>${row.id}</span><span>${fmtToken(row.pot)} ${TOKEN.symbol}</span></li>`)
        .join("");
    } catch (e) {
      console.error(e);
      recentList.innerHTML = `<li class="muted">Failed to load.</li>`;
    }
  }

  // ------- place bet (coin flip MVP) -------
  const betForm = $("#bet-form");
  if (betForm) {
    betForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(betForm);

      // user types whole tokens (e.g. 100)
      const tokens = Number(fd.get("amount") || 0);
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
        toast(`Bet created. Send ${tokens} ${TOKEN.symbol} with memo below.`);
        $("#bet-deposit") && ($("#bet-deposit").textContent = data.deposit || "—");
        $("#bet-memo") && ($("#bet-memo").textContent = data.memo || "—");
      } catch (e) {
        console.error(e);
        toast("Bet failed");
      }
    });
  }

  // initial load + polling
  loadCurrentRound();
  loadRecentRounds();
  setInterval(loadCurrentRound, 15_000);
  setInterval(loadRecentRounds, 30_000);
})();