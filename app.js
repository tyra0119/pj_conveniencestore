'use strict';

// ===== 設定 =====
const STORAGE_KEY = 'konbini-route:v1';

const CHAINS = {
  lawson: { label: 'ローソン', color: '#0068b7', re: /ローソン|lawson/i },
  seven: { label: 'セブン-イレブン', color: '#e8590c', re: /セブン[\s\-‐－ー・]?イレブン|7[\s\-‐]?eleven|seven[\s\-‐]?eleven/i },
  family: { label: 'ファミリーマート', color: '#2b8a3e', re: /ファミリーマート|family\s?mart/i },
};

const STATUSES = {
  bought: { label: '購入', icon: '🎯', tone: 'ok' },
  soldout: { label: '売切れ', icon: '❌', tone: 'ng' },
  none: { label: '取扱なし', icon: '🚫', tone: 'ng' },
  skip: { label: 'スキップ', icon: '⏭', tone: 'skip' },
};

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OSRM_BASE = 'https://router.project-osrm.org';
const EXACT_LIMIT = 15; // この店舗数以下なら全組み合わせから厳密な最短を求める
const GMAPS_MAX_WAYPOINTS = 9; // Googleマップ URL に渡せる経由地の上限
const ROAD_FACTOR = 1.35; // 道路データが取れないときの「直線距離→道路距離」係数
const FALLBACK_SPEED = 40 / 3.6; // 同上の平均速度 (m/s)
const NO_NAME_CAMPAIGN = '(名称未設定)';

// ===== 保存データ =====
const DEFAULTS = {
  settings: { radius: 5, chains: ['lawson', 'seven'], dwell: 5, roundtrip: false, skipRecorded: true, campaign: '' },
  start: null, // { lat, lng, label }
  stores: [], // 直近の検索結果
  searchedAt: null,
  custom: [], // 手動追加した店舗
  excluded: {}, // { storeId: true }
  records: {}, // { くじ名: { storeId: { status, note, at } } }
  route: null,
};

const db = load();

function load() {
  const base = structuredClone(DEFAULTS);
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...base, ...raw, settings: { ...base.settings, ...raw.settings } };
  } catch {
    return base;
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (e) {
    console.warn('保存に失敗しました', e);
  }
}

function campaignKey() {
  return db.settings.campaign.trim() || NO_NAME_CAMPAIGN;
}

function currentRecords() {
  return (db.records[campaignKey()] ||= {});
}

// ===== ユーティリティ =====
const $ = (sel) => document.querySelector(sel);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function haversine(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const fmtDist = (m) => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`);

function fmtDur(sec) {
  const min = Math.round(sec / 60);
  return min < 60 ? `${min}分` : `${Math.floor(min / 60)}時間${min % 60}分`;
}

const fmtClock = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let toastTimer;
function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function withBusy(btn, label, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(e.name === 'AbortError' ? '通信がタイムアウトしました' : e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('この端末では現在地を取得できません'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => reject(new Error(`現在地を取得できませんでした（${e.message}）`)),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

const navUrl = (p) => `https://www.google.com/maps/dir/?api=1&travelmode=driving&dir_action=navigate&destination=${p.lat},${p.lng}`;

function gmapsUrl(origin, destination, waypoints) {
  const ll = (p) => `${p.lat},${p.lng}`;
  let url = `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${ll(destination)}`;
  url += origin ? `&origin=${ll(origin)}` : '&dir_action=navigate'; // origin 省略時は現在地から
  if (waypoints.length) url += `&waypoints=${encodeURIComponent(waypoints.map(ll).join('|'))}`;
  return url;
}

// ===== 外部データ =====
async function geocode(q) {
  try {
    const r = await fetchJson(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`, {}, 10000);
    if (r.length) {
      const [lng, lat] = r[0].geometry.coordinates;
      return { lat, lng, label: r[0].properties.title };
    }
  } catch (e) {
    console.warn('国土地理院の住所検索に失敗', e);
  }
  const r = await fetchJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=jp&accept-language=ja&q=${encodeURIComponent(q)}`, {}, 10000);
  if (!r.length) throw new Error(`「${q}」が見つかりませんでした`);
  return { lat: Number(r[0].lat), lng: Number(r[0].lon), label: r[0].display_name };
}

async function fetchStores(center, radiusKm) {
  const query = `[out:json][timeout:25];nwr["shop"="convenience"](around:${Math.round(radiusKm * 1000)},${center.lat},${center.lng});out center tags;`;
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const json = await fetchJson(endpoint, { method: 'POST', body: new URLSearchParams({ data: query }) }, 30000);
      return dedupe(json.elements.map(toStore).filter(Boolean));
    } catch (e) {
      lastError = e;
      console.warn(endpoint, e);
    }
  }
  throw new Error(`店舗データを取得できませんでした（${lastError?.message}）`);
}

function toStore(el) {
  const t = el.tags || {};
  const text = [t.brand, t['brand:ja'], t['brand:en'], t.name, t['name:ja'], t['name:en'], t.operator].filter(Boolean).join(' ');
  const chain = Object.keys(CHAINS).find((k) => CHAINS[k].re.test(text));
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (!chain || lat == null) return null;
  let name = t.name || t['name:ja'] || CHAINS[chain].label;
  if (t.branch && !name.includes(t.branch)) name += ` ${t.branch}`;
  return { id: `osm:${el.type}/${el.id}`, name, chain, lat, lng };
}

// 同じ店舗が点と建物の両方で登録されている場合の重複を除く
function dedupe(stores) {
  const out = [];
  for (const s of stores) {
    if (!out.some((o) => o.chain === s.chain && haversine(o, s) < 40)) out.push(s);
  }
  return out;
}

function straightMatrix(points) {
  const distance = points.map((a) => points.map((b) => haversine(a, b) * ROAD_FACTOR));
  return { distance, duration: distance.map((row) => row.map((d) => d / FALLBACK_SPEED)), source: 'straight' };
}

async function buildMatrix(points) {
  const fallback = straightMatrix(points);
  try {
    const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const j = await fetchJson(`${OSRM_BASE}/table/v1/driving/${coords}?annotations=duration,distance`, {}, 15000);
    if (j.code !== 'Ok') throw new Error(j.code);
    const fill = (m, fb) => m.map((row, i) => row.map((v, k) => v ?? fb[i][k]));
    return { duration: fill(j.durations, fallback.duration), distance: fill(j.distances, fallback.distance), source: 'osrm' };
  } catch (e) {
    console.warn('OSRM の距離表取得に失敗。直線距離で概算します', e);
    return fallback;
  }
}

async function fetchRouteGeometry(seq) {
  try {
    const coords = seq.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const j = await fetchJson(`${OSRM_BASE}/route/v1/driving/${coords}?overview=full&geometries=geojson`, {}, 15000);
    if (j.code !== 'Ok') throw new Error(j.code);
    const r = j.routes[0];
    return {
      legs: r.legs.map((l) => ({ duration: l.duration, distance: l.distance })),
      coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    };
  } catch (e) {
    console.warn('OSRM のルート形状取得に失敗', e);
    return null;
  }
}

// ===== 巡回順の最適化 =====
// D はノード 0 = 出発地、ノード i+1 = 店舗 i のコスト行列。戻り値は店舗インデックスの訪問順。
function pathCost(D, order, roundtrip) {
  if (!order.length) return 0;
  let c = D[0][order[0] + 1];
  for (let k = 1; k < order.length; k++) c += D[order[k - 1] + 1][order[k] + 1];
  if (roundtrip) c += D[order[order.length - 1] + 1][0];
  return c;
}

function solveTsp(D, n, roundtrip) {
  if (n <= 1) return n ? [0] : [];
  return n <= EXACT_LIMIT ? solveExact(D, n, roundtrip) : solveHeuristic(D, n, roundtrip);
}

// Held-Karp 法（動的計画法）: 全順列を試したのと同じ厳密な最短順を求める
function solveExact(D, n, roundtrip) {
  const FULL = 1 << n;
  const dp = new Float64Array(FULL * n).fill(Infinity);
  const parent = new Int8Array(FULL * n).fill(-1);
  for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = D[0][j + 1];

  for (let mask = 1; mask < FULL; mask++) {
    for (let j = 0; j < n; j++) {
      const cur = dp[mask * n + j];
      if (!(mask & (1 << j)) || cur === Infinity) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const idx = (mask | (1 << k)) * n + k;
        const v = cur + D[j + 1][k + 1];
        if (v < dp[idx]) {
          dp[idx] = v;
          parent[idx] = j;
        }
      }
    }
  }

  const all = FULL - 1;
  let best = Infinity;
  let last = 0;
  for (let j = 0; j < n; j++) {
    const v = dp[all * n + j] + (roundtrip ? D[j + 1][0] : 0);
    if (v < best) {
      best = v;
      last = j;
    }
  }

  const order = [];
  for (let mask = all, j = last; j !== -1;) {
    order.push(j);
    const p = parent[mask * n + j];
    mask ^= 1 << j;
    j = p;
  }
  return order.reverse();
}

// 店舗が多いとき用: 最近傍法 → 2-opt / Or-opt で改善
function solveHeuristic(D, n, roundtrip) {
  const used = new Array(n).fill(false);
  let order = [];
  for (let s = 0, cur = 0; s < n; s++) {
    let next = -1;
    for (let j = 0; j < n; j++) {
      if (!used[j] && (next === -1 || D[cur][j + 1] < D[cur][next + 1])) next = j;
    }
    used[next] = true;
    order.push(next);
    cur = next + 1;
  }

  let bestCost = pathCost(D, order, roundtrip);
  const tryOrder = (cand) => {
    const c = pathCost(D, cand, roundtrip);
    if (c < bestCost - 1e-6) {
      order = cand;
      bestCost = c;
      return true;
    }
    return false;
  };

  for (let improved = true; improved;) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        improved = tryOrder([...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)]) || improved;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const cand = order.slice();
        cand.splice(j, 0, ...cand.splice(i, 1));
        improved = tryOrder(cand) || improved;
      }
    }
  }
  return order;
}

// ===== 操作 =====
function visibleStores() {
  const list = [...db.stores, ...db.custom].filter((s) => db.settings.chains.includes(s.chain));
  if (db.start) list.sort((a, b) => haversine(db.start, a) - haversine(db.start, b));
  return list;
}

function markRouteStale() {
  if (db.route) db.route.stale = true;
}

function setStart(point) {
  db.start = point;
  db.route = null;
  save();
  renderAll();
  fitStart();
}

async function searchStores() {
  if (!db.start) throw new Error('先に出発地を指定してください');
  db.stores = await fetchStores(db.start, db.settings.radius);
  db.searchedAt = Date.now();
  db.route = null;
  save();
  renderAll();
  fitStart();
  const n = visibleStores().filter((s) => !s.custom).length;
  toast(n ? `${n}店舗見つかりました` : '見つかりませんでした。地図をタップすると手動で追加できます', 4000);
}

async function computeRoute(fromCurrent) {
  if (fromCurrent) {
    db.start = { ...(await getPosition()), label: '現在地' };
    $('#start-time').value = nowHHMM();
  }
  if (!db.start) throw new Error('先に出発地を指定してください');

  const records = currentRecords();
  const skipRecorded = fromCurrent || db.settings.skipRecorded;
  const targets = visibleStores().filter((s) => !db.excluded[s.id] && !(skipRecorded && records[s.id]?.status));
  if (!targets.length) throw new Error('巡回する店舗がありません');

  const { roundtrip } = db.settings;
  const matrix = await buildMatrix([db.start, ...targets]);
  const order = solveTsp(matrix.duration, targets.length, roundtrip);
  const nearestFirst = targets.map((_, i) => i); // targets は出発地から近い順
  const savedSec = pathCost(matrix.duration, nearestFirst, roundtrip) - pathCost(matrix.duration, order, roundtrip);

  const nodes = [0, ...order.map((i) => i + 1), ...(roundtrip ? [0] : [])];
  const seq = nodes.map((node) => (node === 0 ? db.start : targets[node - 1]));
  const geometry = await fetchRouteGeometry(seq);
  const legs = geometry?.legs
    ?? nodes.slice(1).map((node, k) => ({ duration: matrix.duration[nodes[k]][node], distance: matrix.distance[nodes[k]][node] }));

  db.route = {
    start: { ...db.start },
    stops: order.map((i) => ({ ...targets[i] })),
    legs,
    coords: geometry?.coords ?? seq.map((p) => [p.lat, p.lng]),
    roundtrip,
    orderSource: matrix.source,
    savedSec: Math.max(0, savedSec),
    startTime: $('#start-time').value || nowHHMM(),
    stale: false,
  };
  save();
  renderAll();
  fitRoute();
  toast(`${targets.length}店舗の巡回ルートを作成しました`);
}

function toggleExcluded(id) {
  if (db.excluded[id]) delete db.excluded[id];
  else db.excluded[id] = true;
  markRouteStale();
  save();
  renderAll();
}

function setStatus(id, status) {
  const records = currentRecords();
  const rec = (records[id] ||= {});
  rec.status = rec.status === status ? undefined : status;
  rec.at = Date.now();
  if (!rec.status && !rec.note) delete records[id];
  save();
  renderAll();
}

function setNote(id, note) {
  const records = currentRecords();
  const rec = (records[id] ||= {});
  rec.note = note.trim() || undefined;
  if (!rec.status && !rec.note) delete records[id];
  save();
}

// ===== 地図 =====
const map = L.map('map', { keyboard: false }).setView([36.2, 138.25], 5);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
}).addTo(map);

const layers = {
  start: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
  stores: L.layerGroup().addTo(map),
};
const markers = new Map();

const pinIcon = (color, text, faded = false) => L.divIcon({
  className: 'pin-wrap',
  html: `<div class="pin${faded ? ' faded' : ''}" style="--c:${color}">${esc(text)}</div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -14],
});

function fitStart() {
  if (db.start) map.fitBounds(L.latLng(db.start.lat, db.start.lng).toBounds(db.settings.radius * 2000));
}

function fitRoute() {
  if (db.route) map.fitBounds(L.latLngBounds(db.route.coords), { padding: [30, 30] });
}

function storePopup(s) {
  const excluded = !!db.excluded[s.id];
  const div = document.createElement('div');
  div.className = 'popup';
  div.innerHTML = `
    <b>${esc(s.name)}</b>
    <div class="muted small">${CHAINS[s.chain].label}${s.custom ? '（手動追加）' : ''}</div>
    <div class="row">
      <a class="btn small primary" href="${esc(navUrl(s))}" target="_blank" rel="noopener">ナビ</a>
      <button class="btn small" type="button">${excluded ? 'ルートに含める' : 'ルートから外す'}</button>
    </div>`;
  div.querySelector('button').onclick = () => {
    map.closePopup();
    toggleExcluded(s.id);
  };
  return div;
}

map.on('click', (e) => {
  const { lat, lng } = e.latlng;
  const defaultChain = db.settings.chains[0] || 'lawson';
  const div = document.createElement('div');
  div.className = 'popup';
  div.innerHTML = `
    <button class="btn small primary block" type="button" data-act="start">🏠 ここを出発地にする</button>
    <hr>
    <div class="small muted">この場所に店舗を手動追加</div>
    <select data-act="chain">${Object.entries(CHAINS).map(([k, c]) => `<option value="${k}"${k === defaultChain ? ' selected' : ''}>${c.label}</option>`).join('')}</select>
    <input data-act="name" type="text" placeholder="店名（例：○○店）">
    <button class="btn small block" type="button" data-act="add">＋ 店舗を追加</button>`;

  div.querySelector('[data-act=start]').onclick = () => {
    map.closePopup();
    setStart({ lat, lng, label: '地図で指定した地点' });
  };
  div.querySelector('[data-act=add]').onclick = () => {
    const chain = div.querySelector('[data-act=chain]').value;
    const { label, re } = CHAINS[chain];
    const typed = div.querySelector('[data-act=name]').value.trim();
    const name = !typed ? `${label}（手動追加）` : re.test(typed) ? typed : `${label} ${typed}`;
    db.custom.push({ id: `custom:${Date.now()}`, name, chain, lat, lng, custom: true });
    if (!db.settings.chains.includes(chain)) db.settings.chains.push(chain);
    markRouteStale();
    save();
    map.closePopup();
    syncControls();
    renderAll();
    toast(`「${name}」を追加しました`);
  };

  L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
});

// ===== 描画 =====
function renderAll() {
  renderStart();
  renderStores();
  renderRoute();
  renderRecordSummary();
}

function renderStart() {
  layers.start.clearLayers();
  $('#start-label').textContent = db.start
    ? `出発地：${db.start.label}`
    : '出発地：未設定（地図をタップして指定することもできます）';
  if (!db.start) return;
  L.circle([db.start.lat, db.start.lng], {
    radius: db.settings.radius * 1000, color: '#0068b7', weight: 1, fillOpacity: 0.04, interactive: false,
  }).addTo(layers.start);
  L.marker([db.start.lat, db.start.lng], { icon: pinIcon('#c2255c', '🏠'), zIndexOffset: 1000 })
    .bindPopup(`出発地<br>${esc(db.start.label)}`)
    .addTo(layers.start);
}

function renderStores() {
  layers.stores.clearLayers();
  markers.clear();
  const stores = visibleStores();
  const records = currentRecords();
  const routeIndex = new Map((db.route?.stops ?? []).map((s, i) => [s.id, i + 1]));
  const list = $('#store-list');

  $('#store-count').textContent = stores.length ? `${stores.filter((s) => !db.excluded[s.id]).length} / ${stores.length}` : '';

  if (!stores.length) {
    const msg = !db.start ? '出発地を指定してから検索してください'
      : db.searchedAt ? '該当する店舗がありません。地図をタップすると手動で追加できます'
        : '「店舗を検索」を押してください';
    list.innerHTML = `<li class="empty">${msg}</li>`;
    return;
  }

  list.innerHTML = stores.map((s) => {
    const excluded = !!db.excluded[s.id];
    const st = STATUSES[records[s.id]?.status];
    return `
      <li class="store${excluded ? ' off' : ''}" data-id="${esc(s.id)}">
        <label class="store-main">
          <input type="checkbox" data-action="toggle"${excluded ? '' : ' checked'}>
          <span class="dot" style="--c:${CHAINS[s.chain].color}"></span>
          <span class="store-name">${esc(s.name)}</span>
        </label>
        ${st ? `<span class="tag ${st.tone === 'ok' ? 'ok' : 'ng'}">${st.icon}${st.label}</span>` : ''}
        <span class="muted small">${db.start ? fmtDist(haversine(db.start, s)) : ''}</span>
        <button class="icon-btn" type="button" data-action="focus" title="地図で見る">🗺</button>
        ${s.custom ? '<button class="icon-btn" type="button" data-action="delete" title="削除">✕</button>' : ''}
      </li>`;
  }).join('');

  for (const s of stores) {
    const done = !!records[s.id]?.status;
    const label = done ? '✓' : (routeIndex.get(s.id) ?? '');
    const marker = L.marker([s.lat, s.lng], {
      icon: pinIcon(done ? '#868e96' : CHAINS[s.chain].color, label, !!db.excluded[s.id]),
    }).bindPopup(() => storePopup(s)).addTo(layers.stores);
    markers.set(s.id, marker);
  }
}

function renderRoute() {
  layers.route.clearLayers();
  const r = db.route;
  $('#nav-card').hidden = !r;
  if (!r) {
    $('#route-summary').innerHTML = '';
    return;
  }

  L.polyline(r.coords, { color: '#c2255c', weight: 5, opacity: 0.75, interactive: false }).addTo(layers.route);

  const records = currentRecords();
  const dwellSec = db.settings.dwell * 60;
  const [hh, mm] = (r.startTime || nowHHMM()).split(':').map(Number);
  const departAt = new Date();
  departAt.setHours(hh, mm, 0, 0);

  let elapsed = 0;
  let drive = 0;
  let dist = 0;
  const etas = r.stops.map((_, i) => {
    elapsed += r.legs[i].duration;
    drive += r.legs[i].duration;
    dist += r.legs[i].distance;
    const arrive = new Date(departAt.getTime() + elapsed * 1000);
    elapsed += dwellSec;
    return arrive;
  });
  let backAt = null;
  const returnLeg = r.roundtrip ? r.legs[r.stops.length] : null;
  if (returnLeg) {
    elapsed += returnLeg.duration;
    drive += returnLeg.duration;
    dist += returnLeg.distance;
    backAt = new Date(departAt.getTime() + elapsed * 1000);
  }
  const endAt = new Date(departAt.getTime() + elapsed * 1000);

  $('#route-summary').innerHTML = `
    <div class="summary">
      <div><span class="big">${r.stops.length}</span><span class="label">店舗</span></div>
      <div><span class="big">${fmtDur(drive)}</span><span class="label">運転時間</span></div>
      <div><span class="big">${fmtDist(dist)}</span><span class="label">走行距離</span></div>
    </div>
    <p class="small">滞在時間込みで約${fmtDur(elapsed)}（${fmtClock(departAt)}出発 → ${fmtClock(endAt)}${r.roundtrip ? '帰着' : '終了'}）</p>
    ${r.savedSec >= 60 ? `<p class="small ok">近い店から順に回るより約${fmtDur(r.savedSec)}短縮</p>` : ''}
    ${r.orderSource === 'straight' ? '<p class="small warn">道路データを取得できなかったため、直線距離をもとに順番を決めました</p>' : ''}
    ${r.stale ? '<p class="small warn">⚠ 店舗や設定が変わりました。ルートを再計算してください</p>' : ''}`;

  const doneCount = r.stops.filter((s) => records[s.id]?.status).length;
  $('#progress').textContent = `${doneCount} / ${r.stops.length} 完了`;

  const next = r.stops.find((s) => !records[s.id]?.status);
  const btnNext = $('#btn-next');
  const nextTarget = next ?? (r.roundtrip ? r.start : null);
  btnNext.textContent = next ? `▶ 次へ：${next.name}` : r.roundtrip ? '🏠 出発地へ戻る' : '🎉 全店舗まわりました';
  btnNext.classList.toggle('disabled', !nextTarget);
  if (nextTarget) btnNext.href = navUrl(nextTarget);
  else btnNext.removeAttribute('href');

  $('#route-list').innerHTML = r.stops.map((s, i) => {
    const rec = records[s.id];
    return `
      <li class="stop${rec?.status ? ' done' : ''}" data-id="${esc(s.id)}">
        <div class="stop-head">
          <span class="num" style="--c:${CHAINS[s.chain].color}">${i + 1}</span>
          <div class="stop-info">
            <div class="store-name">${esc(s.name)}</div>
            <div class="muted small">${fmtClock(etas[i])}着 ・ ${fmtDur(r.legs[i].duration)} ・ ${fmtDist(r.legs[i].distance)}</div>
          </div>
          <a class="btn small primary" href="${esc(navUrl(s))}" target="_blank" rel="noopener">ナビ</a>
        </div>
        <div class="status-row">
          ${Object.entries(STATUSES).map(([key, st]) => `<button type="button" class="chip${rec?.status === key ? ` on ${st.tone}` : ''}" data-action="status" data-status="${key}">${st.icon} ${st.label}</button>`).join('')}
        </div>
        <input class="note" type="text" data-action="note" placeholder="メモ（残り枚数・購入数など）" value="${esc(rec?.note)}">
      </li>`;
  }).join('') + (returnLeg ? `
      <li class="stop">
        <div class="stop-head">
          <span class="num" style="--c:#c2255c">🏠</span>
          <div class="stop-info">
            <div class="store-name">出発地に戻る</div>
            <div class="muted small">${fmtClock(backAt)}着 ・ ${fmtDur(returnLeg.duration)} ・ ${fmtDist(returnLeg.distance)}</div>
          </div>
          <a class="btn small" href="${esc(navUrl(r.start))}" target="_blank" rel="noopener">ナビ</a>
        </div>
      </li>` : '');

  const links = gmapsChunkLinks(r, records);
  $('#gmaps-links').innerHTML = links.length
    ? `<p class="small muted">残りのルートをGoogleマップでまとめて開く（1リンクあたり経由地${GMAPS_MAX_WAYPOINTS}か所まで）</p>`
      + links.map((l, i) => `<a class="btn block" href="${esc(l.url)}" target="_blank" rel="noopener">🗺 ${links.length > 1 ? `パート${i + 1}：` : ''}${esc(l.from)} → ${esc(l.to)}（${l.count}か所）</a>`).join('')
    : '';
}

// 未訪問の店舗を、Googleマップの経由地上限ごとに分割したリンクにする
function gmapsChunkLinks(r, records) {
  const points = [
    ...r.stops.filter((s) => !records[s.id]?.status),
    ...(r.roundtrip ? [{ ...r.start, name: '出発地' }] : []),
  ];
  const links = [];
  let origin = null; // 最初のリンクは現在地から
  for (let i = 0; i < points.length;) {
    const chunk = points.slice(i, i + GMAPS_MAX_WAYPOINTS + 1);
    const destination = chunk[chunk.length - 1];
    links.push({
      url: gmapsUrl(origin, destination, chunk.slice(0, -1)),
      from: origin ? origin.name : '現在地',
      to: destination.name,
      count: chunk.length,
    });
    origin = destination;
    i += chunk.length;
  }
  return links;
}

function renderRecordSummary() {
  const recs = Object.values(currentRecords()).filter((r) => r.status);
  $('#record-summary').textContent = recs.length
    ? `記録：${Object.entries(STATUSES).map(([k, st]) => `${st.icon}${st.label} ${recs.filter((r) => r.status === k).length}`).join('　')}`
    : '';
}

function syncControls() {
  const s = db.settings;
  $('#radius').value = s.radius;
  $('#radius-out').textContent = s.radius;
  document.querySelectorAll('input[name=chain]').forEach((el) => { el.checked = s.chains.includes(el.value); });
  $('#dwell').value = s.dwell;
  $('#roundtrip').checked = s.roundtrip;
  $('#skip-recorded').checked = s.skipRecorded;
  $('#campaign').value = s.campaign;
  $('#start-time').value = db.route?.startTime || nowHHMM();
}

// ===== イベント =====
$('#btn-locate').addEventListener('click', (e) => withBusy(e.currentTarget, '取得中…', async () => {
  setStart({ ...(await getPosition()), label: '現在地' });
}));

$('#addr-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#addr-input').value.trim();
  if (!q) return;
  withBusy(e.currentTarget.querySelector('button'), '…', async () => setStart(await geocode(q)));
});

$('#radius').addEventListener('input', (e) => {
  db.settings.radius = Number(e.target.value);
  $('#radius-out').textContent = db.settings.radius;
  save();
  renderStart();
});

document.querySelectorAll('input[name=chain]').forEach((el) => el.addEventListener('change', () => {
  db.settings.chains = [...document.querySelectorAll('input[name=chain]:checked')].map((c) => c.value);
  markRouteStale();
  save();
  renderAll();
}));

$('#btn-search').addEventListener('click', (e) => withBusy(e.currentTarget, '検索中…', searchStores));
$('#btn-route').addEventListener('click', (e) => withBusy(e.currentTarget, '計算中…', () => computeRoute(false)));
$('#btn-reroute').addEventListener('click', (e) => withBusy(e.currentTarget, '計算中…', () => computeRoute(true)));

$('#campaign').addEventListener('change', (e) => {
  db.settings.campaign = e.target.value;
  save();
  renderAll();
});

$('#start-time').addEventListener('change', (e) => {
  if (!db.route) return;
  db.route.startTime = e.target.value;
  save();
  renderRoute();
});

$('#dwell').addEventListener('input', (e) => {
  db.settings.dwell = Math.max(0, Number(e.target.value) || 0);
  save();
  renderRoute();
});

$('#roundtrip').addEventListener('change', (e) => {
  db.settings.roundtrip = e.target.checked;
  markRouteStale();
  save();
  renderRoute();
});

$('#skip-recorded').addEventListener('change', (e) => {
  db.settings.skipRecorded = e.target.checked;
  save();
});

$('#btn-reset-records').addEventListener('click', () => {
  if (!confirm(`「${campaignKey()}」の記録をすべて消去しますか？`)) return;
  delete db.records[campaignKey()];
  save();
  renderAll();
});

$('#store-list').addEventListener('change', (e) => {
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (id && e.target.dataset.action === 'toggle') toggleExcluded(id);
});

$('#store-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  const id = btn?.closest('[data-id]')?.dataset.id;
  if (!id) return;
  if (btn.dataset.action === 'focus') {
    const marker = markers.get(id);
    map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15));
    marker.openPopup();
    $('#map').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (btn.dataset.action === 'delete') {
    db.custom = db.custom.filter((s) => s.id !== id);
    markRouteStale();
    save();
    renderAll();
  }
});

$('#route-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action=status]');
  const id = btn?.closest('[data-id]')?.dataset.id;
  if (id) setStatus(id, btn.dataset.status);
});

$('#route-list').addEventListener('change', (e) => {
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (id && e.target.dataset.action === 'note') setNote(id, e.target.value);
});

// ===== 起動 =====
syncControls();
renderAll();
if (db.route) fitRoute();
else fitStart();
