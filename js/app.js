/* MinecraftAsia — static frontend. Reads JSON written by the poller
   (data/live.json) and aggregator (data/history/<server>/*.json).
   Works straight off any static host or the bundled server.js. */

const board = document.getElementById('board');
let liveData = null;
let sortKey = 'overall';
const charts = {};      // server -> { activity, uptime, range }
const histCache = {};   // server -> { raw, hourly, daily }
let prevRanks = {};     // address -> last overall rank (for delta arrows)
const openRows = new Set(); // servers whose detail panel is expanded

// Range presets
const RANGES = [
  { key: '5m',  label: '5m',  source: 'raw',    window: 5 * 60 },
  { key: '10m', label: '10m', source: 'raw',    window: 10 * 60 },
  { key: '30m', label: '30m', source: 'raw',    window: 30 * 60 },
  { key: '1h',  label: '1h',  source: 'raw',    window: 3600 },
  { key: '24h', label: '24h', source: 'raw',    window: 86400 },
  { key: '7d',  label: '7d',  source: 'hourly', window: 7 * 86400 },
  { key: '1mo', label: '1mo', source: 'daily',  window: 30 * 86400 },
  { key: '1y',  label: '1y',  source: 'daily',  window: 365 * 86400 },
];

const MAG = '#ff2bd6', MAG_SOFT = '#ff6fe4', VIOLET = '#8b3bff', GOLD = '#ffd24e', MUTED = '#9b8aa8';

const esc = s => String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
const timeAgo = ts => {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return 'now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
};
const pingCls = p => p == null ? '' : (p > 250 ? 'bad' : '');
const uptimeCls = u => u == null ? '' : (u < 90 ? 'bad' : (u >= 99 ? 'good' : ''));

function motdHTML(lines){
  if (!lines || !lines.length) return '<div class="motd">— offline —</div>';
  return lines.map(l => `<div class="motd">${String(l).replace(/<(?!\/?span|br|img)[^>]*>/g, '')}</div>`).join('');
}

/* ---------- podium (top 3) ---------- */
function podiumHTML(top){
  const medal = ['1ST', '2ND', '3RD'];
  const order = [top[1], top[0], top[2]].filter(Boolean); // silver, gold, bronze
  return `<div class="podium">` + order.map(s => {
    const i = top.indexOf(s);
    const icon = s.icon
      ? `<img class="pod-icon" src="${s.icon}" alt="">`
      : `<img class="pod-icon" style="filter:grayscale(1) brightness(.5)" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt="">`;
    return `
    <div class="pod p${i + 1}" data-goto="${esc(s.address)}">
      <span class="pod-medal">${medal[i]} PLACE</span>
      <div>${icon}</div>
      <div class="pod-name">${esc(s.address)}</div>
      <div class="pod-players">${s.players}<small> / ${s.max} online</small></div>
      <div class="pod-score">OVERALL <b>${s.overall}</b></div>
    </div>`;
  }).join('') + `</div>`;
}

/* ---------- rows ---------- */
function rowHTML(s){
  const off = !s.online_status;
  const tier = s.rank <= 1 ? 'tier1' : s.rank <= 3 ? 'tier2' : s.rank <= 6 ? 'tier3' : '';
  const icon = s.icon
    ? `<img class="srv-icon" src="${s.icon}" alt="">`
    : `<img class="srv-icon off" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt="">`;
  const prev = prevRanks[s.address];
  let delta = '';
  if (prev && prev !== s.rank){
    delta = prev > s.rank
      ? `<span class="rank-delta up">▲${prev - s.rank}</span>`
      : `<span class="rank-delta down">▼${s.rank - prev}</span>`;
  }
  return `
  <div class="row ${off ? 'offline' : ''} ${tier}" data-srv="${esc(s.address)}">
    <div class="row-main">
      <div class="rank-cell">#${s.rank}${delta}</div>
      <div class="server-cell">
        ${icon}
        <div class="srv-text">
          <div class="srv-name"><span class="dot ${off ? 'down' : ''}"></span>${esc(s.address)}</div>
          ${motdHTML(s.motd_html)}
        </div>
      </div>
      <div class="m-cluster">
        <div class="metric-cell m-online" data-label="online">${s.players}<small>/${s.max}</small></div>
        <div class="metric-cell m-peak" data-label="peak">${s.daily_peak}</div>
        <div class="metric-cell m-uptime uptime ${uptimeCls(s.uptime_24h)}" data-label="uptime">${s.uptime_24h}<small>%</small></div>
        <div class="metric-cell m-ping ping ${pingCls(s.ping_ms)}" data-label="ping">${s.ping_ms == null ? '—' : Math.round(s.ping_ms) + 'ms'}</div>
      </div>
      <div class="score-cell">${s.overall}</div>
    </div>
    <div class="detail">
      <div class="smart" data-smart><div class="smart-line">Analyzing history…</div></div>
      <div class="detail-grid">
        <div>
          <div class="chart-head">
            <span class="chart-title">Players & Ping</span>
            <div class="range-tabs">
              ${RANGES.map((r, i) => `<button data-range="${r.key}" class="${i === 4 ? 'active' : ''}">${r.label}</button>`).join('')}
            </div>
          </div>
          <div class="chart-box"><canvas class="activity-canvas"></canvas></div>
          <div class="chart-title" style="margin-top:18px">Uptime</div>
          <div class="uptime-chart-box"><canvas class="uptime-canvas"></canvas></div>
        </div>
        <div>
          <div class="chart-title" style="margin-bottom:10px">Key Stats</div>
          <div class="stat-cards" data-stats></div>
        </div>
      </div>
    </div>
  </div>`;
}

function sortServers(list){
  const copy = [...list];
  copy.sort((a, b) => {
    const av = sortKey === 'ping_ms' ? (a.ping_ms ?? 99999) : (a[sortKey] ?? 0);
    const bv = sortKey === 'ping_ms' ? (b.ping_ms ?? 99999) : (b[sortKey] ?? 0);
    return sortKey === 'ping_ms' ? av - bv : bv - av;
  });
  copy.forEach((s, i) => { s.rank = i + 1; });
  return copy;
}

/* animated counters */
function animateCount(el, target){
  const from = parseInt(el.dataset.v || '0', 10);
  el.dataset.v = target;
  const t0 = performance.now(), dur = 900;
  const step = t => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(from + (target - from) * e).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderBoard(){
  if (!liveData) return;
  const ranked = sortServers(liveData.servers);
  const showPodium = sortKey === 'overall';

  board.innerHTML =
    (showPodium ? podiumHTML(ranked.slice(0, 3)) : '') +
    `<div class="col-heads">
       <span class="c-rank">Rank</span><span class="c-server">Server</span>
       <span>Online</span><span>Peak</span><span>Uptime</span><span>Ping</span><span>Score</span>
     </div>` +
    (showPodium ? `<div class="rows-label">Full Rankings</div>` : '') +
    ranked.map(rowHTML).join('');

  animateCount(document.getElementById('sumOnline'),
    liveData.servers.reduce((a, s) => a + s.players, 0));
  document.getElementById('sumUp').textContent =
    liveData.servers.filter(s => s.online_status).length + '/' + liveData.servers.length;
  document.getElementById('sumTracked').textContent = liveData.servers.length;
  document.getElementById('sumUpdated').textContent = timeAgo(liveData.updated);

  if (liveData.weights) {
    const w = liveData.weights;
    document.getElementById('weightsNote').textContent =
      `Overall = ${Math.round(w.online*100)}% online · ${Math.round(w.daily*100)}% daily · ${Math.round(w.uptime*100)}% uptime · ${Math.round(w.ping*100)}% ping`;
  }

  // remember ranks for next refresh's delta arrows
  prevRanks = {};
  ranked.forEach(s => prevRanks[s.address] = s.rank);

  // staggered entrance — only on the very first render; background
  // refreshes update silently instead of replaying the animation
  if (firstRender){
    firstRender = false;
    board.querySelectorAll('.pod, .row').forEach((r, i) => {
      r.style.opacity = 0; r.style.transform = 'translateY(14px)';
      setTimeout(() => {
        r.style.transition = 'opacity .7s cubic-bezier(.22,1,.36,1), transform .7s cubic-bezier(.22,1,.36,1)';
        r.style.opacity = 1; r.style.transform = '';
      }, 40 * i);
    });
  }

  // keep expanded panels open across refreshes
  for (const srv of openRows){
    const r = board.querySelector(`.row[data-srv="${CSS.escape(srv)}"]`);
    if (r){
      r.classList.add('open');
      const live = liveData.servers.find(s => s.address === srv);
      renderSmart(srv, r, live);
      renderStats(srv, r);
      drawCharts(srv, r, charts[srv]?.range || '24h');
    }
  }
}

/* ---------- history ---------- */
async function loadHistory(srv){
  if (histCache[srv]) return histCache[srv];
  const fetchJSON = async (path) => {
    try { const r = await fetch(path); return r.ok ? await r.json() : []; }
    catch { return []; }
  };
  const [raw, hourly, daily] = await Promise.all([
    fetchJSON(`data/history/${srv}/raw.json`),
    fetchJSON(`data/history/${srv}/hourly.json`),
    fetchJSON(`data/history/${srv}/daily.json`),
  ]);
  histCache[srv] = { raw, hourly, daily };
  return histCache[srv];
}

function fmtLabel(ts, source){
  const d = new Date(ts * 1000);
  return source === 'raw'
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function drawCharts(srv, row, rangeKey){
  const range = RANGES.find(r => r.key === rangeKey) || RANGES[4];
  const hist = await loadHistory(srv);
  const now = Math.floor(Date.now() / 1000);
  const since = now - range.window;

  const series = (hist[range.source] || []).filter(p => p.ts >= since);
  const labels = series.map(p => fmtLabel(p.ts, range.source));
  const playerVals = series.map(p => range.source === 'raw' ? (p.up ? p.online : null) : p.avg_online ?? p.peak_online);
  const pingVals = series.map(p => range.source === 'raw' ? (p.up ? p.ping : null) : p.avg_ping);
  const uptimeVals = series.map(p => range.source === 'raw' ? (p.up ? 100 : 0) : p.uptime_pct);

  const activityCv = row.querySelector('.activity-canvas');
  const uptimeCv = row.querySelector('.uptime-canvas');
  if (!activityCv || !uptimeCv) return;

  if (charts[srv]?.activity) charts[srv].activity.destroy();
  if (charts[srv]?.uptime) charts[srv].uptime.destroy();

  const ctx = activityCv.getContext('2d');
  const fill = ctx.createLinearGradient(0, 0, 0, 230);
  fill.addColorStop(0, 'rgba(255,43,214,.35)');
  fill.addColorStop(1, 'rgba(255,43,214,0)');

  const activity = new Chart(activityCv, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Players', data: playerVals, yAxisID: 'y', spanGaps: true,
          borderColor: MAG, backgroundColor: fill,
          fill: true, tension: .35, pointRadius: 0, borderWidth: 2 },
        { label: 'Ping (ms)', data: pingVals, yAxisID: 'y1', spanGaps: true,
          borderColor: GOLD, borderDash: [4, 3], tension: .25, pointRadius: 0, borderWidth: 1.5 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 700, easing: 'easeOutQuart' },
      plugins: { legend: { labels: { color: MUTED, boxWidth: 10, font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: MUTED, maxTicksLimit: 8, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.04)' } },
        y: { beginAtZero: true, ticks: { color: MAG_SOFT, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.05)' } },
        y1: { position: 'right', beginAtZero: true, ticks: { color: GOLD, font: { size: 10 } }, grid: { display: false } },
      },
    },
  });

  const uptime = new Chart(uptimeCv, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Uptime %', data: uptimeVals,
      backgroundColor: uptimeVals.map(v => v >= 99 ? '#4ef0a8' : v >= 90 ? MAG : v >= 50 ? GOLD : '#ff5b7a'),
      borderRadius: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 700, easing: 'easeOutQuart' },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { display: false }, grid: { display: false } },
        y: { min: 0, max: 100, ticks: { color: MUTED, font: { size: 10 }, stepSize: 50 }, grid: { color: 'rgba(255,255,255,.05)' } },
      },
    },
  });

  charts[srv] = { activity, uptime, range: rangeKey };
}

/* ---------- smart analysis ---------- */
function analyzeServer(srv, hist, live){
  const daily = hist.daily || [];
  const raw = hist.raw || [];
  const hourly = hist.hourly || [];
  if (!daily.length && !raw.length) return null;

  const out = { tags: [], lines: [] };

  // trend: last 3 days avg vs previous 3 days avg (daily)
  if (daily.length >= 6){
    const recent = daily.slice(-3), prev = daily.slice(-6, -3);
    const rAvg = recent.reduce((a, d) => a + d.avg_online, 0) / recent.length;
    const pAvg = prev.reduce((a, d) => a + d.avg_online, 0) / prev.length || 1;
    const pct = Math.round((rAvg - pAvg) / pAvg * 100);
    if (pct >= 10){ out.tags.push(['▲ Rising +' + pct + '%', 'hot']); out.lines.push(`Player count is <b>trending up ${pct}%</b> over the last 3 days.`); }
    else if (pct <= -10){ out.tags.push(['▼ Declining ' + pct + '%', 'warn']); out.lines.push(`Player count is <b>trending down ${Math.abs(pct)}%</b> over the last 3 days.`); }
    else { out.tags.push(['● Stable', 'ok']); out.lines.push('Player base is <b>stable</b> week over week.'); }
  }

  // best hour from hourly data
  if (hourly.length >= 24){
    const byHour = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
    for (const h of hourly){ const d = new Date(h.ts * 1000); const b = byHour[d.getHours()]; b.sum += h.avg_online; b.n++; }
    let best = 0, bestV = -1;
    byHour.forEach((b, h) => { const v = b.n ? b.sum / b.n : 0; if (v > bestV){ bestV = v; best = h; } });
    const fmtH = h => { const ap = h < 12 ? 'AM' : 'PM'; const hh = h % 12 === 0 ? 12 : h % 12; return hh + ' ' + ap; };
    out.tags.push(['Peak hour ' + fmtH(best), 'ok']);
    out.lines.push(`Busiest around <b>${fmtH(best)}</b> local time — best window for events and restarts to avoid.`);
  }

  // stability from recent raw (24h)
  if (raw.length){
    const since = Math.floor(Date.now() / 1000) - 86400;
    const recs = raw.filter(r => r.ts >= since);
    if (recs.length){
      const upPct = 100 * recs.filter(r => r.up).length / recs.length;
      const pings = recs.filter(r => r.up && r.ping != null).map(r => r.ping);
      const jit = pings.length > 2
        ? Math.sqrt(pings.reduce((a, p, i, arr) => i ? a + Math.pow(p - arr[i - 1], 2) : 0, 0) / (pings.length - 1))
        : 0;
      if (upPct >= 99 && jit < 25){ out.tags.push(['Rock solid', 'ok']); out.lines.push('Connection quality is <b>excellent</b> — high uptime with low ping jitter.'); }
      else if (upPct < 90){ out.tags.push(['Unstable 24h', 'warn']); out.lines.push(`Only <b>${upPct.toFixed(1)}%</b> uptime in the last 24h — expect interruptions.`); }
      else if (jit >= 60){ out.tags.push(['Ping jitter', 'warn']); out.lines.push('Ping is <b>inconsistent</b> — gameplay may feel laggy at times.'); }
    }
  }

  // capacity pressure
  if (live && live.max > 0){
    const fill = live.players / live.max;
    if (fill >= 0.9){ out.tags.push(['Nearly full', 'hot']); out.lines.push('Server is <b>nearly full</b> — join early or expect a queue.'); }
  }

  if (!out.lines.length) out.lines.push('Not enough history yet — analysis improves as more data is collected.');
  return out;
}

async function renderSmart(srv, row, live){
  const box = row.querySelector('[data-smart]');
  if (!box) return;
  const hist = await loadHistory(srv);
  const a = analyzeServer(srv, hist, live);
  if (!a){ box.innerHTML = '<div class="smart-line">Not enough history yet — check back once the poller has run a while.</div>'; return; }
  box.innerHTML = `
    <span class="smart-badge">SMART ANALYSIS</span>
    <div class="smart-line">
      ${a.lines.join(' ')}
      <div class="smart-tags">${a.tags.map(([t, c]) => `<span class="smart-tag ${c}">${t}</span>`).join('')}</div>
    </div>`;
}

async function renderStats(srv, row){
  const hist = await loadHistory(srv);
  const daily = hist.daily || [];
  const box = row.querySelector('[data-stats]');
  if (!box) return;
  if (!daily.length){
    box.innerHTML = `<div class="scard wide"><div class="v">Collecting…</div><label>Not enough history yet — check back once the poller has run a while</label></div>`;
    return;
  }
  const peak = Math.max(...daily.map(d => d.peak_online));
  const avgOnline = (daily.reduce((a, d) => a + d.avg_online, 0) / daily.length).toFixed(1);
  const avgUptime = (daily.reduce((a, d) => a + d.uptime_pct, 0) / daily.length).toFixed(1);
  const pings = daily.map(d => d.avg_ping).filter(p => p != null);
  const avgPing = pings.length ? (pings.reduce((a, p) => a + p, 0) / pings.length).toFixed(0) : '—';
  const since = new Date(daily[0].ts * 1000).toLocaleDateString();

  box.innerHTML = `
    <div class="scard"><div class="v gd">${peak}</div><label>All-time peak</label></div>
    <div class="scard"><div class="v">${avgOnline}</div><label>Avg online</label></div>
    <div class="scard"><div class="v ${avgUptime < 90 ? 'bd' : 'ok'}">${avgUptime}%</div><label>Avg uptime</label></div>
    <div class="scard"><div class="v">${avgPing}<small>ms</small></div><label>Avg ping</label></div>
    <div class="scard wide"><div class="v" style="font-size:15px">${since}</div><label>Tracking since</label></div>`;
}

/* ---------- interactions ---------- */
function setSort(key){
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === key));
  sortKey = key;
  renderBoard();
}
document.querySelectorAll('.sort-btn').forEach(btn =>
  btn.addEventListener('click', () => setSort(btn.dataset.sort)));
document.querySelectorAll('[data-sort-link]').forEach(a =>
  a.addEventListener('click', () => setSort(a.dataset.sortLink)));

board.addEventListener('click', e => {
  const pod = e.target.closest('.pod');
  if (pod){
    const r = board.querySelector(`.row[data-srv="${CSS.escape(pod.dataset.goto)}"]`);
    if (r){ r.scrollIntoView({ behavior: 'smooth', block: 'center' }); openRow(r); }
    return;
  }
  const tab = e.target.closest('.range-tabs button');
  if (tab){
    const row = tab.closest('.row');
    row.querySelectorAll('.range-tabs button').forEach(b => b.classList.remove('active'));
    tab.classList.add('active');
    drawCharts(row.dataset.srv, row, tab.dataset.range);
    return;
  }
  const main = e.target.closest('.row-main');
  if (main) openRow(main.closest('.row'));
});

function openRow(row){
  if (!row) return;
  const opening = !row.classList.contains('open');
  row.classList.toggle('open');
  const srv0 = row.dataset.srv;
  if (opening) openRows.add(srv0); else openRows.delete(srv0);
  if (opening){
    const srv = row.dataset.srv;
    const live = liveData?.servers.find(s => s.address === srv);
    renderSmart(srv, row, live);
    renderStats(srv, row);
    drawCharts(srv, row, '24h');
  }
}

/* ---------- scroll reveal ---------- */
const io = new IntersectionObserver(entries => {
  entries.forEach(en => { if (en.isIntersecting){ en.target.classList.add('in'); io.unobserve(en.target); } });
}, { threshold: .15 });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));

/* ---------- boot ---------- */
let firstRender = true;
let retryTimer = null;

async function refresh(){
  try {
    const res = await fetch('data/live.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    liveData = await res.json();
    renderBoard();
  } catch (e){
    // Transient failures happen (poller rewriting the file, network hiccup).
    // Never blank the board: keep showing the last good data and retry soon.
    if (!liveData){
      board.innerHTML = '<div class="loading"><span class="loader"></span>Loading rankings…</div>';
    }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(refresh, 10000);
  }
}
refresh();
setInterval(refresh, 60 * 1000);
setInterval(() => {
  const el = document.getElementById('sumUpdated');
  if (el && liveData) el.textContent = timeAgo(liveData.updated);
}, 15000);

/* soft parallax on the hero backdrop */
let ticking = false;
window.addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    document.body.style.setProperty('--par', Math.min(window.scrollY * 0.18, 220) + 'px');
    ticking = false;
  });
}, { passive: true });

/* ---------- butter-smooth wheel scrolling (desktop only) ---------- */
/* Phones/tablets already have native inertia scrolling — we skip them,
   plus anyone who prefers reduced motion. */
(function smoothWheel(){
  const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (isTouch || reduced) return;

  const EASE = 0.085;            // lower = icier glide
  let target = window.scrollY;   // where the wheel wants to go
  let current = window.scrollY;  // where the animation currently is
  let raf = null;

  const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

  window.addEventListener('wheel', e => {
    if (e.ctrlKey) return;                    // pinch/ctrl zoom — leave alone
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // line-mode mice
    target = Math.max(0, Math.min(maxScroll(), target + delta));
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: false });

  function tick(){
    current += (target - current) * EASE;
    if (Math.abs(target - current) < 0.6){
      current = target;
      window.scrollTo({ top: current, behavior: 'instant' });
      raf = null;
      return;
    }
    window.scrollTo({ top: current, behavior: 'instant' }); // instant — our rAF provides the glide
    raf = requestAnimationFrame(tick);
  }

  // stay in sync when the page scrolls by other means (anchor links, keys, scrollbar)
  window.addEventListener('scroll', () => {
    if (!raf) target = current = window.scrollY;
  }, { passive: true });
  window.addEventListener('resize', () => { target = Math.min(target, maxScroll()); });
})();
