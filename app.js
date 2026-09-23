'use strict';

// 画面の組み立ては ConveniRadar（電車版）にそろえている:
// 設定 → エリア → 計画 → 巡回 のタブ、画面中央の「検索中」と知らせ、全部クリア、実績を送る

// ===== 設定 =====
const STORAGE_KEY = 'konbini-route:v1';
const APP_URL = 'https://tyra0119.github.io/lawson/';

// icon はチェーンの配色をもとにした簡易アイコン（公式ロゴではない）
const CHAINS = {
  lawson: {
    label: 'ローソン',
    color: '#0068b7',
    re: /ローソン|lawson/i,
    icon: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#0068b7" stroke="#fff" stroke-width="2"/><path d="M12.5 6h7v3.2l3 3.3V24a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V12.5l3-3.3z" fill="#fff"/><rect x="9.5" y="15.5" width="13" height="5" fill="#0068b7"/></svg>',
  },
  seven: {
    label: 'セブン-イレブン',
    color: '#e8590c',
    re: /セブン[\s\-‐－ー・]?イレブン|7[\s\-‐]?eleven|seven[\s\-‐]?eleven/i,
    icon: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#fff" stroke="#fff" stroke-width="2"/><rect x="4" y="7" width="24" height="5.5" fill="#f58220"/><rect x="4" y="13.25" width="24" height="5.5" fill="#00a650"/><rect x="4" y="19.5" width="24" height="5.5" fill="#ee2e24"/><text x="16" y="24.5" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="19" font-weight="900" fill="#fff" stroke="#1d2330" stroke-width="1.4" paint-order="stroke">7</text></svg>',
  },
  family: {
    label: 'ファミリーマート',
    color: '#2b8a3e',
    // サークルK・サンクスは国内全店がファミリーマートに転換済みだが、OSM に旧名のまま残っていることがある
    re: /ファミリーマート|family\s?mart|サンクス|sunkus|サークル\s?K|circle\s?k/i,
    icon: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#fff" stroke="#fff" stroke-width="2"/><path d="M1 8a7 7 0 0 1 7-7h16a7 7 0 0 1 7 7v3H1z" fill="#0a8ad2"/><path d="M1 21h30v3a7 7 0 0 1-7 7H8a7 7 0 0 1-7-7z" fill="#00a73c"/><text x="16" y="20.3" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="900" fill="#0a8ad2">F</text></svg>',
  },
  ministop: {
    label: 'ミニストップ',
    color: '#1c3f94',
    re: /ミニストップ|mini\s?stop/i,
    icon: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#1c3f94" stroke="#fff" stroke-width="2"/><text x="16" y="21" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="900" fill="#fff">M</text><rect x="7" y="23.5" width="18" height="3" rx="1.5" fill="#ffd200"/></svg>',
  },
  // 取扱店リストで取り込んだ、コンビニ以外の店（書店・ホビーショップなど）。OpenStreetMap の店舗検索には使わない
  other: {
    label: 'その他のお店',
    color: '#7048e8',
    re: /(?!)/,
    icon: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#7048e8" stroke="#fff" stroke-width="2"/><path d="M8 13h16v11a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z" fill="#fff"/><path d="M6 7h20l-2 6H8z" fill="#ffd43b"/><rect x="14" y="18" width="4" height="8" fill="#7048e8"/></svg>',
  },
};

const STATUSES = {
  bought: { label: '購入', icon: '🎯', tone: 'ok' },
  soldout: { label: '売切れ', icon: '❌', tone: 'ng' },
  none: { label: '取扱なし', icon: '🚫', tone: 'ng' },
  skip: { label: 'スキップ', icon: '⏭', tone: 'skip' },
};

// 公開 Overpass サーバーは当たり外れが大きい（同じサーバーでも 2 秒で返ることも、まったく返らないこともある）。
// 1 つずつ順に試すと、落ちているサーバーの分だけ待たされる（2026-09-23 に 3 つ全部で 55 秒待ち）ので、
// 返りが遅いときは delay ミリ秒後に次のサーバーへも同じ問い合わせを出し、最初に返ったものを使う
const OVERPASS_ENDPOINTS = [
  { url: 'https://overpass-api.de/api/interpreter', delay: 0 },
  { url: 'https://overpass.openstreetmap.fr/api/interpreter', delay: 2000 },
  { url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', delay: 4000 },
  { url: 'https://overpass.kumi.systems/api/interpreter', delay: 6000 },
  { url: 'https://overpass.private.coffee/api/interpreter', delay: 8000 },
];
const OVERPASS_DEADLINE = 20000; // どのサーバーからも返らないとき、ここで失敗にする
const OSRM_BASE = 'https://router.project-osrm.org';
const EXACT_LIMIT = 15; // この店舗数以下なら全組み合わせから厳密な最短を求める
const GMAPS_MAX_WAYPOINTS = 9; // Googleマップ URL に渡せる経由地の上限
const ROAD_FACTOR = 1.35; // 道路データが取れないときの「直線距離→道路距離」係数
const FALLBACK_SPEED = 40 / 3.6; // 同上の平均速度 (m/s)
const NO_NAME_CAMPAIGN = '(名称未設定)';
const MAILTO_MAX = 1800; // これより長い mailto はメールアプリによって途中で切れる
const TABS = ['settings', 'search', 'plan', 'nav'];

// ===== 保存データ =====
const DEFAULTS = {
  settings: { radius: 5, chains: ['lawson', 'seven', 'ministop', 'other'], dwell: 5, roundtrip: false, skipRecorded: true, campaign: '', reportTo: '', useKujiList: true },
  start: null, // 出発地で、店を探す範囲の中心 { lat, lng, label, source: gps / map / address / tap }
  stores: [], // 直近の検索結果
  searched: null, // 店舗を検索した範囲 { lat, lng, radius }
  searchedAt: null,
  excluded: {}, // { storeId: true }
  records: {}, // { くじ名: { storeId: { status, note, at } } }
  kujiLists: {}, // { くじ名: { shops: [{ id, name, address, chain, lat, lng, soldOut }], importedAt } } 取扱店リスト
  route: null, // 計画
  knownChains: Object.keys(CHAINS),
  ui: { tab: 'settings' },
};

const db = load();

function load() {
  const base = structuredClone(DEFAULTS);
  try {
    // 手動で追加した店（custom）は、店舗の追加機能ごと無くしたので読み込まない（2026-09-15 利用者の指示）
    const { custom, ...raw } = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    // 半径は保存値を使わず、毎回初期値から始める
    const settings = { ...base.settings, ...raw.settings, radius: base.settings.radius };
    // 後から追加したチェーンのうち初期値でオンのものは、保存済みの選択にも加える
    const known = raw.knownChains ?? ['lawson', 'seven', 'family'];
    for (const k of base.settings.chains) {
      if (!known.includes(k) && !settings.chains.includes(k)) settings.chains.push(k);
    }
    return { ...base, ...raw, settings, ui: { ...base.ui, ...raw.ui }, knownChains: Object.keys(CHAINS) };
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

// くじ・グッズの取扱店リスト（公式の店舗検索の結果を貼り付けて取り込んだもの）。この端末にだけ保存する
function currentKujiList() {
  return db.kujiLists[campaignKey()] ?? null;
}

// 取扱店リストで回るか。回るときは、OpenStreetMap の店舗検索の代わりにリストの店を使う
function activeKujiList() {
  const list = currentKujiList();
  return db.settings.useKujiList && list?.shops.length ? list : null;
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
const pad2 = (n) => String(n).padStart(2, '0');
const nowHHMM = () => `${pad2(new Date().getHours())}:${pad2(new Date().getMinutes())}`;

let toastTimer;
function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// 見つからない・失敗したときの知らせ。画面を暗くして中央に出し、OK を押すまで残す（成功の知らせは toast のまま）
function notice(message, { title = 'お知らせ', icon = '⚠' } = {}) {
  $('#notice-icon').textContent = icon;
  $('#notice-title').textContent = title;
  $('#notice-text').textContent = message;
  $('#notice').hidden = false;
  $('#notice-ok').focus();
}

function closeNotice() {
  $('#notice').hidden = true;
}

// 利用者が止めた（「中断」を押した）ときのエラー。失敗ではないので、中央の知らせではなく小さく知らせる
class CancelError extends Error {
  constructor(message = '中断しました') {
    super(message);
    this.name = 'CancelError';
  }
}

// options.signal を渡すと、呼び出し側からも止められる（時間切れとは別に）
async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const outer = options.signal;
  const stop = () => ctrl.abort();
  if (outer?.aborted) stop();
  outer?.addEventListener('abort', stop);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', stop);
  }
}

async function withBusy(btn, label, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } catch (e) {
    if (e.name === 'CancelError') {
      toast(e.message, 5000);
      return undefined;
    }
    console.error(e);
    notice(e.name === 'AbortError' ? '通信がタイムアウトしました。電波の良い所で、もう一度試してください' : e.message, { title: 'うまくいきませんでした' });
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// 現在地。まず GPS（高精度）で取り、取れなければ（屋内・PC など）精度を落として取り直す。失敗の理由は日本語で案内する
function getPosition() {
  const other = '「🗺 地図の中心を出発地に」か住所で指定してください';
  if (!navigator.geolocation) return Promise.reject(new Error(`この端末・ブラウザでは現在地を取得できません。${other}`));
  if (!window.isSecureContext) return Promise.reject(new Error('現在地は https のページでだけ使えます'));
  const once = (options) => new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      reject,
      options,
    );
  });
  return once({ enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 })
    .catch((e) => (e.code === 1 ? Promise.reject(e) : once({ enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 })))
    .catch((e) => {
      const why = e.code === 1
        ? `位置情報の利用が許可されていません。ブラウザ（スマホは設定アプリ）で、このサイトの位置情報を「許可」にするか、${other}`
        : e.code === 3
          ? `現在地の取得に時間がかかりすぎました。屋外で試すか、${other}`
          : `現在地を特定できませんでした。位置情報サービスがオンか確かめるか、${other}`;
      throw new Error(why);
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

// signal: 利用者が「中断」を押したら止める。次のサーバーも試さずに CancelError にする
// 中断・成功で止められる待ち時間
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new DOMException('aborted', 'AbortError'));
  }, { once: true });
});

// 同じ問い合わせを時間差で複数のサーバーへ出し、最初に返ったものを使う
async function raceOverpass(query, signal, scale) {
  const ctrl = new AbortController(); // 1 つ成功したら、残りの問い合わせは止める
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const errors = [];
  const attempt = async ({ url, delay }) => {
    const host = new URL(url).hostname;
    try {
      if (delay) await wait(delay * scale, ctrl.signal);
      const json = await fetchJson(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctrl.signal }, (OVERPASS_DEADLINE - delay) * scale);
      // 混雑時は HTTP 200 のまま remark にエラーが入り、結果が空や途中までになることがある
      if (/runtime error|timed out|rate_limited|out of memory/i.test(json.remark ?? '')) throw new Error(json.remark);
      return json;
    } catch (e) {
      if (!ctrl.signal.aborted) console.warn(host, e);
      errors.push(`${host}: ${e.name === 'AbortError' ? 'タイムアウト' : e.name === 'TypeError' ? '接続できません' : e.message}`);
      throw e;
    }
  };

  try {
    return await Promise.any(OVERPASS_ENDPOINTS.map(attempt));
  } catch {
    if (signal?.aborted) throw new CancelError('店舗の検索を中断しました');
    const keep = db.stores.length ? '前回の検索結果はそのまま使えます。' : '';
    throw new Error(`店舗データのサーバーが混雑しています。少し待ってから再検索してください。${keep}（${errors.join(' / ')}）`);
  } finally {
    stop();
    signal?.removeEventListener('abort', stop);
  }
}

// signal: 利用者が「中断」を押したら止める。
// 中心からの距離（around）より四角い範囲（bbox）の方がサーバーの負担が軽いので、範囲で取ってから半径の中だけに絞る
async function fetchStores(center, radiusKm, signal) {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.max(0.1, Math.cos((center.lat * Math.PI) / 180)));
  const box = [center.lat - dLat, center.lng - dLng, center.lat + dLat, center.lng + dLng].map((v) => v.toFixed(6)).join(',');
  const query = `[out:json][timeout:25];nwr["shop"="convenience"](${box});out center tags;`;
  const scale = radiusKm > 10 ? 2 : 1; // 広い範囲は時間がかかるので待ち時間を伸ばす
  const json = await raceOverpass(query, signal, scale);
  return dedupe(json.elements.map(toStore).filter((s) => s && haversine(center, s) <= radiusKm * 1000));
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

// ===== 取扱店リストの取り込み =====
// 一番くじ公式の「店舗検索」の結果を貼り付けたものを読み取る。店名の次の行が住所、というまとまりを 1 店とみなす。
// リンク付きで貼られたとき（[店名](URL) の形や HTML）は Googleマップのリンクの座標を使い、無ければ住所から位置を調べる。
// 公式サイトへはアプリから取りに行かない（robots.txt で店舗検索のデータの取得が禁止されている。貼り付けるのは利用者本人が見た結果）
const PREFECTURES = '北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県';
// 住所の始まり: 都道府県名のすぐ後に市区郡町村が続くところ（「兵庫県庁前店」のような店名の中の県名とは区別する）
const ADDRESS_RE = new RegExp(`(?:${PREFECTURES})(?=\\S{0,6}?[市区郡町村])`);
const LIST_NOISE_RE = /^(ルートを確認する|店舗詳細へ|検索結果|検索条件|一番くじNaviとは|\d+件の店舗|発売予定日|発売日|お気に入り|TOPに戻る)/;

// 公式の店舗検索は、表示やコピーのしかたで形が変わる（2026-09-15 に 2 通りを確認）
//   店名と住所が別の行:  ローソン 山の街店 ⏎ 兵庫県神戸市北区…
//   店名と住所が 1 行:   ローソン 山の街店兵庫県神戸市北区…（住所の始まりで分ける）
function parseShopList(text) {
  const linkRe = /\[([^\]]*)\]\((\S+?)\)/g;
  const lines = text.split(/\r?\n/).map((raw) => {
    const urls = [];
    const label = raw
      .replace(linkRe, (_, t, u) => { urls.push(u); return t; })
      .replace(/https?:\/\/\S+/g, (u) => { urls.push(u); return ''; })
      .replace(/^[\s*・•-]+/, '')
      .trim();
    return { label, urls };
  }).filter((l) => l.label || l.urls.length);

  const addressAt = (label) => ADDRESS_RE.exec(label ?? '')?.index ?? -1;
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const { label, urls } = lines[i];
    const next = lines[i + 1];
    const at = addressAt(label);
    if (label && !LIST_NOISE_RE.test(label) && at !== 0 && next && addressAt(next.label) === 0) {
      blocks.push({ name: label, address: next.label, urls: [...urls, ...next.urls], soldOut: false });
      i++;
    } else if (label && !LIST_NOISE_RE.test(label) && at > 0) {
      blocks.push({ name: label.slice(0, at).trim(), address: label.slice(at).trim(), urls: [...urls], soldOut: false });
    } else if (blocks.length) {
      // 店のまとまりの残り（ルートのリンク・完売の表示）
      const cur = blocks.at(-1);
      cur.urls.push(...urls);
      if (/^完売/.test(label) && label.length < 10) cur.soldOut = true;
    }
  }

  for (const b of blocks) {
    if (/\s*完売$/.test(b.address)) {
      b.address = b.address.replace(/\s*完売$/, '');
      b.soldOut = true;
    }
  }

  return blocks.map((b) => {
    const joined = b.urls.join(' ');
    const pos = /[?&]destination=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(joined);
    const shopId = /shops\/(\d+)/.exec(joined)?.[1];
    return {
      id: `kuji:${shopId ?? `${b.name}|${b.address}`}`,
      name: b.name,
      address: b.address,
      chain: Object.keys(CHAINS).find((k) => k !== 'other' && CHAINS[k].re.test(b.name)) ?? 'other',
      lat: pos ? Number(pos[1]) : null,
      lng: pos ? Number(pos[2]) : null,
      soldOut: b.soldOut,
    };
  });
}

// コピーしたページの HTML から、リンク先（店舗の番号・Googleマップの座標）を残した文字にする
function htmlToListText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('a[href]').forEach((a) => {
    // 1 つのリンクの中に店名と住所が別の要素で入っているときは、行を分けて残す
    a.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    a.querySelectorAll('p, div, li, dt, dd, h1, h2, h3, h4, h5, h6').forEach((el) => el.append('\n'));
    const href = a.getAttribute('href');
    const parts = a.textContent.split('\n').map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
    a.replaceWith(`\n${parts.map((t) => `[${t}](${href})`).join('\n')}\n`);
  });
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('li, p, div, tr, dt, dd, h1, h2, h3, h4').forEach((el) => el.append('\n'));
  return doc.body.textContent.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

// 住所検索に渡す形（全角の数字・ハイフンを半角に）
const normalizeAddress = (a) => a.normalize('NFKC').replace(/(\d)[‐－―−ー](?=\d)/g, '$1-');

async function importShopList(text) {
  const parsed = parseShopList(text);
  if (!parsed.length) {
    throw new Error('店舗を読み取れませんでした。公式の店舗検索の結果を、店名と住所が入るようにコピーして貼り付けてください');
  }
  const list = (db.kujiLists[campaignKey()] ||= { shops: [], importedAt: null });
  // 同じ店は、店舗の番号が同じか、店名と住所が同じもの（リンク付きと文字だけで貼ると番号の有無が変わるため）
  const keyOf = (s) => `${s.name.normalize('NFKC').replace(/\s+/g, '')}|${normalizeAddress(s.address).replace(/\s+/g, '')}`;
  const sameShop = (a, b) => a.id === b.id || keyOf(a) === keyOf(b);
  const fresh = [];
  for (const s of parsed) {
    const known = list.shops.find((k) => sameShop(k, s));
    if (known) {
      known.soldOut = s.soldOut; // 取り込み直したら、完売の表示を新しくする
      if (known.approx && s.lat != null) {
        // 住所から推定した位置を、リンクの座標で正確にする
        known.lat = s.lat;
        known.lng = s.lng;
        delete known.approx;
      }
    } else if (!fresh.some((f) => sameShop(f, s))) {
      fresh.push(s);
    }
  }

  // リンクの座標が無い店（文字だけで貼られたとき）は、住所から位置を調べる
  const missing = fresh.filter((s) => s.lat == null);
  const failed = [];
  try {
    for (const [i, s] of missing.entries()) {
      setBusy('import', `📍 住所から店の位置を調べています…（${i + 1}/${missing.length}）`);
      try {
        // 住所のあとの建物名や「※駐車場あり」などは、住所検索に渡さない
        const g = await geocode(normalizeAddress(s.address.split(/[\s　※（(]/)[0]));
        s.lat = g.lat;
        s.lng = g.lng;
        s.approx = true; // 住所の番地までは合わないことがあり、実際の店から数百m ずれることがある
      } catch (e) {
        console.warn(s.address, e);
        failed.push(s);
      }
    }
  } finally {
    setBusy('import', null);
  }

  const added = fresh.filter((s) => s.lat != null);
  list.shops.push(...added);
  list.importedAt = Date.now();
  if (!list.shops.length) delete db.kujiLists[campaignKey()];
  $('#kuji-paste').value = '';
  markRouteStale();
  save();
  renderAll();

  const dup = parsed.length - fresh.length;
  const summary = `「${campaignKey()}」の取扱店リストに ${added.length}店を取り込みました（合計 ${list.shops.length}店${dup ? `・取り込み済みの ${dup}店は省略` : ''}）`;
  if (failed.length) {
    notice(`${summary}\n\n住所から位置が分からなかった ${failed.length}店は取り込めませんでした：\n${failed.map((s) => `・${s.name}（${s.address}）`).join('\n')}`, { title: '一部の店を取り込めませんでした' });
  } else {
    toast(summary, 6000);
  }
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

// ===== 検索中・計算中 =====
// 画面全体を暗くして中央に理由を出す。店舗の検索（search）と計画の計算（plan）が重なることがあるので、
// 理由ごとに持ち、最後に始まったものを出す
const busyReasons = new Map();
function setBusy(key, message) {
  if (message) busyReasons.set(key, message);
  else busyReasons.delete(key);
  const latest = [...busyReasons.entries()].at(-1);
  $('#busy').hidden = !latest;
  if (latest) $('#busy-text').textContent = latest[1];
  $('#busy-cancel').hidden = latest?.[0] !== 'search'; // 店舗の検索のときだけ「中断」を出す
}

let searching = false;
let searchAbort = null; // 店舗の検索を「中断」で止めるための AbortController
function setSearching(on) {
  searching = on;
  searchAbort = on ? new AbortController() : null;
  setBusy('search', on ? '🔍 店舗を検索しています…' : null);
  for (const el of document.querySelectorAll('#radius, #btn-search, #btn-plan, #btn-locate, #btn-mapcenter, #addr-input, input[name=chain]')) el.disabled = on;
}

function blockedWhileSearching() {
  if (!searching) return false;
  toast('店舗を検索中です。終わるまでお待ちください');
  return true;
}

// ===== 操作 =====
// 店舗を検索した範囲が、いまの出発地と半径を覆っているか（半径を狭めただけなら検索し直さなくてよい）
function searchCovers() {
  if (activeKujiList()) return true; // 取扱店リストで回るときは、店舗検索は使わない
  const s = db.searched;
  if (!s || !db.start) return false;
  // 前に探した範囲の中に今の範囲が収まっていれば、探し直さなくてよい（出発地を少し動かしただけのときなど）
  return haversine(s, db.start) + db.settings.radius * 1000 <= s.radius * 1000 + 1;
}

// 回る候補の店。取扱店リストで回るときはリストの店、そうでなければ OpenStreetMap で検索した店
function visibleStores() {
  const source = activeKujiList()?.shops ?? db.stores;
  const inRange = (s) => !db.start || haversine(db.start, s) <= db.settings.radius * 1000;
  const stores = source.filter((s) => db.settings.chains.includes(s.chain) && inRange(s));
  if (db.start) stores.sort((a, b) => haversine(db.start, a) - haversine(db.start, b));
  return stores;
}

// 計画のあとに出発地・店舗・設定を変えても、計画は消さずに「古い」にする（回っている最中に一覧が消えないように）
function markRouteStale() {
  if (db.route) db.route.stale = true;
}

function setStart(point, { fit = true } = {}) {
  if (blockedWhileSearching()) return;
  db.start = point;
  markRouteStale();
  save();
  renderAll();
  if (fit) fitStart();
}

// quiet: 計画を作る途中で呼ぶときは、見つからなくても知らせを出さない（計画の方で知らせる）
async function searchStores({ quiet = false } = {}) {
  if (!db.start) throw new Error('先に「エリア」タブで出発地を決めてください');
  const area = { lat: db.start.lat, lng: db.start.lng, radius: db.settings.radius };
  setSearching(true);
  let found;
  try {
    found = await fetchStores(area, area.radius, searchAbort.signal);
  } finally {
    setSearching(false);
  }
  db.stores = found;
  db.searched = area;
  db.searchedAt = Date.now();
  markRouteStale();
  save();
  renderAll();
  if (quiet) return;
  fitStart();
  const n = visibleStores().length;
  if (n) {
    toast(`${n}店舗見つかりました`, 4000);
  } else {
    const kinds = db.settings.chains.map((k) => CHAINS[k].label).join('・') || '（種類が選ばれていません）';
    notice(`出発地から ${area.radius}km 以内に、${kinds} が見つかりませんでした。\n半径を広げるか、「設定」タブでコンビニの種類を増やしてください。`, { title: '店舗が見つかりませんでした', icon: '🔍' });
  }
}

async function computePlan(fromCurrent = false) {
  setBusy('plan', fromCurrent ? '📍 現在地から組み直しています…' : '🗓 道路の所要時間を調べて計画を作っています…');
  try {
    return await computePlanInner(fromCurrent);
  } finally {
    setBusy('plan', null);
  }
}

// fromCurrent: 巡回中に、現在地から今の時刻で残りの店を組み直す（記録済みの店は除く）
async function computePlanInner(fromCurrent) {
  if (!db.start) throw new Error('先に「エリア」タブで出発地を決めてください');
  if (!db.settings.chains.length) throw new Error('「設定」タブでコンビニの種類を選んでください');
  // 店舗を探していない範囲があれば、先に探す（組み直しは、計画を作ったときの店のまま）
  if (!fromCurrent && !searchCovers()) await searchStores({ quiet: true });

  const origin = fromCurrent ? { ...(await getPosition()), label: '現在地' } : db.start;
  const home = db.start;
  const records = currentRecords();
  const skip = fromCurrent || db.settings.skipRecorded;
  const targets = visibleStores().filter((s) => !s.soldOut && !db.excluded[s.id] && !(skip && records[s.id]?.status));
  if (!targets.length) {
    throw new Error(fromCurrent
      ? '残りの店はありません（計画の店はすべて記録済みです）'
      : activeKujiList()
        ? '取扱店リストの店が範囲内にありません（公式で完売の店は除いています）。「エリア」タブで出発地や半径を見直すか、「設定」タブで店の種類を増やしてください'
        : '回る店がありません。「エリア」タブで半径を広げるか、「設定」タブでコンビニの種類を増やしてください');
  }

  const { roundtrip, dwell } = db.settings;
  const extraHome = roundtrip && origin !== home; // 組み直しで出発地へ戻るときは、戻り先を別に足す
  const matrix = await buildMatrix([origin, ...targets, ...(extraHome ? [home] : [])]);
  if (extraHome) {
    // 「ノード 0 へ戻る」コストを、出発地（最後の列）への所要に差し替える
    for (const m of [matrix.duration, matrix.distance]) {
      for (const row of m) row[0] = row.pop();
      m.pop();
    }
  }

  const order = solveTsp(matrix.duration, targets.length, roundtrip);
  const nearestFirst = targets.map((s, i) => [haversine(origin, s), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  const savedSec = pathCost(matrix.duration, nearestFirst, roundtrip) - pathCost(matrix.duration, order, roundtrip);

  const nodes = [0, ...order.map((i) => i + 1), ...(roundtrip ? [0] : [])];
  const seq = nodes.map((node, k) => (node === 0 ? (k === 0 ? origin : home) : targets[node - 1]));
  const geometry = await fetchRouteGeometry(seq);
  const legs = geometry?.legs
    ?? nodes.slice(1).map((node, k) => ({ duration: matrix.duration[nodes[k]][node], distance: matrix.distance[nodes[k]][node] }));

  const place = (p) => ({ lat: p.lat, lng: p.lng, label: p.label });
  db.route = {
    start: place(origin),
    home: roundtrip ? place(home) : null,
    stops: order.map((i) => ({ ...targets[i] })),
    legs,
    coords: geometry?.coords ?? seq.map((p) => [p.lat, p.lng]),
    roundtrip,
    dwell,
    orderSource: matrix.source,
    savedSec: Math.max(0, savedSec),
    startTime: fromCurrent ? nowHHMM() : ($('#start-time').value || nowHHMM()),
    stale: false,
  };
  navOpenStore = null;
  save();
  renderAll();
  fitRoute();
  // 巡回タブへは自動で移らない。計画タブで回る店の一覧を見てから「次へ：巡回へ →」で進む
  const hint = db.ui.tab === 'plan' ? '。「次へ：巡回へ →」で回り始めます' : '';
  toast(`${targets.length}店舗の${fromCurrent ? '計画を組み直しました' : '計画を作りました'}${hint}`, 5000);
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
  renderReport();
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

const pinIcon = (color, text) => L.divIcon({
  className: 'pin-wrap',
  html: `<div class="pin" style="--c:${color}">${esc(text)}</div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -14],
});

// 店舗マーカー: チェーンのアイコン＋右上に回る順番（チェーンの色の丸。回り終えたら灰色）
const storeIcon = (chain, badge, { done = false, faded = false } = {}) => L.divIcon({
  className: 'pin-wrap',
  html: `<div class="store-pin${done ? ' done' : ''}${faded ? ' faded' : ''}">${CHAINS[chain].icon}${badge ? `<span class="pin-badge" style="--c:${CHAINS[chain].color}">${esc(badge)}</span>` : ''}</div>`,
  iconSize: [34, 34],
  iconAnchor: [17, 17],
  popupAnchor: [0, -17],
});

// 一覧の店の印。地図の店と同じ見た目にする
function storeMark(store, badge, { done = false } = {}) {
  return `<span class="store-mark${done ? ' done' : ''}">${CHAINS[store.chain].icon}${badge ? `<span class="pin-badge" style="--c:${CHAINS[store.chain].color}">${esc(badge)}</span>` : ''}</span>`;
}

function fitStart() {
  if (db.start) map.fitBounds(L.latLng(db.start.lat, db.start.lng).toBounds(db.settings.radius * 2000));
}

function fitRoute() {
  if (db.route) map.fitBounds(L.latLngBounds(db.route.coords), { padding: [30, 30] });
}

// 店を地図の中心に移して、マーカーを点滅させる（巡回の店の行・回る店の 🗺 を押したとき）
let blinkTimer;
function focusStore(id) {
  const marker = markers.get(id);
  if (!marker) return;
  map.setView(marker.getLatLng(), Math.max(map.getZoom(), 16));
  const el = marker.getElement();
  if (el) {
    el.classList.remove('blink');
    void el.offsetWidth; // 続けて押したときも点滅をやり直す
    el.classList.add('blink');
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => el.classList.remove('blink'), 2500);
  }
  // スマホの幅では地図が一覧の上にあるので、地図が見える位置まで戻す
  if (window.matchMedia('(max-width: 899px)').matches) $('#map').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function storePopup(s) {
  const excluded = !!db.excluded[s.id];
  const div = document.createElement('div');
  div.className = 'popup';
  div.innerHTML = `
    <b>${esc(s.name)}</b>
    <div class="muted small">${CHAINS[s.chain].label}${s.address ? `・${esc(s.address)}` : ''}</div>
    ${s.soldOut ? '<div class="small warn">公式の店舗検索で「完売」</div>' : ''}
    ${s.approx ? '<div class="small muted">位置は住所からの推定です（数百m ずれることがあります）</div>' : ''}
    <div class="row">
      <a class="btn small primary" href="${esc(navUrl(s))}" target="_blank" rel="noopener">ナビ</a>
      <button class="btn small" type="button">${excluded ? '計画に含める' : '計画から外す'}</button>
    </div>`;
  div.querySelector('button').onclick = () => {
    map.closePopup();
    toggleExcluded(s.id);
  };
  return div;
}

map.on('click', (e) => {
  const { lat, lng } = e.latlng;
  const div = document.createElement('div');
  div.className = 'popup';
  div.innerHTML = '<button class="btn small primary block" type="button">🏠 ここを出発地にする</button>';
  div.querySelector('button').onclick = () => {
    map.closePopup();
    setStart({ lat, lng, label: '地図で指定した地点', source: 'tap' }, { fit: false });
  };

  L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
});

// ===== 描画 =====
function renderAll() {
  renderStart();
  renderSearchHint();
  renderStores();
  renderRoute();
  renderPlanConditions();
  renderRecordSummary();
  renderKujiList();
  renderReport();
}

function renderStart() {
  layers.start.clearLayers();
  const st = db.start;
  const label = st?.source === 'map' ? '🗺 地図の中心（「エリア」タブで地図を動かすと、出発地と範囲も動きます）' : st?.label;
  $('#start-label').textContent = st ? `出発地：${label}` : '出発地：未設定（上のボタン・住所で決めるか、地図をタップしてください）';
  // 出発地の決め方は選択式。選んでいる方のボタンの色を変える
  $('#btn-locate').setAttribute('aria-pressed', String(st?.source === 'gps'));
  $('#btn-mapcenter').setAttribute('aria-pressed', String(st?.source === 'map'));
  $('#tab-badge-settings').textContent = `${db.settings.chains.length}種類`;
  if (!st) return;
  L.circle([st.lat, st.lng], {
    radius: db.settings.radius * 1000, color: '#0068b7', weight: 1, fillOpacity: 0.04, interactive: false,
  }).addTo(layers.start);
  L.marker([st.lat, st.lng], { icon: pinIcon('#c2255c', '🏠'), zIndexOffset: 1000 })
    .bindPopup(`出発地<br>${esc(st.label)}`)
    .addTo(layers.start);
}

// 出発地や半径を変えたあと、店舗を検索し直す必要があるかを半径スライダーのすぐ下に出す
function renderSearchHint() {
  const list = activeKujiList();
  const covers = searchCovers();
  const stores = visibleStores();
  let html = '';
  let quiet = true;
  if (list) {
    const all = list.shops.filter((s) => db.settings.chains.includes(s.chain)).length;
    html = `📋 「${esc(campaignKey())}」の取扱店リストの店を回ります（店舗検索は使いません）：範囲内 ${stores.length}店`
      + (all > stores.length ? `<br>範囲外に ${all - stores.length}店あります。出発地や半径を変えると入ります` : '');
  } else if (!db.start) {
    html = '';
  } else if (covers) {
    const counts = Object.entries(CHAINS)
      .map(([k, c]) => [c.label, stores.filter((s) => s.chain === k).length])
      .filter(([, n]) => n);
    html = stores.length
      ? `✔ 範囲内に ${stores.length}店（${counts.map(([label, n]) => `${label} ${n}`).join('・')}）`
      : '範囲内に店がありません。半径を広げるか、「設定」タブでコンビニの種類を増やしてください';
    if (db.searched.radius > db.settings.radius) html += '<br>半径を狭めたので、範囲外の店は外しています（検索し直す必要はありません）';
  } else if (db.searchedAt) {
    html = `<span>⚠ 出発地か半径を変えたので、店舗を検索し直してください</span>
      <button class="btn small primary" type="button" data-action="search">🔍 検索し直す</button>`;
    quiet = false;
  } else {
    html = 'まだ店舗を検索していません。「計画を作る」を押すと、先に自動で検索します';
  }
  const hint = $('#store-hint');
  hint.innerHTML = html;
  hint.classList.toggle('quiet', quiet);
  $('#btn-search').hidden = !!list;
  $('#tab-badge-search').textContent = covers ? `${stores.length}店` : db.start ? `${db.settings.radius}km` : '';
}

function renderStores() {
  layers.stores.clearLayers();
  markers.clear();
  const r = db.route;
  const stores = visibleStores();
  const records = currentRecords();
  const planNo = new Map((r?.stops ?? []).map((s, i) => [s.id, i + 1]));
  $('#store-count').textContent = stores.length ? `${stores.filter((s) => !db.excluded[s.id]).length} / ${stores.length}` : '';

  // 計画の店は、出発地を変えて範囲から外れても、巡回中に見えるように地図に残す
  const shown = new Set(stores.map((s) => s.id));
  const onMap = [...stores, ...(r?.stops ?? []).filter((s) => !shown.has(s.id))];
  for (const s of onMap) {
    const done = !!records[s.id]?.status;
    const marker = L.marker([s.lat, s.lng], {
      // 番号は巡回の一覧と同じ。計画に無い記録済みの店だけ ✓
      icon: storeIcon(s.chain, planNo.get(s.id) ?? (done ? '✓' : ''), { done, faded: !!db.excluded[s.id] }),
    }).bindPopup(() => storePopup(s)).addTo(layers.stores);
    markers.set(s.id, marker);
  }

  // 回る順番に並べ、計画に入らない店は後ろに近い順
  const byPlanOrder = (a, b) => (planNo.get(a.id) ?? 1e9) - (planNo.get(b.id) ?? 1e9);
  $('#store-list').innerHTML = !stores.length ? '<li class="empty">範囲内に店がありません</li>' : [...stores].sort(byPlanOrder).map((s) => {
    const excluded = !!db.excluded[s.id];
    const st = STATUSES[records[s.id]?.status];
    const no = excluded ? null : planNo.get(s.id);
    const planTag = !r || r.stale || excluded || no || st || s.soldOut ? '' : '<span class="tag muted">計画外</span>';
    return `
      <li class="store${excluded ? ' off' : ''}" data-id="${esc(s.id)}">
        <label class="store-main">
          <input type="checkbox" data-action="toggle"${excluded ? '' : ' checked'}>
          ${storeMark(s, no, { done: !!st })}
          <span class="store-name">${esc(s.name)}</span>
        </label>
        ${planTag}
        ${s.soldOut ? '<span class="tag ng">完売（公式）</span>' : ''}
        ${st ? `<span class="tag ${st.tone === 'ok' ? 'ok' : 'ng'}">${st.icon}${st.label}</span>` : ''}
        <span class="muted small">${db.start ? fmtDist(haversine(db.start, s)) : ''}</span>
        <button class="icon-btn" type="button" data-action="focus" title="地図で見る">🗺</button>
      </li>`;
  }).join('');
}

// 出発時刻・滞在から、各店の到着時刻と合計を出す
function routeTimes(r) {
  const dwellSec = (r.dwell ?? db.settings.dwell) * 60;
  const [hh, mm] = (r.startTime || nowHHMM()).split(':').map(Number);
  const departAt = new Date();
  departAt.setHours(hh, mm, 0, 0);
  let elapsed = 0;
  let drive = 0;
  let dist = 0;
  const arrivals = r.stops.map((_, i) => {
    elapsed += r.legs[i].duration;
    drive += r.legs[i].duration;
    dist += r.legs[i].distance;
    const arrive = new Date(departAt.getTime() + elapsed * 1000);
    elapsed += dwellSec;
    return arrive;
  });
  const back = r.roundtrip ? r.legs[r.stops.length] : null;
  if (back) {
    elapsed += back.duration;
    drive += back.duration;
    dist += back.distance;
  }
  return { departAt, arrivals, back, drive, dist, elapsed, endAt: new Date(departAt.getTime() + elapsed * 1000) };
}

// 巡回で記録のボタンを開いている店。null なら次に回る店、'' なら開かない
let navOpenStore = null;
let navOpenShown = null;

function renderRoute() {
  layers.route.clearLayers();
  const r = db.route;
  $('#nav-empty').hidden = !!r;
  $('#nav-body').hidden = !r;
  // 計画タブの回る店の一覧と「次へ：巡回へ →」は、計画を作ってから出す
  $('#plan-empty').hidden = !!r;
  $('#plan-result').hidden = !r;
  $('#btn-goto-nav').disabled = !r;
  $('#nav-card').classList.toggle('stale', !!r?.stale);
  if (!r) {
    for (const id of ['#plan-summary', '#plan-stale', '#plan-list', '#gmaps-links']) $(id).innerHTML = '';
    for (const id of ['#progress', '#tab-badge-plan', '#tab-badge-nav']) $(id).textContent = '';
    return;
  }

  L.polyline(r.coords, { color: '#c2255c', weight: 5, opacity: 0.75, interactive: false }).addTo(layers.route);

  const t = routeTimes(r);
  const records = currentRecords();
  const home = r.home ?? r.start;
  $('#tab-badge-plan').textContent = r.stale ? '⚠ 古い' : `${fmtClock(t.endAt)}${r.roundtrip ? '帰着' : '終了'}`;

  const summaryBody = `
    <div class="summary">
      <div><span class="big">${r.stops.length}</span><span class="label">店舗</span></div>
      <div><span class="big">${fmtDur(t.drive)}</span><span class="label">運転時間</span></div>
      <div><span class="big">${fmtClock(t.endAt)}</span><span class="label">${r.roundtrip ? '帰着' : '終了'}</span></div>
    </div>
    <p class="small">${fmtClock(t.departAt)} ${esc(r.start.label)}から ・ 走行 ${fmtDist(t.dist)} ・ 滞在込みで約${fmtDur(t.elapsed)}</p>
    ${r.savedSec >= 60 ? `<p class="small ok">近い店から順に回るより約${fmtDur(r.savedSec)}短縮</p>` : ''}
    ${r.orderSource === 'straight' ? '<p class="small warn">道路データを取得できなかったため、直線距離をもとに順番を決めました</p>' : ''}`;
  // 古い計画の数字を、いまの計画のように並べない。一番上に作り直すよう出し、前の数字は畳んでおく
  $('#plan-stale').innerHTML = r.stale
    ? '<div class="stale-banner"><div>⚠ この計画は古くなっています。作ったあとに出発地・店舗・設定が変わりました。「計画を作る」で作り直してください。</div></div>'
    : '';
  $('#plan-summary').innerHTML = r.stale
    ? `<details class="old-plan"><summary class="small">前に作った計画を見る（古い）</summary>${summaryBody}</details>`
    : summaryBody;

  // 回っている最中に予定が勝手に変わると混乱するので、自動では組み直さない
  const banner = $('#stale-banner');
  banner.hidden = !r.stale;
  if (r.stale) {
    banner.innerHTML = `
      <div>⚠ 計画を作ったあとに出発地・店舗・設定が変わったため、この計画は古いままです。</div>
      <button class="btn primary block" type="button" data-action="replan">🔄 現在地から今の時刻で組み直す（記録済みの店を除く）</button>`;
  }

  const doneCount = r.stops.filter((s) => records[s.id]?.status).length;
  $('#progress').textContent = `${doneCount} / ${r.stops.length} 完了`;
  $('#tab-badge-nav').textContent = `${doneCount}/${r.stops.length}`;

  const nextIndex = r.stops.findIndex((s) => !records[s.id]?.status);
  const next = r.stops[nextIndex];
  const nextTarget = next ?? (r.roundtrip ? home : null);
  const btnNext = $('#btn-next');
  btnNext.textContent = next
    ? `▶ 次へ：${next.name}（${fmtClock(t.arrivals[nextIndex])}着の予定）`
    : r.roundtrip ? '🏠 出発地へ戻る' : '🎉 全店舗まわりました';
  btnNext.classList.toggle('disabled', !nextTarget);
  if (nextTarget) btnNext.href = navUrl(nextTarget);
  else btnNext.removeAttribute('href');

  // 店の行は 1 行にまとめ、記録のボタンとメモは「次に回る店」か「記録 ▾」で開いた店だけに出す
  navOpenShown = navOpenStore ?? next?.id ?? null;
  const startRow = `
    <li class="tl-station">
      <span class="num square" style="--c:var(--accent)">🚩</span>
      <div class="stop-info">
        <div class="store-name">${esc(r.start.label)}</div>
        <div class="muted small">${fmtClock(t.departAt)} 出発</div>
      </div>
    </li>`;
  const storeRows = r.stops.map((s, i) => {
    const rec = records[s.id];
    const st = STATUSES[rec?.status];
    const open = s.id === navOpenShown;
    const leg = r.legs[i];
    return `
      <li class="stop${rec?.status ? ' done' : ''}${open ? ' open' : ''}" data-id="${esc(s.id)}">
        <div class="stop-head">
          ${storeMark(s, i + 1, { done: !!rec?.status })}
          <div class="stop-info">
            <div class="store-name">${esc(s.name)}</div>
            <div class="stop-sub muted small">🚗${fmtDur(leg.duration)}・${fmtDist(leg.distance)} → <b>${fmtClock(t.arrivals[i])}</b>着${st ? ` <span class="tag ${st.tone === 'ok' ? 'ok' : 'ng'}">${st.icon}${st.label}</span>` : ''}${rec?.note ? ` 📝${esc(rec.note)}` : ''}</div>
          </div>
          ${rec?.status ? '' : `<a class="btn small primary" href="${esc(navUrl(s))}" target="_blank" rel="noopener">ナビ</a>`}
          <button class="btn small ghost" type="button" data-action="toggle-store" aria-expanded="${open}">記録 ${open ? '▴' : '▾'}</button>
        </div>
        ${open ? `
        <div class="stop-detail">
          <div class="status-row">
            ${Object.entries(STATUSES).map(([key, s2]) => `<button type="button" class="chip${rec?.status === key ? ` on ${s2.tone}` : ''}" data-action="status" data-status="${key}">${s2.icon} ${s2.label}</button>`).join('')}
          </div>
          <input class="note" type="text" data-action="note" placeholder="メモ（残り枚数・購入数など）" value="${esc(rec?.note)}">
        </div>` : ''}
      </li>`;
  }).join('');
  const endRow = t.back ? `
    <li class="tl-station">
      <span class="num square" style="--c:var(--accent)">🏠</span>
      <div class="stop-info">
        <div class="store-name">出発地に戻る</div>
        <div class="muted small">🚗${fmtDur(t.back.duration)}・${fmtDist(t.back.distance)} → <b>${fmtClock(t.endAt)}</b>着</div>
      </div>
      <a class="btn small" href="${esc(navUrl(home))}" target="_blank" rel="noopener">ナビ</a>
    </li>` : `
    <li class="tl-station">
      <span class="num square" style="--c:#495057">🏁</span>
      <div class="stop-info">
        <div class="store-name">終了</div>
        <div class="muted small">${fmtClock(t.endAt)}（最後の店を出る時刻）</div>
      </div>
    </li>`;
  $('#plan-list').innerHTML = startRow + storeRows + endRow;

  const links = gmapsChunkLinks(r, records);
  $('#gmaps-links').innerHTML = links.length
    ? `<p class="small muted">残りのルートをGoogleマップでまとめて開く（1リンクあたり経由地${GMAPS_MAX_WAYPOINTS}か所まで）</p>`
      + links.map((l, i) => `<a class="btn block" href="${esc(l.url)}" target="_blank" rel="noopener">🗺 ${links.length > 1 ? `パート${i + 1}：` : ''}${esc(l.from)} → ${esc(l.to)}（${l.count}か所）</a>`).join('')
    : '';
}

// 未訪問の店舗を、Googleマップの経由地上限ごとに分割したリンクにする
function gmapsChunkLinks(r, records) {
  const home = r.home ?? r.start;
  const points = [
    ...r.stops.filter((s) => !records[s.id]?.status),
    ...(r.roundtrip ? [{ ...home, name: '出発地' }] : []),
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

// 計画タブの上に、設定タブで決めた条件を出す（設定を別のタブに分けたので、何で計画するかを見えるようにする）
function renderPlanConditions() {
  const s = db.settings;
  const kinds = s.chains.map((k) => CHAINS[k].label).join('・') || '（コンビニの種類が選ばれていません）';
  $('#plan-conditions').innerHTML = [
    s.campaign ? `🎯 ${esc(s.campaign)}` : '',
    `🕒 ${esc($('#start-time').value || nowHHMM())} 出発・${db.start ? `${esc(db.start.label)}から半径 ${s.radius}km` : '出発地は未設定'}`,
    `🏪 ${esc(kinds)}`,
    activeKujiList() ? `📋 取扱店リスト（${activeKujiList().shops.length}店）の店だけを回る` : '',
    `滞在 ${s.dwell}分${s.roundtrip ? '・出発地へ戻る' : ''}${s.skipRecorded ? '・記録済みの店を除く' : ''}`,
  ].filter(Boolean).map((line) => `<span>${line}</span>`).join('');
}

function renderKujiList() {
  const list = currentKujiList();
  const shops = list?.shops ?? [];
  const counts = Object.entries(CHAINS)
    .map(([k, c]) => [c.label, shops.filter((s) => s.chain === k).length])
    .filter(([, n]) => n)
    .map(([label, n]) => `${label} ${n}`)
    .join('・');
  const soldOut = shops.filter((s) => s.soldOut).length;
  $('#kuji-status').innerHTML = shops.length
    ? `📋 「${esc(campaignKey())}」の取扱店リスト：<b>${shops.length}店</b>（${esc(counts)}${soldOut ? `・うち完売 ${soldOut}店` : ''}）<br><span class="muted">${reportClock(list.importedAt)} に取り込み</span>`
    : `「${esc(campaignKey())}」の取扱店リストはまだありません。無いときは、OpenStreetMap で検索したコンビニを回ります。`;
  $('#btn-kuji-clear').hidden = !shops.length;
}

function renderRecordSummary() {
  const recs = Object.values(currentRecords()).filter((r) => r.status);
  $('#record-summary').textContent = recs.length
    ? `このくじのこれまでの記録：${Object.entries(STATUSES).map(([k, st]) => `${st.icon}${st.label} ${recs.filter((r) => r.status === k).length}`).join('　')}`
    : '';
}

// ===== 実績を送る =====
// 記録を文章にして、メールアプリ・共有メニュー・コピーで送る（サイトから自動でメールは送らない）
function reportClock(at) {
  const d = new Date(at);
  const hm = fmtClock(d);
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function buildReport() {
  const campaign = campaignKey();
  const records = currentRecords();
  const recorded = Object.entries(records).filter(([, r]) => r.status || r.note);
  const counts = Object.entries(STATUSES).map(([k, st]) => `${st.icon}${st.label} ${recorded.filter(([, r]) => r.status === k).length}`);
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${fmtClock(now)}`;

  const byId = new Map([...db.stores, ...(currentKujiList()?.shops ?? []), ...(db.route?.stops ?? [])].map((s) => [s.id, s]));
  const line = (id, r) => {
    const st = STATUSES[r.status];
    return `・${st ? `${st.icon} ${st.label}` : '📝 メモ'}　${byId.get(id)?.name ?? '（名前不明の店）'}${r.at ? `（${reportClock(r.at)}）` : ''}${r.note ? `　メモ: ${r.note}` : ''}`;
  };
  const planIds = (db.route?.stops ?? []).map((s) => s.id);
  const inPlan = planIds.filter((id) => records[id]?.status || records[id]?.note).map((id) => line(id, records[id]));
  const others = recorded.filter(([id]) => !planIds.includes(id)).map(([id, r]) => line(id, r));
  const sections = [
    inPlan.length ? `■ 計画の店（回る順）\n${inPlan.join('\n')}` : '',
    others.length ? `■ 計画にない店\n${others.join('\n')}` : '',
  ].filter(Boolean);

  const subject = `【コンビニ巡回】${campaign} の記録（${stamp}）`;
  const body = [
    `くじ・グッズ: ${campaign}`,
    `記録: ${counts.join(' ／ ')}`,
    '',
    sections.length ? sections.join('\n\n') : '（まだ記録はありません）',
    '',
    `— コンビニ巡回ルート ${APP_URL}`,
  ].join('\n');
  return { subject, body, count: recorded.length };
}

function mailtoUrl(to, { subject, body }) {
  const text = body.length > MAILTO_MAX ? `${body.slice(0, MAILTO_MAX)}\n…（長いので途中まで。全文は「コピー」で貼り付けてください）` : body;
  return `mailto:${encodeURIComponent(to.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

async function copyReport({ subject, body }) {
  const text = `${subject}\n\n${body}`;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // http の手元確認や古いブラウザでは clipboard API が使えないので、選択してコピーする
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('コピーできませんでした');
  }
}

function renderReport() {
  const report = buildReport();
  $('#report-count').textContent = report.count ? `記録 ${report.count}件` : 'まだ記録がありません';
  const mail = $('#btn-report-mail');
  mail.href = mailtoUrl(db.settings.reportTo, report);
  mail.classList.toggle('disabled', !report.count);
  $('#btn-report-share').hidden = typeof navigator.share !== 'function';
  $('#report-preview').textContent = `${report.subject}\n\n${report.body}`;
}

function syncControls() {
  const s = db.settings;
  $('#radius').value = s.radius;
  $('#radius-out').textContent = s.radius;
  document.querySelectorAll('input[name=chain]').forEach((el) => { el.checked = s.chains.includes(el.value); });
  $('#dwell').value = s.dwell;
  $('#roundtrip').checked = s.roundtrip;
  $('#skip-recorded').checked = s.skipRecorded;
  $('#use-kuji-list').checked = s.useKujiList;
  $('#campaign').value = s.campaign;
  $('#report-to').value = s.reportTo;
  $('#start-time').value = nowHHMM();
}

// ===== タブ =====
// カードを 1 枚ずつ出し、設定 → エリア → 計画 → 巡回 と左から右へ進む段階として見せる
let startTimeTouched = false; // 出発時刻を利用者が変えたか。変えていなければ、タブを開くたびに今に合わせる

function setTab(name) {
  const tab = TABS.includes(name) ? name : 'settings';
  db.ui.tab = tab;
  save();
  const current = TABS.indexOf(tab);
  document.querySelectorAll('.tab').forEach((b) => {
    const i = TABS.indexOf(b.dataset.tab);
    b.setAttribute('aria-selected', String(i === current));
    b.dataset.state = i < current ? 'past' : i === current ? 'current' : 'future';
    if (i === current) b.setAttribute('aria-current', 'step');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.panel > [data-panel]').forEach((s) => s.classList.toggle('active', s.dataset.panel === tab));
  if ((tab === 'settings' || tab === 'plan') && !startTimeTouched) $('#start-time').value = nowHHMM();
  if (tab === 'plan') renderPlanConditions();
  // 切り替えた画面の先頭が見えるように戻す（PC はパネルだけがスクロールし、スマホは画面全体がスクロールする）
  const panel = $('.panel');
  if (getComputedStyle(panel).overflowY === 'auto') {
    panel.scrollTop = 0;
  } else {
    const top = panel.getBoundingClientRect().top + window.scrollY;
    if (window.scrollY > top) window.scrollTo({ top });
  }
}

// ===== 全部クリア =====
// 出発地・見つけた店・計画・外した店をまとめて消す。設定・くじの記録・取扱店リストは、確認のチェックを入れたときだけ消す
function openClearAll() {
  if (blockedWhileSearching()) return;
  $('#clear-everything').checked = false;
  $('#clear-ok').textContent = 'クリアする';
  $('#confirm').hidden = false;
  $('#clear-cancel').focus();
}

function closeClearAll() {
  $('#confirm').hidden = true;
}

function clearAll(everything) {
  const keep = everything ? {} : { settings: db.settings, records: db.records, kujiLists: db.kujiLists };
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, structuredClone(DEFAULTS), keep);
  startTimeTouched = false;
  navOpenStore = null;
  $('#addr-input').value = '';
  save();
  syncControls();
  renderAll();
  setTab('settings');
  toast(everything ? '最初の状態に戻しました' : '出発地・計画・見つけた店をクリアしました（設定と記録は残しています）', 5000);
}

// ===== イベント =====
$('.tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) setTab(btn.dataset.tab);
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-goto]');
  if (btn) setTab(btn.dataset.goto);
});

$('#busy-cancel').addEventListener('click', () => searchAbort?.abort());

// 設定タブ
$('#campaign').addEventListener('change', (e) => {
  db.settings.campaign = e.target.value;
  save();
  renderAll();
});

document.querySelectorAll('input[name=chain]').forEach((el) => el.addEventListener('change', () => {
  db.settings.chains = [...document.querySelectorAll('input[name=chain]:checked')].map((c) => c.value);
  markRouteStale();
  save();
  renderAll();
}));

$('#start-time').addEventListener('change', () => {
  startTimeTouched = true;
  markRouteStale();
  save();
  renderAll();
});

$('#dwell').addEventListener('input', (e) => {
  db.settings.dwell = Math.min(60, Math.max(0, Number(e.target.value) || 0));
  markRouteStale();
  save();
  renderAll();
});

$('#roundtrip').addEventListener('change', (e) => {
  db.settings.roundtrip = e.target.checked;
  markRouteStale();
  save();
  renderAll();
});

// 取扱店リスト: リンク付きで貼られたら、リンク先（店舗の番号・Googleマップの座標）を残して取り込む
$('#kuji-paste').addEventListener('paste', (e) => {
  const html = e.clipboardData?.getData('text/html');
  if (!html || !/<a\s/i.test(html)) return;
  e.preventDefault();
  const el = e.currentTarget;
  el.setRangeText(htmlToListText(html), el.selectionStart, el.selectionEnd, 'end');
});

$('#btn-kuji-import').addEventListener('click', (e) => withBusy(e.currentTarget, '取り込み中…', () => importShopList($('#kuji-paste').value)));

$('#btn-kuji-clear').addEventListener('click', () => {
  if (!confirm(`「${campaignKey()}」の取扱店リストを消しますか？（くじの記録は残ります）`)) return;
  delete db.kujiLists[campaignKey()];
  markRouteStale();
  save();
  renderAll();
});

$('#use-kuji-list').addEventListener('change', (e) => {
  db.settings.useKujiList = e.target.checked;
  markRouteStale();
  save();
  renderAll();
});

$('#skip-recorded').addEventListener('change', (e) => {
  db.settings.skipRecorded = e.target.checked;
  save();
  renderPlanConditions();
});

// エリアタブ
$('#btn-locate').addEventListener('click', (e) => withBusy(e.currentTarget, '📍 取得中…', async () => {
  const pos = await getPosition();
  setStart({ lat: pos.lat, lng: pos.lng, label: '現在地', source: 'gps' });
  toast(`現在地を出発地にしました${pos.accuracy ? `（誤差 約${Math.round(pos.accuracy)}m）` : ''}`);
}));

// 「地図の中心」は選択式（ConveniRadar のエリア検索と同じ）。選んでいる間は、エリアタブで地図を動かすと出発地も動く。
// 以前は押した瞬間の中心で止まり、地図を動かしても出発地が付いてこないので「機能していない」ように見えた（2026-09-15）
$('#btn-mapcenter').addEventListener('click', () => {
  const c = map.getCenter();
  // 範囲の円が見える大きさまで拡大・縮小する（中心は変わらない）。日本全体の表示のままだと、円が小さすぎて何も起きないように見える
  setStart({ lat: c.lat, lng: c.lng, label: '地図の中心', source: 'map' });
  toast('地図の中心を出発地にしました。地図を動かすと、出発地と範囲も一緒に動きます', 5000);
});

map.on('moveend', () => {
  const st = db.start;
  if (st?.source !== 'map' || db.ui.tab !== 'search' || searching) return;
  const c = map.getCenter();
  if (Math.abs(st.lat - c.lat) < 1e-6 && Math.abs(st.lng - c.lng) < 1e-6) return;
  db.start = { lat: c.lat, lng: c.lng, label: '地図の中心', source: 'map' };
  markRouteStale();
  save();
  renderAll();
});

$('#addr-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#addr-input').value.trim();
  if (!q) return;
  withBusy(e.currentTarget.querySelector('button'), '…', async () => setStart({ ...(await geocode(q)), source: 'address' }));
});

$('#radius').addEventListener('input', (e) => {
  db.settings.radius = Number(e.target.value);
  $('#radius-out').textContent = db.settings.radius;
  markRouteStale();
  save();
  renderAll();
  // 範囲の円がちょうど収まるように、地図も拡大・縮小する（中心は変わらないので、地図の中心を選んでいても出発地は動かない）
  if (db.start) map.fitBounds(L.latLng(db.start.lat, db.start.lng).toBounds(db.settings.radius * 2000), { animate: false });
});

$('#btn-search').addEventListener('click', (e) => withBusy(e.currentTarget, '検索中…', () => searchStores()));

$('#store-hint').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action=search]');
  if (btn) withBusy(btn, '検索中…', () => searchStores());
});

// 計画タブ
$('#btn-plan').addEventListener('click', (e) => withBusy(e.currentTarget, '計画中…', () => computePlan(false)));

$('#store-list').addEventListener('change', (e) => {
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (id && e.target.dataset.action === 'toggle') toggleExcluded(id);
});

$('#store-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  const id = btn?.closest('[data-id]')?.dataset.id;
  if (id && btn.dataset.action === 'focus') focusStore(id);
});

// 巡回タブ
$('#plan-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) {
    // 店の行（ボタン・メモ・ナビ以外）を押したら、地図でその店を示す
    const row = e.target.closest('.stop[data-id]');
    if (row && !e.target.closest('a, input, button')) focusStore(row.dataset.id);
    return;
  }
  const id = btn.closest('[data-id]')?.dataset.id;
  if (!id) return;
  if (btn.dataset.action === 'status') {
    navOpenStore = null; // 記録したら、次に回る店の記録を開く
    setStatus(id, btn.dataset.status);
  } else if (btn.dataset.action === 'toggle-store') {
    navOpenStore = id === navOpenShown ? '' : id;
    renderRoute();
  }
});

$('#plan-list').addEventListener('change', (e) => {
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (id && e.target.dataset.action === 'note') setNote(id, e.target.value);
});

$('#stale-banner').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action=replan]');
  if (btn) withBusy(btn, '確認中…', () => computePlan(true));
});

$('#btn-reroute').addEventListener('click', (e) => withBusy(e.currentTarget, '確認中…', () => computePlan(true)));

$('#btn-reset-records').addEventListener('click', () => {
  if (!confirm(`「${campaignKey()}」の記録をすべて消去しますか？`)) return;
  delete db.records[campaignKey()];
  save();
  renderAll();
});

// 実績を送る（宛先はこの端末の localStorage にだけ保存する）
$('#report-to').addEventListener('change', (e) => {
  db.settings.reportTo = e.target.value.trim();
  save();
  renderReport();
});

$('#btn-report-mail').addEventListener('click', (e) => {
  if (!buildReport().count) {
    e.preventDefault();
    toast('まだ記録がありません');
  }
});

$('#btn-report-share').addEventListener('click', (e) => withBusy(e.currentTarget, '共有中…', async () => {
  const { subject, body } = buildReport();
  try {
    await navigator.share({ title: subject, text: `${subject}\n\n${body}` });
  } catch (err) {
    if (err.name !== 'AbortError') throw err; // 共有メニューを閉じただけなら何もしない
  }
}));

$('#btn-report-copy').addEventListener('click', (e) => withBusy(e.currentTarget, 'コピー中…', async () => {
  await copyReport(buildReport());
  toast('記録をコピーしました。メールや LINE に貼り付けて送れます');
}));

// 全部クリア
$('#btn-clear-all').addEventListener('click', openClearAll);
$('#clear-cancel').addEventListener('click', closeClearAll);
$('#clear-everything').addEventListener('change', (e) => {
  $('#clear-ok').textContent = e.target.checked ? 'すべて消す' : 'クリアする';
});
$('#clear-ok').addEventListener('click', () => {
  const everything = $('#clear-everything').checked;
  closeClearAll();
  clearAll(everything);
});
$('#confirm').addEventListener('click', (e) => { if (e.target.id === 'confirm') closeClearAll(); });

// 見つからない・失敗したときの知らせ（画面中央）を閉じる: OK・暗い所を押す・Esc
$('#notice-ok').addEventListener('click', closeNotice);
$('#notice').addEventListener('click', (e) => { if (e.target.id === 'notice') closeNotice(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#notice').hidden) closeNotice();
  else if (!$('#confirm').hidden) closeClearAll();
});

// ===== 起動 =====
document.querySelectorAll('.chain-icon[data-chain]').forEach((el) => { el.innerHTML = CHAINS[el.dataset.chain].icon; });
syncControls();
renderAll();
setTab(db.ui.tab);
if (db.route) fitRoute();
else fitStart();
