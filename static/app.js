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
// Link that opens a service. Uses the address it actually answered on, so services
// that only listen on the network address (192.168.x.x) still open from localhost.
function openUrl(s) {
  if (!s.port) return s.public_url || null;
  const host = s.open_host || location.hostname;
  return 'http://' + host + ':' + s.port + (s.path || '/');
}

function renderQuick(rows) {
  const bar = $('#quick');
  const links = rows.filter((r) => openUrl(r));
  bar.hidden = !links.length;
  $('#quick-links').replaceChildren(...links.map((r) => {
    const a = el('a', 'quick' + (r.up ? ' up' : '') + (r.pinned ? ' pinned' : ''));
    a.href = openUrl(r); a.target = '_blank'; a.rel = 'noopener';
    a.title = (r.up ? 'Open ' : 'Offline: ') + a.href;
    a.append(el('span', 'qdot'), el('span', '', (r.pinned ? '★ ' : '') + r.name));
    if (r.port) a.append(el('small', '', ':' + r.port));
    return a;
  }));
}

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
  const url = openUrl(s);
  if (url) {
    const h = el('h3');
    const link = el('a', 'title-link', s.name);
    link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.title = 'Open ' + url;
    h.append(link);
    title.append(h);
  } else {
    title.append(el('h3', '', s.name));
  }
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
  if (s.host) { const h = el('span'); h.append('On ', el('code', '', s.host)); meta.append(h); }
  if (s.port) { const p = el('span'); p.append('Port ', el('code', '', s.port)); meta.append(p); }
  if (s.state) meta.append(el('span', '', 'Service ' + s.state));

  // The dashboard spotted which Windows service owns this port: offer to use it.
  let suggestion = null;
  if (s.suggested_service) {
    suggestion = el('div', 'suggest');
    suggestion.append(el('span', '', (s.state === 'not installed' ? 'Wrong service name? ' : 'Found the Windows service: ') +
      s.suggested_service.display_name + ' (' + s.suggested_service.service + ')'));
    const use = el('button', 'mini primary', 'Use it');
    use.onclick = async () => {
      use.disabled = true;
      const res = await send('POST', '/api/services/' + encodeURIComponent(s.id) + '/use-service', { service: s.suggested_service.service });
      toast(res.message || 'Could not update it.', !res.ok);
      setTimeout(refresh, 800);
    };
    suggestion.append(use);
  }
  if (s.avg_latency != null) meta.append(el('span', '', 'Avg ' + ms(s.avg_latency)));

  const actions = el('div', 'actions');
  if (s.port) {
    const a = el('a', 'btn primary', 'Open');
    a.href = openUrl(s);
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

  c.append(head, metrics, strip, legend, meta);
  if (suggestion) c.append(suggestion);
  c.append(actions);
  return c;
}

function render() {
  if (!data) return;
  // Each device page shows only its own services; This PC shows the ones without a host.
  const rows = data.services.filter((r) => (currentDevice ? r.host === currentDevice : !r.host));
  const now = data.now;
  const up = rows.filter((r) => r.up).length;
  const down = rows.length - up;
  const allDown = data.services.filter((r) => !r.up).length;

  $('#stat-up').textContent = up + ' / ' + rows.length;
  $('#stat-down').textContent = down;
  $('#stat-down').classList.toggle('has', down > 0);
  const avgUp = rows.length ? rows.reduce((a, r) => a + r.uptime, 0) / rows.length : 0;
  $('#stat-uptime').textContent = rows.length ? avgUp.toFixed(1) + '%' : '–';
  const lat = rows.filter((r) => r.latency != null).map((r) => r.latency);
  $('#stat-latency').textContent = lat.length ? ms(lat.reduce((a, b) => a + b, 0) / lat.length) : '–';
  $('#overall-dot').className = 'brand-mark ' + (data.services.length ? (allDown ? 'bad' : 'ok') : '');
  document.title = (allDown ? `(${allDown} down) ` : '') + 'Services';

  const q = $('#search').value.trim().toLowerCase();
  const visible = rows.filter((r) =>
    (filter === 'all' || (filter === 'pinned' ? r.pinned : (filter === 'up') === r.up)) &&
    (!q || (r.name + ' ' + (r.group || '') + ' ' + (r.port || '')).toLowerCase().includes(q)));
  grid.replaceChildren(...visible.map((r) => card(r, now)));
  renderQuick(rows);
  $('#empty').hidden = visible.length > 0;
  $('#empty').textContent = filter === 'pinned' && !q ? 'Nothing pinned yet. Click the ☆ on a service to pin it here.'
    : !rows.length && currentDevice ? 'No services tracked on this device yet. Add one from its open ports below.'
    : 'No services match.';
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

/* ---------- Devices sidebar and pages ---------- */
let currentDevice = null;   // null = This PC, otherwise the device's host (IP or name)
let devicesData = null;

function routeFromHash() {
  const m = location.hash.match(/^#\/device\/(.+)$/);
  currentDevice = m ? decodeURIComponent(m[1]) : null;
}

function deviceTitle(d) {
  return d.name || d.host;
}

function statusClass(status) {
  return { up: 'ok', partial: 'warn', down: 'bad' }[status] || '';
}

function renderSidebar() {
  const nav = $('#device-nav');
  if (!devicesData) return;
  const pc = devicesData.this_pc;
  const items = [];
  const pcItem = el('a', 'dev-item' + (!currentDevice ? ' active' : ''));
  pcItem.href = '#/';
  const pcStatus = pc.services ? (pc.up === pc.services ? 'up' : pc.up ? 'partial' : 'down') : 'unknown';
  pcItem.append(el('span', 'dev-dot ' + statusClass(pcStatus)));
  const pcText = el('span', 'dev-text');
  pcText.append(el('b', '', 'This PC'), el('small', '', pc.name + (pc.services ? ' · ' + pc.up + '/' + pc.services + ' up' : '')));
  pcItem.append(pcText);
  items.push(pcItem);

  for (const d of devicesData.devices) {
    const a = el('a', 'dev-item' + (currentDevice === d.host ? ' active' : ''));
    a.href = '#/device/' + encodeURIComponent(d.host);
    a.append(el('span', 'dev-dot ' + statusClass(d.status)));
    const t = el('span', 'dev-text');
    const detail = d.services ? d.up + '/' + d.services + ' up' : d.ports.length + ' open port' + (d.ports.length === 1 ? '' : 's');
    t.append(el('b', '', deviceTitle(d)), el('small', '', d.host + ' · ' + detail));
    a.append(t);
    items.push(a);
  }
  if (!devicesData.devices.length) items.push(el('p', 'side-note', 'No other devices yet. Scan your network to find them.'));
  nav.replaceChildren(...items);
}

function renderDevicePage() {
  const d = currentDevice && devicesData ? devicesData.devices.find((x) => x.host === currentDevice) : null;
  $('#dev-actions').hidden = !currentDevice;
  $('#dev-ports').hidden = !currentDevice;
  $('#discover-btn').hidden = !!currentDevice;
  if (!currentDevice) {
    $('#page-title').textContent = 'This PC';
    $('#host').textContent = devicesData ? devicesData.this_pc.name : '';
    return;
  }
  $('#page-title').textContent = d ? deviceTitle(d) : currentDevice;
  $('#host').textContent = currentDevice + (d && d.hostname && d.name !== d.hostname ? ' · ' + d.hostname : '') +
    (d && d.last_seen ? ' · last scanned ' + ago(Date.now() / 1000 - d.last_seen) + ' ago' : '');
  const ports = d ? d.ports : [];
  $('#dev-ports-sub').textContent = ports.length ? 'Found by the last scan. Add one to track it.' : 'None found yet. Click Rescan ports.';
  $('#dev-ports-list').replaceChildren(...ports.map((p) => {
    const row = el('div', 'disc-row' + (p.tracked ? ' tracked' : ''));
    const main = el('div', 'disc-main');
    main.append(el('b', '', p.label || 'Open port'), el('span', '', p.web ? 'Web page' : 'Not a web page'));
    const actions = el('div', 'row-actions');
    if (p.web) {
      const a = el('a', 'btn', 'Open');
      a.href = ([443, 8443, 9443, 5001, 8920].includes(p.port) ? 'https://' : 'http://') + currentDevice + ':' + p.port + '/';
      a.target = '_blank'; a.rel = 'noopener';
      actions.append(a);
    }
    const add = el('button', 'btn ' + (p.tracked ? '' : 'primary'), p.tracked ? 'Tracked' : 'Add');
    add.disabled = p.tracked;
    add.onclick = () => openDialog(null, { name: p.label || 'Port ' + p.port, host: currentDevice, port: p.port });
    actions.append(add);
    row.append(el('span', 'disc-port', p.port), main, actions);
    return row;
  }));
}

async function loadDevices() {
  try {
    devicesData = await (await fetch('/api/devices', { cache: 'no-store' })).json();
  } catch (e) { return; }
  renderSidebar();
  renderDevicePage();
}

function go() {
  routeFromHash();
  filter = 'all';
  document.querySelectorAll('.chip[data-filter]').forEach((x) => x.classList.toggle('active', x.dataset.filter === 'all'));
  render();
  renderSidebar();
  renderDevicePage();
  refreshSystem();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', go);

$('#dev-rescan').onclick = async () => {
  const b = $('#dev-rescan');
  b.disabled = true; b.textContent = 'Scanning…';
  try {
    const res = await send('POST', '/api/devices/' + encodeURIComponent(currentDevice) + '/scan', {});
    toast(res.message, !res.ok);
  } finally {
    b.disabled = false; b.textContent = 'Rescan ports';
    loadDevices();
  }
};
$('#dev-rename').onclick = async () => {
  const d = devicesData && devicesData.devices.find((x) => x.host === currentDevice);
  const label = prompt('Name for ' + currentDevice + ' (leave empty to use its network name):', (d && d.label) || '');
  if (label === null) return;
  const res = await send('PUT', '/api/devices/' + encodeURIComponent(currentDevice), { label });
  toast(res.message, !res.ok);
  loadDevices();
};
$('#dev-forget').onclick = async () => {
  if (!confirm('Remove ' + currentDevice + ' from the sidebar? A future scan will find it again if it is still on.')) return;
  const res = await send('DELETE', '/api/devices/' + encodeURIComponent(currentDevice));
  toast(res.message, !res.ok);
  if (res.ok) location.hash = '#/';
  loadDevices();
};

// Sidebar "Scan network" uses the same scan as Discover › Network.
$('#side-scan').onclick = async () => {
  const res = await send('POST', '/api/scan', {});
  if (!res.ok) return toast(res.message || 'Could not start the scan.', true);
  setTimeout(pollScan, 300);
};

function renderSideScan() {
  const sd = scanData;
  if (!sd) return;
  $('#side-scan').disabled = sd.running;
  $('#side-scan').textContent = sd.running ? 'Scanning…' : 'Scan network';
  $('#side-meter').hidden = !sd.running;
  $('#side-fill').style.width = (sd.total ? (100 * sd.done) / sd.total : 0) + '%';
  $('#side-note').textContent = sd.running ? 'Checking ' + (sd.networks.join(', ') || 'your network') + '…'
    : sd.finished ? 'Last scan ' + ago(Date.now() / 1000 - sd.finished) + ' ago.' : 'Finds other computers on your network.';
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
      for (const key of ['name', 'host', 'port', 'group', 'service', 'path', 'public_url']) {
        if (svc[key] != null) form.elements[key].value = svc[key];
      }
    } catch (e) { toast('Could not load that service.', true); return; }
  }
  for (const [key, value] of Object.entries(prefill || {})) {
    if (value != null && form.elements[key]) form.elements[key].value = value;
  }
  found('');
  loadWinServices();
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

/* Fill in the Windows service name automatically */
let winServices = null;

async function loadWinServices() {
  if (winServices) return winServices;
  try { winServices = await (await fetch('/api/winservices', { cache: 'no-store' })).json(); } catch (e) { winServices = []; }
  $('#svc-options').replaceChildren(...winServices.map((w) => {
    const o = document.createElement('option');
    o.value = w.name;
    o.label = w.display_name + (w.status === 'running' ? '' : ' (' + w.status + ')');
    return o;
  }));
  return winServices;
}

function found(text) {
  $('#svc-found').textContent = text || '';
  $('#svc-found').hidden = !text;
}

// Typing a port looks up what's listening there and fills in the service name (and name, if blank).
form.elements.port.addEventListener('change', async () => {
  const port = form.elements.port.value.trim();
  found('');
  if (!/^\d+$/.test(port) || form.elements.host.value.trim()) return;
  try {
    const r = await (await fetch('/api/lookup?port=' + port, { cache: 'no-store' })).json();
    if (!r.found) return found('Nothing is listening on port ' + port + ' right now.');
    if (r.service && !form.elements.service.value) form.elements.service.value = r.service;
    if (!form.elements.name.value) form.elements.name.value = r.display_name || niceName(r.process);
    found('Port ' + port + ' belongs to ' + (r.display_name ? r.display_name + ' (service ' + r.service + ')' : (r.process || 'an unknown program') + ', which isn\'t a Windows service'));
  } catch (e) { /* lookup is a convenience; ignore failures */ }
});

// Picking a service from the list fills in a name if there isn't one.
form.elements.service.addEventListener('change', async () => {
  const list = await loadWinServices();
  const w = list.find((x) => x.name.toLowerCase() === form.elements.service.value.trim().toLowerCase());
  if (w && !form.elements.name.value) form.elements.name.value = w.display_name;
});

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
$('#add-btn').onclick = () => openDialog(null, currentDevice ? { host: currentDevice } : null);

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
  $('#scan-bar').hidden = discTab !== 'network';
  disc.querySelectorAll('.local-only').forEach((x) => (x.hidden = discTab === 'network'));
  if (discTab === 'network') return renderNetwork();
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

/* Network tab: other computers on the LAN */
let scanData = null;
let selDevice = null;
let scanTimer = null;

function renderNetwork() {
  const list = $('#disc-list');
  const sd = scanData;
  if (!sd) { list.replaceChildren(); return; }
  const running = sd.running;
  $('#scan-btn').disabled = running;
  $('#scan-btn').textContent = running ? 'Scanning…' : sd.finished ? 'Scan again' : 'Scan network';
  $('#scan-meter').hidden = !running;
  $('#scan-fill').style.width = (sd.total ? (100 * sd.done) / sd.total : 0) + '%';
  $('#scan-title').textContent = running ? 'Scanning ' + (sd.networks.join(', ') || 'your network') + '…'
    : sd.finished ? 'Found ' + sd.devices.length + ' device' + (sd.devices.length === 1 ? '' : 's') + ' with open ports'
    : 'Find other devices on your network';
  if (sd.finished && !running) {
    $('#scan-sub').textContent = 'Scanned ' + sd.networks.join(', ') + ' ' + ago(Date.now() / 1000 - sd.finished) + ' ago. Click a port to track it.';
  }
  $('#count-network').textContent = sd.finished ? sd.devices.length : '';
  if (sd.error) { list.replaceChildren(el('p', 'disc-empty', sd.error)); return; }

  const q = $('#disc-search').value.trim().toLowerCase();
  const devices = sd.devices.filter((d) => !q ||
    [d.ip, d.name, ...d.ports.map((p) => p.port + ' ' + p.label)].join(' ').toLowerCase().includes(q));
  if (!devices.length) {
    list.replaceChildren(el('p', 'disc-empty', running ? 'Looking…' : sd.finished ? (q ? 'Nothing matches.' : 'No other devices answered.') : ''));
    return;
  }
  // One tab per device on the left, that device's ports on the right.
  if (!devices.some((d) => d.ip === selDevice)) selDevice = devices[0].ip;
  const tabs = el('div', 'device-tabs');
  for (const d of devices) {
    const tab = el('button', 'device-tab' + (d.ip === selDevice ? ' active' : ''));
    tab.append(el('b', '', deviceName(d)), el('span', '', d.ip + ' · ' + d.ports.length + ' port' + (d.ports.length === 1 ? '' : 's')));
    tab.onclick = () => { selDevice = d.ip; renderNetwork(); };
    tabs.append(tab);
  }
  const d = devices.find((x) => x.ip === selDevice);
  const panel = el('div', 'device-panel');
  const head = el('div', 'device-head');
  head.append(el('h3', '', deviceName(d)), el('code', '', d.ip + (d.name ? ' · ' + d.name : '')));
  panel.append(head);
  for (const p of d.ports) {
    const row = el('div', 'disc-row' + (p.tracked ? ' tracked' : ''));
    const main = el('div', 'disc-main');
    main.append(el('b', '', p.label || 'Open port'), el('span', '', p.web ? 'Web page' : 'Not a web page'));
    const actions = el('div', 'row-actions');
    if (p.web) {
      const a = el('a', 'btn', 'Open');
      a.href = ([443, 8443, 9443, 5001, 8920].includes(p.port) ? 'https://' : 'http://') + d.ip + ':' + p.port + '/';
      a.target = '_blank'; a.rel = 'noopener';
      actions.append(a);
    }
    const add = el('button', 'btn ' + (p.tracked ? '' : 'primary'), p.tracked ? 'Added' : 'Add');
    add.disabled = p.tracked;
    const device = deviceName(d);
    add.onclick = () => {
      disc.close();
      openDialog(null, { name: (p.label ? p.label + ' on ' : 'Port ' + p.port + ' on ') + device, host: d.ip, port: p.port, group: device });
    };
    actions.append(add);
    row.append(el('span', 'disc-port', p.port), main, actions);
    panel.append(row);
  }
  const wrap = el('div', 'device-split');
  wrap.append(tabs, panel);
  list.replaceChildren(wrap);
}

function deviceName(d) {
  return d.name ? d.name.split('.')[0] : 'Unknown device';
}

async function pollScan() {
  try {
    scanData = await (await fetch('/api/scan', { cache: 'no-store' })).json();
  } catch (e) { return; }
  if (discTab === 'network') renderNetwork();
  else $('#count-network').textContent = scanData.finished ? scanData.devices.length : '';
  renderSideScan();
  clearTimeout(scanTimer);
  if (scanData.running) scanTimer = setTimeout(pollScan, 700);
  else loadDevices();
}

$('#scan-btn').onclick = async () => {
  const res = await send('POST', '/api/scan', { ports: $('#scan-ports').value });
  if (!res.ok) return toast(res.message || 'Could not start the scan.', true);
  setTimeout(pollScan, 300);
};

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
$('#discover-btn').onclick = () => { disc.showModal(); scan(); pollScan(); };

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
  if (currentDevice) {  // CPU, memory and processes are only known for this PC
    $('#system').hidden = true;
    $('#procs-panel').hidden = true;
    $('#system-missing').hidden = true;
    return;
  }
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

routeFromHash();
refresh();
loadDevices();
pollScan();
setInterval(refresh, window.CHECK_EVERY * 1000);
setInterval(loadDevices, window.CHECK_EVERY * 1000);
