const $ = (s) => document.querySelector(s);
const grid = $('#grid');
let data = null;
let filter = 'all';
let lastOk = 0;

/* ---------- Theme ---------- */
function applyTheme(t) { document.documentElement.dataset.theme = t; }
let theme = 'dark';
try { theme = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); } catch (e) {}
applyTheme(theme);
$('#theme-btn').onclick = () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try { localStorage.setItem('theme', theme); } catch (e) {}
};

/* ---------- Helpers ---------- */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function ago(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds < 60) return seconds + 's';
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}
const ms = (v) => (v == null ? '–' : v < 10 ? v.toFixed(1) + ' ms' : Math.round(v) + ' ms');
function toast(text, isError) {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = 'toast'), 4000);
}

/* ---------- Rendering ---------- */
function historyStrip(history, size) {
  const strip = el('div', 'history');
  const max = Math.max(20, ...history.filter((v) => v != null));
  const pad = Math.max(0, size - history.length);
  for (let i = 0; i < pad; i++) strip.append(el('i', 'pad'));
  for (const v of history) {
    const bar = el('i', v == null ? 'down' : '');
    if (v != null) bar.style.height = 35 + 65 * (v / max) + '%';  // taller = slower response
    strip.append(bar);
  }
  return strip;
}

function card(s, now) {
  const c = el('article', 'card' + (s.up ? ' up' : '') + (s.pinned ? ' pinned' : ''));

  const head = el('div', 'card-head');
  const title = el('div', 'card-title');
  title.append(el('h3', '', s.name));
  if (s.group) title.append(el('div', 'group', s.group));
  const pin = el('button', 'pin' + (s.pinned ? ' on' : ''), s.pinned ? '★' : '☆');
  pin.title = s.pinned ? 'Unpin' : 'Pin to the top';
  pin.setAttribute('aria-label', pin.title + ' ' + s.name);
  pin.onclick = () => togglePin(s, pin);
  head.append(pin, title, el('span', 'badge', s.up ? 'Online' : 'Offline'));

  const metrics = el('div', 'metrics');
  const metric = (label, value) => { const m = el('div', 'metric'); m.append(el('span', '', label), el('b', '', value)); return m; };
  metrics.append(
    metric('Response', s.port ? ms(s.latency) : '–'),
    metric('Uptime', s.uptime + '%'),
    metric(s.up ? 'Up for' : 'Down for', ago(now - s.since)),
  );

  const strip = historyStrip(s.history.slice(-60), 60);
  const legend = el('div', 'history-legend');
  legend.append(el('span', '', ago(60 * window.CHECK_EVERY) + ' ago'), el('span', '', 'now'));

  const meta = el('div', 'meta');
  if (s.port) { const p = el('span'); p.append('Port ', el('code', '', s.port)); meta.append(p); }
  if (s.state) meta.append(el('span', '', 'Service ' + s.state));
  if (s.avg_latency != null) meta.append(el('span', '', 'Avg ' + ms(s.avg_latency)));

  const actions = el('div', 'actions');
  if (s.port) {
    const a = el('a', 'btn primary', 'Open');
    a.href = 'http://' + location.hostname + ':' + s.port + s.path;
    a.target = '_blank'; a.rel = 'noopener';
    actions.append(a);
  }
  if (s.public_url) {
    const a = el('a', 'btn', 'Public ↗');
    a.href = s.public_url; a.target = '_blank'; a.rel = 'noopener';
    actions.append(a);
  }
  if (s.controllable) {
    actions.append(el('span', 'spacer'));
    for (const [action, cls] of [['start', ''], ['restart', ''], ['stop', 'danger']]) {
      const b = el('button', 'btn ' + cls, action[0].toUpperCase() + action.slice(1));
      b.onclick = () => control(s, action, b);
      actions.append(b);
    }
  }

  const edit = el('button', 'btn ghost', 'Edit');
  edit.title = 'Edit or remove ' + s.name;
  edit.onclick = () => openDialog(s.id);
  if (!s.controllable) actions.append(el('span', 'spacer'));
  actions.append(edit);

  c.append(head, metrics, strip, legend, meta, actions);
  return c;
}

function render() {
  if (!data) return;
  const rows = data.services;
  const now = data.now;
  const up = rows.filter((r) => r.up).length;
  const down = rows.length - up;

  $('#host').textContent = data.host;
  $('#stat-up').textContent = up + ' / ' + rows.length;
  $('#stat-down').textContent = down;
  $('#stat-down').classList.toggle('has', down > 0);
  const avgUp = rows.length ? rows.reduce((a, r) => a + r.uptime, 0) / rows.length : 0;
  $('#stat-uptime').textContent = rows.length ? avgUp.toFixed(1) + '%' : '–';
  const lat = rows.filter((r) => r.latency != null).map((r) => r.latency);
  $('#stat-latency').textContent = lat.length ? ms(lat.reduce((a, b) => a + b, 0) / lat.length) : '–';
  $('#overall-dot').className = 'brand-mark ' + (rows.length ? (down ? 'bad' : 'ok') : '');
  document.title = (down ? `(${down} down) ` : '') + 'Services';

  const q = $('#search').value.trim().toLowerCase();
  const visible = rows.filter((r) =>
    (filter === 'all' || (filter === 'pinned' ? r.pinned : (filter === 'up') === r.up)) &&
    (!q || (r.name + ' ' + (r.group || '') + ' ' + (r.port || '')).toLowerCase().includes(q)));
  grid.replaceChildren(...visible.map((r) => card(r, now)));
  $('#empty').hidden = visible.length > 0;
  $('#empty').textContent = filter === 'pinned' && !q ? 'Nothing pinned yet. Click the ☆ on a service to pin it here.' : 'No services match.';
  const pinnedCount = rows.filter((r) => r.pinned).length;
  $('#count-pinned').textContent = pinnedCount || '';

  const events = $('#events');
  if (data.events.length) {
    events.replaceChildren(...data.events.map((e) => {
      const li = el('li', e.kind);
      li.append(el('span', 'dot'), el('span', '', e.text), el('time', '', ago(now - e.time) + ' ago'));
      return li;
    }));
  }
}

/* ---------- Data ---------- */
async function refresh() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    data = await r.json();
    lastOk = Date.now();
    render();
  } catch (e) { /* shown by the stale indicator */ }
  const age = (Date.now() - lastOk) / 1000;
  $('.live').classList.toggle('stale', !lastOk || age > window.CHECK_EVERY * 3);
  $('#updated').textContent = !lastOk ? 'Dashboard not responding'
    : age > window.CHECK_EVERY * 3 ? 'Lost connection ' + ago(age) + ' ago' : 'Live';
}

async function togglePin(s, button) {
  button.disabled = true;
  try {
    const res = await (await fetch('/api/services/' + encodeURIComponent(s.id) + '/pin',
      { method: 'POST', headers: { 'X-Dashboard': '1' } })).json();
    if (!res.ok) toast(res.message || 'Could not pin that.', true);
  } catch (e) {
    toast('Could not pin that.', true);
  }
  await refresh();
}

async function control(s, action, button) {
  if (action === 'stop' && !confirm('Stop ' + s.name + '?')) return;
  const buttons = button.parentElement.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  toast(s.name + ': ' + action + 'ing…');
  try {
    const r = await fetch('/api/' + encodeURIComponent(s.id) + '/' + action, { method: 'POST', headers: { 'X-Dashboard': '1' } });
    const res = await r.json();
    toast(res.message, !res.ok);
  } catch (e) {
    toast('Request failed.', true);
  }
  buttons.forEach((b) => (b.disabled = false));
  refresh();
}

/* ---------- Add / edit / remove ---------- */
const dialog = $('#svc-dialog');
const form = $('#svc-form');
let editingId = null;

function formError(text) {
  $('#svc-error').textContent = text || '';
  $('#svc-error').hidden = !text;
}

async function openDialog(id, prefill) {
  editingId = id || null;
  form.reset();
  formError('');
  $('#svc-title').textContent = id ? 'Edit service' : 'Add service';
  $('#svc-save').textContent = id ? 'Save' : 'Add service';
  $('#svc-remove').hidden = !id;
  if (id) {
    try {
      const all = await (await fetch('/api/services', { cache: 'no-store' })).json();
      const svc = all.find((x) => x.id === id) || {};
      for (const key of ['name', 'port', 'group', 'service', 'path', 'public_url']) {
        if (svc[key] != null) form.elements[key].value = svc[key];
      }
    } catch (e) { toast('Could not load that service.', true); return; }
  }
  for (const [key, value] of Object.entries(prefill || {})) {
    if (value != null && form.elements[key]) form.elements[key].value = value;
  }
  dialog.showModal();
  form.elements.name.focus();
}

async function send(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'X-Dashboard': '1', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = {};
  try { res = await r.json(); } catch (e) { res = { ok: false, message: 'Request failed (' + r.status + ').' }; }
  return res;
}

form.onsubmit = async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  if (!body.name.trim()) return formError('Give the service a name.');
  $('#svc-save').disabled = true;
  try {
    const res = editingId
      ? await send('PUT', '/api/services/' + encodeURIComponent(editingId), body)
      : await send('POST', '/api/services', body);
    if (!res.ok) return formError(res.message);
    dialog.close();
    toast(res.message);
    setTimeout(refresh, 600);
  } catch (e) {
    formError('Could not reach the dashboard.');
  } finally {
    $('#svc-save').disabled = false;
  }
};

$('#svc-remove').onclick = async () => {
  const name = form.elements.name.value || 'this service';
  if (!confirm('Remove ' + name + ' from the dashboard? This only removes the tile; it does not uninstall anything.')) return;
  const res = await send('DELETE', '/api/services/' + encodeURIComponent(editingId));
  if (!res.ok) return formError(res.message || 'Could not remove it.');
  dialog.close();
  toast(res.message);
  refresh();
};

dialog.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => dialog.close()));
dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
$('#add-btn').onclick = () => openDialog(null);

/* ---------- Discover ---------- */
const disc = $('#disc-dialog');
let discData = null;
let discTab = 'ports';

// Turns "jellyfin.exe" or "JellyfinServer" into something readable like "Jellyfin".
function niceName(text) {
  return (text || '').replace(/\.exe$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function discRow(lead, leadCls, title, tags, detail, tracked, prefill) {
  const row = el('div', 'disc-row');
  const main = el('div', 'disc-main');
  const b = el('b', '', title);
  for (const [text, on] of tags) b.append(el('span', 'tag' + (on ? ' on' : ''), text));
  main.append(b, el('span', '', detail));
  const btn = el('button', 'btn ' + (tracked ? '' : 'primary'), tracked ? 'Added' : 'Add');
  btn.disabled = tracked;
  btn.onclick = () => { disc.close(); openDialog(null, prefill); };
  row.append(el('span', leadCls, lead), main, btn);
  return row;
}

function renderDiscover() {
  if (!discData) return;
  const showSystem = $('#disc-system').checked;
  const q = $('#disc-search').value.trim().toLowerCase();
  const list = $('#disc-list');
  const ports = discData.ports.filter((p) => showSystem || !p.system);
  const services = discData.services.filter((s) => showSystem || !s.system);
  $('#count-ports').textContent = ports.length;
  $('#count-services').textContent = discData.windows ? services.length : '';

  let rows = [];
  if (discTab === 'ports') {
    rows = ports
      .filter((p) => !q || [p.port, p.process, p.service, p.display_name].join(' ').toLowerCase().includes(q))
      .map((p) => {
        const title = p.display_name || niceName(p.process) || 'Unknown program';
        const detail = [p.process, p.pid ? 'PID ' + p.pid : '', p.service ? 'service ' + p.service : ''].filter(Boolean).join(' · ');
        const tags = [];
        if (p.local_only) tags.push(['this PC only', false]);
        if (p.service) tags.push(['service', true]);
        return discRow(p.port, 'disc-port', title, tags, detail || 'Process hidden (run as admin to see it)', p.tracked,
          { name: title, port: p.port, service: p.service || '' });
      });
  } else if (!discData.windows) {
    list.replaceChildren(el('p', 'disc-empty', 'Windows services only show up when the dashboard runs on Windows.'));
    return;
  } else {
    rows = services
      .filter((s) => !q || [s.name, s.display_name, s.ports.join(' ')].join(' ').toLowerCase().includes(q))
      .map((s) => {
        const tags = s.ports.length ? [['port ' + s.ports.join(', '), true]] : [];
        const detail = [s.name, s.start_type ? 'starts ' + s.start_type : ''].filter(Boolean).join(' · ');
        return discRow(s.status || '?', 'disc-status ' + (s.status || ''), s.display_name, tags, detail, s.tracked,
          { name: s.display_name, service: s.name, port: s.ports[0] || '' });
      });
  }
  list.replaceChildren(...(rows.length ? rows : [el('p', 'disc-empty', q ? 'Nothing matches.' : 'Nothing found.')]));
}

async function scan() {
  $('#disc-sub').textContent = 'Scanning this PC…';
  try {
    const r = await fetch('/api/discover', { cache: 'no-store' });
    const res = await r.json();
    if (!res.ok) { $('#disc-sub').textContent = res.message; return; }
    discData = res;
    const fresh = res.ports.filter((p) => !p.system && !p.tracked).length;
    $('#disc-sub').textContent = fresh
      ? fresh + ' open port' + (fresh === 1 ? '' : 's') + ' not on your dashboard yet. Click Add to track one.'
      : 'Everything listening is already on your dashboard.';
    renderDiscover();
  } catch (e) {
    $('#disc-sub').textContent = 'Scan failed. Is the dashboard still running?';
  }
}

disc.querySelectorAll('[data-tab]').forEach((c) => (c.onclick = () => {
  disc.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === c));
  discTab = c.dataset.tab;
  renderDiscover();
}));
disc.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => disc.close()));
disc.addEventListener('click', (ev) => { if (ev.target === disc) disc.close(); });
$('#disc-search').oninput = renderDiscover;
$('#disc-system').onchange = renderDiscover;
$('#disc-rescan').onclick = scan;
$('#discover-btn').onclick = () => { disc.showModal(); scan(); };

/* ---------- System stats ---------- */
function bytes(n, perSecond) {
  const units = perSecond ? ['B/s', 'KB/s', 'MB/s', 'GB/s'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
}

// Draws one or more series into an SVG sparkline. Each series: {values, cls, max?}
function spark(svg, series, maxSlots) {
  const NS = 'http://www.w3.org/2000/svg';
  svg.replaceChildren();
  const max = Math.max(...series.map((s) => s.max || Math.max(1, ...s.values)));
  for (const s of series) {
    if (s.values.length < 2) continue;
    const step = 100 / (maxSlots - 1);
    const x0 = 100 - (s.values.length - 1) * step;
    const pts = s.values.map((v, i) => [x0 + i * step, 32 - (v / max) * 30]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ');
    const area = document.createElementNS(NS, 'path');
    area.setAttribute('d', line + ` L100 32 L${x0.toFixed(2)} 32 Z`);
    area.setAttribute('class', 'area ' + s.cls);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', line);
    path.setAttribute('class', 'line ' + s.cls);
    svg.append(area, path);
  }
}

function renderSystem(sys) {
  if (!sys.available) {
    $('#system').hidden = true;
    $('#procs-panel').hidden = true;
    $('#system-missing').hidden = false;
    $('#system-missing').textContent = 'System stats are off. ' + (sys.message || '');
    return;
  }
  if (sys.loading) return;
  $('#system').hidden = false;
  $('#system-missing').hidden = true;
  const hist = sys.history || [];
  const slots = 90;

  $('#cpu-value').textContent = Math.round(sys.cpu) + '%';
  $('#cpu-sub').textContent = sys.cores + ' cores' + (sys.cpu_freq ? ' · ' + (sys.cpu_freq / 1000).toFixed(2) + ' GHz' : '');
  spark($('#cpu-spark'), [{ values: hist.map((h) => h[0]), cls: 'cpu', max: 100 }], slots);

  $('#ram-value').textContent = Math.round(sys.memory.percent) + '%';
  $('#ram-sub').textContent = bytes(sys.memory.used) + ' of ' + bytes(sys.memory.total);
  spark($('#ram-spark'), [{ values: hist.map((h) => h[1]), cls: 'ram', max: 100 }], slots);

  $('#net-down').textContent = bytes(sys.net.down, true);
  $('#net-up').textContent = bytes(sys.net.up, true);
  $('#net-sub').textContent = 'up ' + ago(Date.now() / 1000 - sys.boot_time);
  $('#net-sub').title = 'Time since Windows started';
  spark($('#net-spark'), [
    { values: hist.map((h) => h[2]), cls: 'down' },
    { values: hist.map((h) => h[3]), cls: 'up' },
  ], slots);

  const disks = $('#disks');
  disks.replaceChildren(...sys.disks.map((d) => {
    const row = el('div', 'disk-row');
    const meter = el('div', 'meter');
    const fill = el('i', d.percent >= 95 ? 'full' : d.percent >= 85 ? 'warn' : '');
    fill.style.width = d.percent + '%';
    meter.append(fill);
    row.append(el('b', '', d.mount.replace(/\\$/, '')), el('span', 'disk-meta', bytes(d.total - d.used) + ' free'), meter);
    return row;
  }));
  const used = sys.disks.reduce((a, d) => a + d.used, 0);
  const total = sys.disks.reduce((a, d) => a + d.total, 0);
  $('#disk-sub').textContent = total ? Math.round((100 * used) / total) + '% used' : '';

  $('#procs-panel').hidden = !sys.processes.length;
  $('#procs').replaceChildren(...sys.processes.map((p) => {
    const tr = el('tr');
    const name = el('td', '', p.name);
    name.title = p.name + ' (PID ' + p.pid + ')';
    tr.append(name, el('td', '', p.cpu.toFixed(1) + '%'), el('td', '', bytes(p.memory)));
    return tr;
  }));
}

async function refreshSystem() {
  try {
    renderSystem(await (await fetch('/api/system', { cache: 'no-store' })).json());
  } catch (e) { /* the live indicator already shows connection problems */ }
}

refreshSystem();
setInterval(refreshSystem, window.SYSTEM_EVERY * 1000);

document.querySelectorAll('.chip[data-filter]').forEach((c) => (c.onclick = () => {
  document.querySelectorAll('.chip[data-filter]').forEach((x) => x.classList.toggle('active', x === c));
  filter = c.dataset.filter;
  render();
}));
$('#search').oninput = render;

refresh();
setInterval(refresh, window.CHECK_EVERY * 1000);
