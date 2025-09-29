/* ========== $TREATZ App Logic (ready-to-wire) ======== */
(function(){
  const C = window.TREATZ_CONFIG || {};
  // Wire external links and token/buy
  document.getElementById('link-discord').href   = C.links.discord || '#';
  document.getElementById('link-telegram').href  = C.links.telegram || '#';
  document.getElementById('link-twitter').href   = C.links.twitter || '#';
  document.getElementById('link-whitepaper').href= C.links.whitepaper || '#';
  document.getElementById('btn-buy').href        = C.buyUrl || '#';
  document.getElementById('token-address').textContent = C.tokenAddress || '—';

  // Copy token
  document.getElementById('btn-copy').addEventListener('click', ()=>{
    navigator.clipboard.writeText(C.tokenAddress || '').then(()=>{
      toast('Token address copied');
    }).catch(()=>toast('Copy failed'));
  });

  // Wallet stubs (replace with real wallet adapter)
  document.getElementById('btn-connect').addEventListener('click', ()=>{
    window.dispatchEvent(new CustomEvent('treatz:wallet:connect'));
    toast('Connecting wallet… (stub)');
  });
  document.getElementById('btn-openwallet').addEventListener('click', ()=>{
    window.dispatchEvent(new CustomEvent('treatz:wallet:open'));
    toast('Opening wallet… (stub)');
  });

  // Halloween countdown banner with playful omens
  const target = new Date(C.halloweenISO || '2025-10-31T00:00:00-04:00');
  const timerEl = document.getElementById('countdown-timer');
  const omenEl  = document.getElementById('countdown-omen');
  const omens = [
    'Gremlin in the mempool spotted.',
    'Witches brewing liquidity…',
    'Ghosts front-running paper hands.',
    'Pumpkins aligned. Candles lit.',
    'Never fade the night shift.',
    'Trick? Treat? Only the chain knows.',
    'Beware the spooky slippage.'
  ];
  function tick(){
    const now = new Date();
    const diff = Math.max(0, target - now);
    const s = Math.floor(diff/1000);
    const d = Math.floor(s/86400);
    const h = Math.floor((s%86400)/3600);
    const m = Math.floor((s%3600)/60);
    const sec = s%60;
    timerEl.textContent = `${d}d ${h}h ${m}m ${sec}s`;
    // fun mystery flicker 1% chance
    if (Math.random() < 0.01) {
      omenEl.textContent = '??? A strange puff passes by…';
    } else if (sec % 10 === 0) {
      omenEl.textContent = omens[Math.floor(Math.random()*omens.length)];
    }
  }
  tick(); setInterval(tick, 1000);

  // Coin flip UI
  const playBtn = document.getElementById('cf-play');
  const coinEl  = document.getElementById('coin');
  const statusEl= document.getElementById('cf-status');
  playBtn.addEventListener('click', ()=>{
    const amt = parseFloat(document.getElementById('cf-amount').value || '0');
    const side = (document.querySelector('input[name="cf-side"]:checked')||{}).value || 'TRICK';
    if (!amt || amt <= 0){ return toast('Enter a wager amount'); }
    // Fire a wire-ready event your backend can hook into
    const payload = { amount: amt, side, ts: Date.now() };
    window.dispatchEvent(new CustomEvent('treatz:coinflip:submit', { detail: payload }));
    // Temporary UX: animate coin then random result client-side (replace with verified oracle result)
    coinEl.classList.remove('spin'); void coinEl.offsetWidth; coinEl.classList.add('spin');
    statusEl.textContent = 'Flipping…';
    setTimeout(()=>{
      const result = Math.random() < 0.5 ? 'TRICK' : 'TREAT';
      statusEl.textContent = `Result: ${result}`;
      toast(result === side ? 'You WIN 🎉' : 'You lost — the night is fickle 👻');
      window.dispatchEvent(new CustomEvent('treatz:coinflip:result', { detail: { ...payload, result } }));
    }, 1250);
  });

  // Jackpot UI (mock data + wire-ready events)
  const jpPotEl = document.getElementById('jp-pot');
  const jpEntriesEl = document.getElementById('jp-entries');
  const jpCdEl = document.getElementById('jp-countdown');
  const jpProgEl = document.getElementById('jp-progress');
  const jpRecentEl= document.getElementById('jp-recent');

  let round = {
    id: 'R' + Math.floor(Math.random()*9999),
    closeTs: Date.now() + 1000*60*37, // 37 min from now (placeholder)
    pot: 0, entries: 0
  };

  function renderRound(){
    jpPotEl.textContent = `${round.pot.toFixed(2)} SOL`;
    jpEntriesEl.textContent = `${round.entries}`;
  }
  function tickRound(){
    const now = Date.now();
    const rem = Math.max(0, round.closeTs - now);
    const s = Math.floor(rem/1000);
    const m = Math.floor((s%3600)/60);
    const sec = s%60;
    const h = Math.floor(s/3600);
    jpCdEl.textContent = `${h}h ${m}m ${sec}s`;
    const total = 1000*60*60; // pretend 1h rounds for progress
    const pct = 100 * (1 - rem/total);
    jpProgEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (rem === 0){
      window.dispatchEvent(new CustomEvent('treatz:jackpot:close', { detail: { id: round.id } }));
      prependRecent(round);
      round = { id: 'R' + Math.floor(Math.random()*9999), closeTs: Date.now() + 1000*60*60, pot: 0, entries: 0 };
      renderRound();
    }
  }
  setInterval(tickRound, 1000); renderRound();

  document.getElementById('jp-buy').addEventListener('click', ()=>{
    const qty = parseInt(document.getElementById('jp-amount').value||'0', 10);
    if (!qty || qty < 1) return toast('Enter ticket amount');
    const detail = { roundId: round.id, qty, ts: Date.now() };
    window.dispatchEvent(new CustomEvent('treatz:jackpot:enter', { detail }));
    round.entries += qty;
    round.pot += qty * 0.05; // placeholder pricing
    renderRound();
    toast(`Entered ${qty} ticket(s) 🎟️`);
  });

  function prependRecent(r){
    const li = document.createElement('li');
    li.innerHTML = `<span>#${r.id}</span><span class="mini-round__pill">${r.pot.toFixed(2)} SOL</span>`;
    jpRecentEl.prepend(li);
  }

  // Tiny toast helper
  let tdiv;
  function toast(msg){
    clearTimeout(toast._t);
    if (!tdiv){
      tdiv = document.createElement('div');
      tdiv.style.position='fixed'; tdiv.style.left='50%'; tdiv.style.bottom='26px'; tdiv.style.transform='translateX(-50%)';
      tdiv.style.padding='10px 14px'; tdiv.style.background='rgba(0,0,0,.8)'; tdiv.style.border='1px solid rgba(255,255,255,.2)';
      tdiv.style.borderRadius='10px'; tdiv.style.color='#fff'; tdiv.style.fontWeight='700'; tdiv.style.zIndex='2000';
      document.body.appendChild(tdiv);
    }
    tdiv.textContent = msg;
    tdiv.style.opacity='1';
    toast._t = setTimeout(()=>{ tdiv.style.opacity='0'; }, 1800);
  }

  // Expose a minimal API for your real integrations
  window.TREATZ = {
    setToken(addr){ C.tokenAddress = addr; document.getElementById('token-address').textContent = addr; },
    setBuyUrl(url){ C.buyUrl = url; document.getElementById('btn-buy').href = url; },
    setLinks(links){ Object.assign(C.links, links); ['discord','telegram','twitter','whitepaper'].forEach(k=>{ const el=document.getElementById('link-'+k); if (el && C.links[k]) el.href=C.links[k]; }); },
    setJackpotRound(obj){ Object.assign(round, obj); renderRound(); },
    addRecentRound(obj){ prependRecent(obj); },
  };
})();
