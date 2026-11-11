/* MinecraftAsia — static frontend. Reads JSON written by scripts/poller.py
   (data/live.json) and scripts/aggregate.py (data/history/<server>/*.json).
   No backend server required — works straight off GitHub Pages. */

const board = document.getElementById('board');
let liveData = null;
let sortKey = 'overall';
const charts = {};      // server -> { activity: Chart, uptime: Chart, range }
const histCache = {};   // server -> { raw, hourly, daily }

// Range presets: [label, key, source, windowSeconds]
//   source 'raw'    -> data/history/<server>/raw.json    (~1 min resolution)
//   source 'hourly' -> data/history/<server>/hourly.json
//   source 'daily'  -> data/history/<server>/daily.json
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

const esc = s => String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
const timeAgo = ts => {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return 'now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  return Math.floor(d / 3600) + 'h ago';
};
const pingCls = p => p == null ? '' : (p > 250 ? 'bad' : '');
const uptimeCls = u => u == null ? '' : (u < 90 ? 'bad' : (u >= 99 ? 'good' : ''));

function motdHTML(lines){
  if (!lines || !lines.length) return '<div class="motd">— offline —</div>';
  return lines.map(l => `<div class="motd">${String(l).replace(/<(?!\/?span|br|img)[^>]*>/g, '')}</div>`).join('');
}

/* ---------- render board ---------- */
function rowHTML(s){
  const off = !s.online_status;
  const tier = s.rank <= 1 ? 'tier1' : s.rank <= 3 ? 'tier2' : s.rank <= 6 ? 'tier3' : '';
  const icon = s.icon
    ? `<img class="srv-icon" src="${s.icon}" alt="">`
    : `<img class="srv-icon off" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt="">`;
  return `
  <div class="row ${off ? 'offline' : ''} ${tier}" data-srv="${esc(s.address)}">
    <div class="row-main">
      <div class="rank-cell mc">#${s.rank}</div>
      <div class="server-cell">
        ${icon}
        <div class="srv-text">
          <div class="srv-name mc"><span class="dot ${off ? 'down' : ''}"></span>${esc(s.address)}</div>
          ${motdHTML(s.motd_html)}
        </div>
      </div>
      <div class="metric-cell mc">${s.players}<small>/${s.max}</small></div>
      <div class="metric-cell mc">${s.daily_peak}</div>
      <div class="metric-cell mc uptime ${uptimeCls(s.uptime_24h)}">${s.uptime_24h}<small>%</small></div>
      <div class="metric-cell mc ping ${pingCls(s.ping_ms)}">${s.ping_ms == null ? '—' : Math.round(s.ping_ms) + 'ms'}</div>
      <div class="score-cell mc">${s.overall}</div>
    </div>
    <div class="detail">
      <div class="detail-grid">
        <div>
          <div class="chart-head">
            <span class="chart-title">PLAYERS & PING</span>
            <div class="range-tabs">
              ${RANGES.map((r, i) => `<button data-range="${r.key}" class="${i === 4 ? 'active' : ''}">${r.label}</button>`).join('')}
            </div>
          </div>
          <div class="chart-box"><canvas class="activity-canvas"></canvas></div>
          <div class="chart-title" style="margin-top:16px">UPTIME</div>
          <div class="uptime-chart-box"><canvas class="uptime-canvas"></canvas></div>
        </div>
        <div>
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
    return sortKey === 'ping_ms' ? av - bv : bv - av; // lower ping = better, else higher = better
  });
  copy.forEach((s, i) => { s.rank = i + 1; });
  return copy;
}

function renderBoard(){
  if (!liveData) return;
  const ranked = sortServers(liveData.servers);
  board.innerHTML = ranked.map(rowHTML).join('');

  document.getElementById('sumOnline').textContent =
    liveData.servers.reduce((a, s) => a + s.players, 0).toLocaleString();
  document.getElementById('sumUp').textContent =
    liveData.servers.filter(s => s.online_status).length + '/' + liveData.servers.length;
  document.getElementById('sumUpdated').textContent = timeAgo(liveData.updated);

  if (liveData.weights) {
    const w = liveData.weights;
    document.getElementById('weightsNote').textContent =
      `Overall = ${Math.round(w.online*100)}% online · ${Math.round(w.daily*100)}% daily · ${Math.round(w.uptime*100)}% uptime · ${Math.round(w.ping*100)}% ping`;
  }

  board.querySelectorAll('.row').forEach((r, i) => {
    r.style.opacity = 0; r.style.transform = 'translateY(-4px)';
    setTimeout(() => { r.style.transition = 'opacity .3s,transform .3s'; r.style.opacity = 1; r.style.transform = ''; }, 25 * i);
  });
}

/* ---------- history loading ---------- */
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

  if (charts[srv]?.activity) charts[srv].activity.destroy();
  if (charts[srv]?.uptime) charts[srv].uptime.destroy();

  const activity = new Chart(activityCv, {
    data: {
      labels,
      datasets: [
        { label: 'Players', data: playerVals, yAxisID: 'y', spanGaps: true,
          borderColor: '#5fd0ff', backgroundColor: 'rgba(95,208,255,.10)',
          fill: true, tension: .3, pointRadius: 0, borderWidth: 2 },
        { label: 'Ping (ms)', data: pingVals, yAxisID: 'y1', spanGaps: true,
          borderColor: '#f2c14e', borderDash: [4, 3], tension: .25, pointRadius: 0, borderWidth: 1.5 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#8a8d99', boxWidth: 10, font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#8a8d99', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: 'rgba(38,40,50,.5)' } },
        y: { beginAtZero: true, ticks: { color: '#5fd0ff', font: { size: 10 } }, grid: { color: 'rgba(38,40,50,.5)' } },
        y1: { position: 'right', beginAtZero: true, ticks: { color: '#f2c14e', font: { size: 10 } }, grid: { display: false } },
      },
    },
  });

  const uptime = new Chart(uptimeCv, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Uptime %', data: uptimeVals, backgroundColor: '#57d38c', borderRadius: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { display: false }, grid: { display: false } },
        y: { min: 0, max: 100, ticks: { color: '#8a8d99', font: { size: 10 }, stepSize: 50 }, grid: { color: 'rgba(38,40,50,.5)' } },
      },
    },
  });

  charts[srv] = { activity, uptime, range: rangeKey };
}

async function renderStats(srv, row){
  const hist = await loadHistory(srv);
  const daily = hist.daily || [];
  const box = row.querySelector('[data-stats]');
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
    <div class="scard"><div class="v ${avgUptime < 90 ? 'bd' : ''}">${avgUptime}%</div><label>Avg uptime</label></div>
    <div class="scard"><div class="v">${avgPing}<small>ms</small></div><label>Avg ping</label></div>
    <div class="scard wide"><div class="v" style="font-size:14px">${since}</div><label>Tracking since</label></div>`;
}

/* ---------- interactions ---------- */
document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    sortKey = btn.dataset.sort;
    renderBoard();
  });
});

board.addEventListener('click', e => {
  const tab = e.target.closest('.range-tabs button');
  if (tab){
    const row = tab.closest('.row');
    row.querySelectorAll('.range-tabs button').forEach(b => b.classList.remove('active'));
    tab.classList.add('active');
    drawCharts(row.dataset.srv, row, tab.dataset.range);
    return;
  }
  const main = e.target.closest('.row-main');
  if (!main) return;
  const row = main.closest('.row');
  const opening = !row.classList.contains('open');
  row.classList.toggle('open');
  if (opening){
    const srv = row.dataset.srv;
    renderStats(srv, row);
    drawCharts(srv, row, '24h');
  }
});

/* ---------- boot ---------- */
async function refresh(){
  try {
    const res = await fetch('data/live.json', { cache: 'no-store' });
    liveData = await res.json();
    renderBoard();
  } catch (e){
    board.innerHTML = '<div class="loading">Could not load ranking data — check data/live.json exists.</div>';
  }
}
refresh();
setInterval(refresh, 60 * 1000);
setInterval(() => {
  const el = document.getElementById('sumUpdated');
  if (el && liveData) el.textContent = timeAgo(liveData.updated);
}, 15000);
