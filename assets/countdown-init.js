// countdown-init.js - simple safe init
(function initCountdown(){
  const el = document.getElementById('countdown-widget');
  if (!el) return;
  const targetIso = el.dataset.target;
  const target = new Date(targetIso).getTime();
  function tick(){
    const diff = Math.max(0, target - Date.now());
    const days = Math.floor(diff / (24*60*60*1000));
    const hours = Math.floor(diff / (60*60*1000) % 24);
    const mins = Math.floor(diff / (60*1000) % 60);
    const secs = Math.floor(diff / 1000 % 60);
    el.querySelector('#cd-days').textContent = `${String(days).padStart(2,'0')}d ${String(hours).padStart(2,'0')}h`;
    // you can expand to show hours/mins/secs more prominently
    if (diff<=0) clearInterval(timerInterval);
  }
  tick();
  const timerInterval = setInterval(tick, 1000);
})();