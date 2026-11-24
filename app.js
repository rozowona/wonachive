/* wonachive — 개인용 장소 아카이브 (정적 웹)
 *
 * 데이터를 어디서 읽고 쓰나
 *  - config.js(또는 ⋯ → 설정)에 구글 Apps Script URL이 있으면: 구글 시트에서 읽고, 바꾸면 바로 시트에 저장
 *    (보내지 못한 변경은 브라우저에 "저장 대기"로 남았다가 다시 보냄)
 *  - URL이 없으면: places.json을 읽고, 변경은 브라우저에 저장 → JSON 내보내기로 반영
 *
 * 그 밖의 기능
 *  - 카카오 장소 검색: 장소명만 넣으면 주소·좌표·카카오맵 링크·카테고리 자동 입력 (카카오 JavaScript 키 필요)
 *  - 가까운 순: 내 위치 기준 거리 표시·정렬
 *  - 방문 기록: 방문 날짜·별점·한 줄 후기
 */

const DATA_URL = 'places.json';
const STORAGE_KEY = 'place-archive:v1';          // 아직 반영 안 된 변경 (예전 버전과 같은 키 유지)
const BASE_CACHE_KEY = 'place-archive:base-cache'; // 파일 더블클릭 시 골랐던 places.json
const SHEET_CACHE_KEY = 'wonachive:sheet-cache';   // 시트를 못 읽을 때 보여 줄 마지막 내용
const SETTINGS_KEY = 'wonachive:settings';
const REGIONS = ['서울', '경기', '부산', '제주', '경주', '강릉'];
const CATEGORIES = ['카페', '밥집', '전시/문화', '도서관/작업', '데이트', '공방'];
const DEFAULT_CENTER = [36.5, 127.8]; // 대한민국 전체
const COLORS = { todo: '#30AFFF', done: '#3FB866' };
const CONFIG = window.WONACHIVE_CONFIG || {};

const state = {
  mode: 'file',        // 'file' (places.json) | 'sheet' (구글 시트)
  base: [],            // 원본 데이터 (places.json 또는 시트)
  local: loadLocal(),  // 아직 원본에 반영 안 된 변경 { items: {id: place}, deleted: [id] }
  places: [],          // 원본 + 변경 합친 결과
  filters: { q: '', region: '전체', category: '전체', visited: 'all' },
  sort: 'recent',
  view: 'list',
  editingId: null,
  visitingId: null,
  userPos: null,
  syncing: false,
};

let map = null;
let markerLayer = null;
let userMarker = null;
const markers = new Map();

const $ = (sel) => document.querySelector(sel);

/* ======================================================================
 * 설정
 * ==================================================================== */
function getSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { toast('설정을 저장하지 못했어요.'); }
}
function kakaoKey() { return (getSettings().kakaoKey || CONFIG.KAKAO_JS_KEY || '').trim(); }
function sheetUrl() { return (getSettings().sheetUrl || CONFIG.SHEET_API_URL || '').trim(); }
function sheetToken() { return (getSettings().token || '').trim(); }

/* ======================================================================
 * 브라우저 저장 (변경분)
 * ==================================================================== */
function loadLocal() {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (v && typeof v.items === 'object') return { items: v.items || {}, deleted: v.deleted || [] };
  } catch (e) { /* 저장소 사용 불가 */ }
  return { items: {}, deleted: [] };
}

function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.local));
  } catch (e) {
    toast('브라우저 저장에 실패했어요. JSON 내보내기로 백업해 주세요.');
  }
  updateStatusUI();
}

function localChangeCount() {
  return Object.keys(state.local.items).length + state.local.deleted.length;
}

/* ======================================================================
 * 데이터 모양 맞추기
 * ==================================================================== */
function normalize(p) {
  const num = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));
  const date = (v) => { const m = String(v ?? '').match(/^\d{4}-\d{2}-\d{2}/); return m ? m[0] : ''; };
  const rating = num(p.rating);
  return {
    id: String(p.id ?? ''),
    name: String(p.name ?? '').trim(),
    region: String(p.region ?? '').trim(),
    sub_region: String(p.sub_region ?? '').trim(),
    address: String(p.address ?? '').trim(),
    category: String(p.category ?? '').trim(),
    tags: Array.isArray(p.tags) ? p.tags.map(String).filter(Boolean)
      : String(p.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    memo: String(p.memo ?? ''),
    kakaomap_url: String(p.kakaomap_url ?? ''),
    instagram_url: String(p.instagram_url ?? ''),
    lat: num(p.lat),
    lng: num(p.lng),
    visited: p.visited === true || /^(true|1|y|yes|o)$/i.test(String(p.visited ?? '').trim()),
    added_at: date(p.added_at),
    visited_at: date(p.visited_at),
    rating: rating && rating > 0 ? Math.min(5, Math.round(rating)) : null,
    review: String(p.review ?? '').trim(),
  };
}

// 원본 데이터 등록 (id 없는 항목은 자동 id 부여)
function setBase(data, sourceLabel = 'places.json', { quietEmpty = false } = {}) {
  if (!Array.isArray(data)) throw new Error(`${sourceLabel} 형식이 배열이 아니에요`);
  state.base = data.filter((p) => p && typeof p === 'object' && String(p.name ?? '').trim()).map((p) => ({
    ...p,
    id: p.id != null && p.id !== '' ? String(p.id)
      : instagramId(p.instagram_url || '') || `auto-${p.name}-${p.region || ''}`,
  }));
  if (data.length === 0 && !quietEmpty) {
    showNotice(`${sourceLabel}은 불러왔지만 장소가 하나도 없어요.`);
  } else if (state.base.length < data.length) {
    showNotice(`${sourceLabel}의 ${data.length}개 항목 중 ${data.length - state.base.length}개는 이름(<code>name</code>)이 없어 건너뛰었어요.`);
  }
}

function merge() {
  const deleted = new Set(state.local.deleted);
  const seen = new Set();
  const out = [];
  for (const p of state.base) {
    const id = String(p.id);
    if (deleted.has(id)) continue;
    out.push(normalize(state.local.items[id] || p));
    seen.add(id);
  }
  for (const [id, p] of Object.entries(state.local.items)) {
    if (!seen.has(id) && !deleted.has(id)) out.push(normalize(p));
  }
  state.places = out;
}

function findPlace(id) { return state.places.find((p) => p.id === id); }
function isInBase(id) { return state.base.some((p) => String(p.id) === id); }

function upsertLocal(place) {
  state.local.items[place.id] = place;
  state.local.deleted = state.local.deleted.filter((d) => d !== place.id);
  saveLocal();
  merge();
}

function removeLocal(id) {
  delete state.local.items[id];
  if (isInBase(id) && !state.local.deleted.includes(id)) state.local.deleted.push(id);
  saveLocal();
  merge();
}

// 변경을 기록하고, 시트 모드면 바로 시트에 보내기
async function commitPlace(place, { fit = false } = {}) {
  upsertLocal(place);
  buildChips();
  render({ fit });
  if (state.mode === 'sheet') await flushQueue({ silent: true });
}

async function commitDelete(id) {
  removeLocal(id);
  buildChips();
  render();
  if (state.mode === 'sheet') await flushQueue({ silent: true });
}

/* ======================================================================
 * 구글 시트 (Apps Script 웹 앱)
 * ==================================================================== */
async function sheetGet(url = sheetUrl()) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.ok === false) throw new Error(data.error || '시트 오류');
  const arr = Array.isArray(data) ? data : data.places;
  if (!Array.isArray(arr)) throw new Error('시트 응답 형식이 달라요');
  return arr;
}

// Content-Type을 지정하지 않으면(text/plain) 브라우저 사전 확인 요청 없이 Apps Script로 보낼 수 있음
async function sheetPost(payload, { url = sheetUrl(), token = sheetToken() } = {}) {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ ...payload, token }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const out = await res.json();
  if (!out || out.ok !== true) throw new Error((out && out.error) || '시트 저장 실패');
  return out;
}

function toSheetPlace(p) {
  const n = normalize(p);
  return { ...n, tags: n.tags.join(', '), lat: n.lat ?? '', lng: n.lng ?? '', rating: n.rating ?? '' };
}

let flushAgain = false;
async function flushQueue({ silent = false } = {}) {
  if (state.mode !== 'sheet') return;
  if (localChangeCount() === 0) return;
  if (!sheetToken()) {
    if (!silent) toast('보기 전용이에요. ⋯ → 설정에서 비밀번호를 넣으면 시트에 저장돼요.');
    else toast('이 기기에 비밀번호가 없어 브라우저에만 저장했어요.');
    return;
  }
  if (state.syncing) { flushAgain = true; return; }
  state.syncing = true;
  updateStatusUI();
  let failed = null;
  do {
    flushAgain = false;
    try {
      for (const [id, p] of Object.entries({ ...state.local.items })) {
        await sheetPost({ action: 'upsert', place: toSheetPlace(p) });
        const i = state.base.findIndex((b) => String(b.id) === id);
        if (i >= 0) state.base[i] = p; else state.base.push(p);
        if (state.local.items[id] === p) delete state.local.items[id]; // 보내는 사이 또 고쳤으면 남겨 둠
        saveLocal();
      }
      for (const id of [...state.local.deleted]) {
        await sheetPost({ action: 'delete', id });
        state.base = state.base.filter((b) => String(b.id) !== id);
        state.local.deleted = state.local.deleted.filter((d) => d !== id);
        saveLocal();
      }
    } catch (err) {
      failed = err;
    }
  } while (!failed && (flushAgain || localChangeCount() > 0));
  state.syncing = false;
  merge();
  render();
  cacheSheet();
  if (failed) {
    toast(/unauthorized/i.test(failed.message)
      ? '비밀번호가 맞지 않아요. ⋯ → 설정에서 확인해 주세요.'
      : `시트에 저장하지 못했어요 (${failed.message}). 위쪽 배지를 눌러 다시 시도해 주세요.`);
  } else if (!silent) {
    toast('시트에 저장했어요.');
  }
}

function cacheSheet() {
  if (state.mode !== 'sheet') return;
  try { localStorage.setItem(SHEET_CACHE_KEY, JSON.stringify(state.base)); } catch (e) { /* 무시 */ }
}

async function reloadSheet() {
  try {
    const data = await sheetGet();
    $('#notice').hidden = true;
    setBase(data, '구글 시트', { quietEmpty: true });
    cacheSheet();
    merge(); buildChips(); render({ fit: true });
    toast(`시트에서 ${state.base.length}곳을 불러왔어요.`);
  } catch (err) {
    toast(`시트를 불러오지 못했어요 (${err.message})`);
  }
}

// 시트가 비어 있을 때: places.json + 브라우저 변경분을 시트로 한 번에 옮기기
async function migrateToSheet(jsonData) {
  if (!sheetToken()) { toast('먼저 ⋯ → 설정에서 비밀번호를 넣어 주세요.'); openSettings(); return; }
  if (!confirm(`places.json의 장소${localChangeCount() ? '와 브라우저에 저장된 변경' : ''}을 구글 시트로 옮길까요?`)) return;
  try {
    setBase(jsonData, 'places.json', { quietEmpty: true });
    merge();
    const list = state.places.map(toSheetPlace);
    await sheetPost({ action: 'replaceAll', places: list });
    state.base = state.places.map((p) => ({ ...p }));
    state.local = { items: {}, deleted: [] };
    saveLocal(); cacheSheet();
    $('#notice').hidden = true;
    merge(); buildChips(); render({ fit: true });
    toast(`${list.length}곳을 시트로 옮겼어요. 이제 어느 기기에서든 같은 목록이 보여요.`);
  } catch (err) {
    toast(`옮기지 못했어요 (${err.message})`);
  }
}

/* ======================================================================
 * 필터 · 정렬
 * ==================================================================== */
function matches(p) {
  const f = state.filters;
  if (f.region !== '전체' && p.region !== f.region) return false;
  if (f.category !== '전체' && p.category !== f.category) return false;
  if (f.visited === 'todo' && p.visited) return false;
  if (f.visited === 'done' && !p.visited) return false;
  if (f.q) {
    const hay = [p.name, p.region, p.sub_region, p.address, p.category, p.memo, p.review, ...p.tags].join(' ').toLowerCase();
    const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.every((t) => hay.includes(t.replace(/^#/, '')))) return false;
  }
  return true;
}

function distanceKm(p) {
  if (!state.userPos || p.lat == null || p.lng == null) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(p.lat - state.userPos.lat);
  const dLng = toRad(p.lng - state.userPos.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(state.userPos.lat)) * Math.cos(toRad(p.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function fmtDistance(km) {
  if (km == null) return '';
  if (km < 1) return `${Math.max(10, Math.round(km * 100) * 10)}m`;
  if (km < 100) return `${km.toFixed(1)}km`;
  return `${Math.round(km)}km`;
}

function sorted(list) {
  const arr = [...list];
  const byAdded = (a, b) => b.added_at.localeCompare(a.added_at);
  switch (state.sort) {
    case 'name': arr.sort((a, b) => a.name.localeCompare(b.name, 'ko')); break;
    case 'region': arr.sort((a, b) => (a.region + a.sub_region).localeCompare(b.region + b.sub_region, 'ko') || a.name.localeCompare(b.name, 'ko')); break;
    case 'near': arr.sort((a, b) => (distanceKm(a) ?? Infinity) - (distanceKm(b) ?? Infinity)); break;
    case 'visited': arr.sort((a, b) => (Number(b.visited) - Number(a.visited)) || b.visited_at.localeCompare(a.visited_at) || byAdded(a, b)); break;
    case 'rating': arr.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.visited_at.localeCompare(a.visited_at)); break;
    default: arr.sort(byAdded);
  }
  return arr;
}

function visiblePlaces() { return sorted(state.places.filter(matches)); }

function unionWithData(preset, key) {
  const extra = state.places.map((p) => p[key]).filter((v) => v && !preset.includes(v));
  return [...preset, ...[...new Set(extra)].sort((a, b) => a.localeCompare(b, 'ko'))];
}

function buildChips() {
  const make = (el, values, key) => {
    const current = state.filters[key];
    if (current !== '전체' && !values.includes(current)) values = [...values, current];
    el.innerHTML = ['전체', ...values].map((v) =>
      `<button class="chip${v === current ? ' active' : ''}" data-${key}="${esc(v)}">${esc(v)}</button>`
    ).join('');
  };
  make($('#regionChips'), unionWithData(REGIONS, 'region'), 'region');
  make($('#categoryChips'), unionWithData(CATEGORIES, 'category'), 'category');

  $('#regionList').innerHTML = unionWithData(REGIONS, 'region').map((r) => `<option value="${esc(r)}">`).join('');
  const sel = $('#categorySelect');
  const keep = sel.value;
  sel.innerHTML = unionWithData(CATEGORIES, 'category').map((c) => `<option>${esc(c)}</option>`).join('');
  if (keep) sel.value = keep;
}

/* ======================================================================
 * 링크
 * ==================================================================== */
function validUrl(u) {
  return /^https?:\/\//i.test(u) && !/\.\.\.$/.test(u) ? u : '';
}

function kakaoLink(p) {
  const u = validUrl(p.kakaomap_url);
  if (u) return u;
  if (p.lat != null && p.lng != null) return `https://map.kakao.com/link/map/${encodeURIComponent(p.name)},${p.lat},${p.lng}`;
  return `https://map.kakao.com/link/search/${encodeURIComponent(p.address ? `${p.address} ${p.name}` : [p.sub_region, p.name].filter(Boolean).join(' '))}`;
}

function kakaoRouteLink(p) {
  if (p.lat == null || p.lng == null) return '';
  return `https://map.kakao.com/link/to/${encodeURIComponent(p.name)},${p.lat},${p.lng}`;
}

function kakaoPlaceId(url) {
  const m = String(url).match(/place\.map\.kakao\.com\/(?:m\/)?(\d+)/);
  return m ? m[1] : '';
}

/* ======================================================================
 * 화면 그리기
 * ==================================================================== */
function render({ fit = false } = {}) {
  const list = visiblePlaces();
  const total = state.places.length;
  const visitedCount = state.places.filter((p) => p.visited).length;
  const src = state.mode === 'file' ? ` · places.json ${state.base.length}곳` : '';
  $('#resultCount').textContent = `${list.length}곳 표시 · 전체 ${total}곳 (가본 곳 ${visitedCount})${src}`;

  $('#cardList').innerHTML = list.map(cardHTML).join('');
  $('#emptyMsg').hidden = list.length > 0;
  $('#emptyMsg').textContent = total === 0
    ? '아직 장소가 없어요. ＋ 버튼으로 첫 장소를 추가해 보세요.'
    : '조건에 맞는 장소가 없어요. 필터를 ‘전체’로 바꿔 보세요.';
  renderMarkers(list, fit);
  updateStatusUI();
}

function starsHTML(n) {
  if (!n) return '';
  return `<span class="stars-view" aria-label="별점 ${n}점">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`;
}

function fmtDate(d) { return d ? d.replace(/-/g, '.') : ''; }

function cardHTML(p) {
  const loc = [p.region, p.sub_region].filter(Boolean).join(' · ');
  const insta = validUrl(p.instagram_url);
  const route = kakaoRouteLink(p);
  const hasCoord = p.lat != null && p.lng != null;
  const pending = !!state.local.items[p.id];
  const pendingLabel = state.mode === 'sheet' ? (state.syncing ? '저장 중' : '저장 대기') : '브라우저 저장';
  const dist = fmtDistance(distanceKm(p));
  const visitLog = p.visited && (p.rating || p.visited_at || p.review) ? `
    <div class="visit-log">
      ${starsHTML(p.rating)}
      ${p.visited_at ? `<span class="visit-date">${fmtDate(p.visited_at)} 방문</span>` : ''}
      ${p.review ? `<p class="review">“${esc(p.review)}”</p>` : ''}
    </div>` : '';
  return `
  <li class="card${p.visited ? ' visited' : ''}" data-id="${esc(p.id)}">
    <div class="card-head">
      <div>
        <h3 class="card-title">${esc(p.name)}${pending ? `<span class="local-mark">· ${pendingLabel}</span>` : ''}</h3>
        <div class="card-loc">${esc(loc)}${dist ? `<span class="dist">${dist}</span>` : ''}</div>
        ${p.address ? `<div class="card-addr">${esc(p.address)}</div>` : ''}
      </div>
      <button class="visit-btn" data-action="visit" aria-label="${p.visited ? '방문 기록 보기·수정' : '방문 기록 남기기'}">
        ${p.visited ? '✓ 가본 곳' : '가볼 곳'}
      </button>
    </div>
    <div class="tag-row">
      ${p.category ? `<span class="tag cat">${esc(p.category)}</span>` : ''}
      ${p.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}
    </div>
    ${p.memo ? `<p class="memo">${esc(p.memo)}</p>` : ''}
    ${visitLog}
    <div class="card-actions">
      <a class="btn kakao" href="${esc(kakaoLink(p))}" target="_blank" rel="noopener">카카오맵</a>
      ${route ? `<a class="btn subtle" href="${esc(route)}" target="_blank" rel="noopener">길찾기</a>` : ''}
      ${insta ? `<a class="btn insta" href="${esc(insta)}" target="_blank" rel="noopener">인스타 원문</a>` : ''}
      ${hasCoord ? '<button class="btn subtle" data-action="locate">지도에서 보기</button>' : ''}
      <span class="spacer"></span>
      <button class="btn-text" data-action="edit">수정</button>
      <button class="btn-text danger" data-action="delete">삭제</button>
    </div>
  </li>`;
}

function updateStatusUI() {
  const n = localChangeCount();
  const badge = $('#dirtyBadge');
  const pill = $('#modePill');
  if (!badge || !pill) return;

  if (state.mode === 'sheet') {
    pill.hidden = false;
    pill.textContent = sheetToken() ? '시트 연결됨' : '보기 전용';
    pill.className = `mode-pill ${sheetToken() ? 'on' : 'ro'}`;
    badge.hidden = n === 0 && !state.syncing;
    badge.textContent = state.syncing ? '시트에 저장 중…'
      : sheetToken() ? `저장 대기 ${n}건 · 다시 시도` : `저장 대기 ${n}건 · 비밀번호 필요`;
  } else {
    pill.hidden = true;
    badge.hidden = n === 0;
    badge.textContent = `변경 ${n}건 · 내보내기`;
  }
  document.querySelectorAll('[data-sheet-only]').forEach((el) => { el.hidden = state.mode !== 'sheet'; });
}

/* ======================================================================
 * 지도 (Leaflet + OpenStreetMap 계열 타일)
 * ==================================================================== */
// 웹 주소(GitHub Pages, localhost)로 열면 CARTO,
// 파일 더블클릭(file://)으로 열면 요청 출처가 비어 CARTO·OSM이 막으므로 Esri 타일 사용
function addTiles(target) {
  if (location.protocol === 'file:') {
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri',
    }).addTo(target);
  } else {
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 20,
      subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(target);
  }
}

function initMap() {
  if (map || !window.L) return;
  map = L.map('map', { zoomControl: true }).setView(DEFAULT_CENTER, 7);
  addTiles(map);
  markerLayer = L.layerGroup().addTo(map);
}

function renderMarkers(list, fit) {
  if (!window.L) {
    $('#map').innerHTML = '<p class="empty">지도를 불러오지 못했어요 (네트워크 확인).</p>';
    return;
  }
  initMap();
  markerLayer.clearLayers();
  markers.clear();
  const pts = [];
  for (const p of list) {
    if (p.lat == null || p.lng == null) continue;
    const m = L.circleMarker([p.lat, p.lng], {
      radius: 9, weight: 2, color: '#fff', fillOpacity: 0.95,
      fillColor: p.visited ? COLORS.done : COLORS.todo,
    }).bindPopup(popupHTML(p));
    m.on('click', () => highlightCard(p.id));
    m.addTo(markerLayer);
    markers.set(p.id, m);
    pts.push([p.lat, p.lng]);
  }
  renderUserMarker();
  if (fit) {
    if (state.sort === 'near' && state.userPos) {
      // 가까운 순일 때는 내 위치 + 가까운 5곳이 보이게
      const near = list.filter((p) => p.lat != null).slice(0, 5).map((p) => [p.lat, p.lng]);
      map.fitBounds([[state.userPos.lat, state.userPos.lng], ...near], { padding: [40, 40], maxZoom: 15 });
    } else if (pts.length === 1) map.setView(pts[0], 13);
    else if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
  }
}

function renderUserMarker() {
  if (!map) return;
  if (!state.userPos) { if (userMarker) { userMarker.remove(); userMarker = null; } return; }
  const ll = [state.userPos.lat, state.userPos.lng];
  if (userMarker) userMarker.setLatLng(ll);
  else {
    userMarker = L.circleMarker(ll, { radius: 7, weight: 4, color: 'rgba(15,43,61,.25)', fillColor: '#0F2B3D', fillOpacity: 1 })
      .bindTooltip('내 위치').addTo(map);
  }
}

function popupHTML(p) {
  const insta = validUrl(p.instagram_url);
  const route = kakaoRouteLink(p);
  const dist = fmtDistance(distanceKm(p));
  return `
    <div class="pop-title">${esc(p.name)}</div>
    <div class="pop-sub">${esc([p.sub_region || p.region, p.category, dist].filter(Boolean).join(' · '))}${p.visited ? ' · 가본 곳' : ''}</div>
    ${p.rating ? `<div>${starsHTML(p.rating)}</div>` : ''}
    ${p.memo ? `<div>${esc(p.memo)}</div>` : ''}
    <div class="pop-links" style="margin-top:6px">
      <a href="${esc(kakaoLink(p))}" target="_blank" rel="noopener">카카오맵</a>
      ${route ? `<a href="${esc(route)}" target="_blank" rel="noopener">길찾기</a>` : ''}
      ${insta ? `<a href="${esc(insta)}" target="_blank" rel="noopener">인스타</a>` : ''}
    </div>`;
}

function locateOnMap(id) {
  const isMobile = !window.matchMedia('(min-width: 960px)').matches;
  if (isMobile) setView('map');
  const m = markers.get(id);
  if (!m) return;
  setTimeout(() => {
    map.invalidateSize();
    map.setView(m.getLatLng(), 15);
    m.openPopup();
  }, isMobile ? 60 : 0);
}

function highlightCard(id) {
  document.querySelectorAll('.card.highlight').forEach((c) => c.classList.remove('highlight'));
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (card && window.matchMedia('(min-width: 960px)').matches) {
    card.classList.add('highlight');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function setView(view) {
  state.view = view;
  document.body.classList.toggle('view-map', view === 'map');
  document.body.classList.toggle('view-list', view === 'list');
  document.querySelectorAll('.view-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'map' && map) setTimeout(() => map.invalidateSize(), 30);
}

/* ======================================================================
 * 가까운 순 (내 위치)
 * ==================================================================== */
function requestPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('이 브라우저는 위치 확인을 지원하지 않아요')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(err.code === 1 ? '위치 권한이 꺼져 있어요. 브라우저 설정에서 허용해 주세요' : '위치를 확인하지 못했어요')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 },
    );
  });
}

async function changeSort(value, prev) {
  if (value === 'near') {
    toast('내 위치를 확인하는 중…');
    try {
      state.userPos = await requestPosition();
    } catch (err) {
      toast(err.message);
      $('#sortSelect').value = prev;
      state.sort = prev;
      return;
    }
    const noCoord = state.places.filter((p) => p.lat == null).length;
    toast(noCoord ? `가까운 순으로 정렬했어요. 좌표 없는 ${noCoord}곳은 맨 아래에 있어요.` : '가까운 순으로 정렬했어요.');
  }
  state.sort = value;
  render({ fit: value === 'near' });
  if (value === 'near') window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ======================================================================
 * 카카오 장소 검색 · 주소 검색
 * ==================================================================== */
let kakaoPromise = null;
function loadKakao(key = kakaoKey()) {
  if (window.kakao && window.kakao.maps && window.kakao.maps.services) return Promise.resolve(window.kakao);
  if (kakaoPromise) return kakaoPromise;
  if (!key) return Promise.reject(new Error('NO_KEY'));
  kakaoPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services&autoload=false`;
    s.onload = () => {
      try { window.kakao.maps.load(() => resolve(window.kakao)); } catch (e) { reject(new Error('카카오 지도 SDK 초기화 실패')); }
    };
    s.onerror = () => reject(new Error('카카오 SDK를 불러오지 못했어요. 키와 사이트 도메인 등록을 확인해 주세요'));
    document.head.appendChild(s);
  });
  kakaoPromise.catch(() => { kakaoPromise = null; });
  return kakaoPromise;
}

async function kakaoKeywordSearch(q) {
  const kakao = await loadKakao();
  const opts = { size: 8 };
  if (state.userPos) opts.location = new kakao.maps.LatLng(state.userPos.lat, state.userPos.lng);
  return new Promise((resolve, reject) => {
    new kakao.maps.services.Places().keywordSearch(q, (data, status) => {
      if (status === kakao.maps.services.Status.OK) resolve(data);
      else if (status === kakao.maps.services.Status.ZERO_RESULT) resolve([]);
      else reject(new Error('카카오 검색 오류 (키·도메인 등록 확인)'));
    }, opts);
  });
}

async function kakaoAddressSearch(q) {
  const kakao = await loadKakao();
  return new Promise((resolve) => {
    new kakao.maps.services.Geocoder().addressSearch(q, (data, status) => {
      resolve(status === kakao.maps.services.Status.OK && data.length ? { lat: Number(data[0].y), lng: Number(data[0].x) } : null);
    });
  });
}

const PROVINCE_SHORT = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천', 광주광역시: '광주', 대전광역시: '대전',
  울산광역시: '울산', 세종특별자치시: '세종', 경기도: '경기', 강원특별자치도: '강원', 강원도: '강원', 충청북도: '충북',
  충청남도: '충남', 전북특별자치도: '전북', 전라북도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남',
  제주특별자치도: '제주',
};

// "경기 시흥시 대야동 551" → { region: '경기', sub_region: '시흥 대야동' }
// "경북 경주시 황남동 …" → { region: '경주', sub_region: '황남동' } (경주·강릉처럼 따로 쓰는 지역)
function regionFromAddress(addr) {
  const t = String(addr).split(/\s+/).filter(Boolean);
  if (!t.length) return { region: '', sub_region: '' };
  const prov = PROVINCE_SHORT[t[0]] || t[0];
  const city = t[1] || '';
  const cityShort = city.replace(/(특별자치시|시|군|구)$/, '');
  const dong = t.slice(2).find((x) => /(동|읍|면|가|리)$/.test(x) && !/^\d/.test(x)) || '';
  const known = unionWithData(REGIONS, 'region');
  if (cityShort && cityShort !== prov && known.includes(cityShort)) return { region: cityShort, sub_region: dong };
  return { region: prov, sub_region: [/구$/.test(city) ? city : cityShort, dong].filter(Boolean).join(' ') };
}

function categoryFromKakao(d) {
  const name = d.category_name || '';
  const known = unionWithData(CATEGORIES, 'category');
  let c = '';
  if (d.category_group_code === 'CE7' || /카페|디저트|베이커리/.test(name)) c = '카페';
  else if (d.category_group_code === 'FD6') c = '밥집';
  else if (/도서관|스터디/.test(name)) c = '도서관/작업';
  else if (/공방|체험|클래스/.test(name)) c = '공방';
  else if (d.category_group_code === 'CT1' || /미술관|전시|박물관|갤러리|공연/.test(name)) c = '전시/문화';
  return known.includes(c) ? c : '';
}

let ksResults = [];
async function runKakaoSearch() {
  const q = $('#ksInput').value.trim();
  const msg = $('#ksMsg');
  const ul = $('#ksResults');
  if (!q) { $('#ksInput').focus(); return; }
  if (!kakaoKey()) {
    msg.innerHTML = '카카오 키가 아직 없어요. <button type="button" class="link-btn" data-open-settings>설정 열기</button>';
    return;
  }
  msg.textContent = '검색 중…';
  ul.innerHTML = '';
  try {
    ksResults = await kakaoKeywordSearch(q);
    if (!ksResults.length) { msg.textContent = '검색 결과가 없어요. 지역명을 붙여 보세요 (예: 카페 이름 + 동네).'; return; }
    msg.textContent = '맞는 장소를 눌러 주세요.';
    ul.innerHTML = ksResults.map((d, i) => {
      const dup = state.places.find((p) => kakaoPlaceId(p.kakaomap_url) && kakaoPlaceId(p.kakaomap_url) === d.id);
      return `<li><button type="button" data-ks="${i}">
        <strong>${esc(d.place_name)}</strong>${dup ? '<span class="dup">이미 저장됨</span>' : ''}
        <span>${esc(d.road_address_name || d.address_name)}</span>
        <em>${esc((d.category_name || '').split(' > ').slice(-2).join(' · '))}</em>
      </button></li>`;
    }).join('');
  } catch (err) {
    msg.textContent = err.message === 'NO_KEY' ? '카카오 키가 아직 없어요.' : err.message;
  }
}

function applyKakaoResult(d) {
  const form = $('#placeForm');
  const addr = d.road_address_name || d.address_name || '';
  const { region, sub_region } = regionFromAddress(d.address_name || addr);
  form.elements.name.value = d.place_name;
  form.elements.address.value = addr;
  if (region) form.elements.region.value = region;
  if (sub_region) form.elements.sub_region.value = sub_region;
  const cat = categoryFromKakao(d);
  if (cat) form.elements.category.value = cat;
  form.elements.kakaomap_url.value = String(d.place_url || '').replace(/^http:/, 'https:');
  setFormCoord(d.y, d.x);
  $('#ksResults').innerHTML = '';
  $('#ksMsg').textContent = `‘${d.place_name}’ 정보로 채웠어요. 메모와 태그만 더하면 돼요.`;
  setGeoStatus('카카오 좌표로 채웠어요.', 'ok');
  showPickMap(Number(d.y), Number(d.x), 17);
  const dup = state.places.find((p) => kakaoPlaceId(p.kakaomap_url) === d.id && p.id !== state.editingId);
  if (dup) toast(`‘${dup.name}’은 이미 저장돼 있어요.`);
}

/* ======================================================================
 * 추가 / 수정 창
 * ==================================================================== */
function instagramId(url) {
  const m = String(url).match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

function today() { return new Date().toLocaleDateString('sv-SE'); } // YYYY-MM-DD (현지 시간)

function openDialog(id = null) {
  state.editingId = id;
  const form = $('#placeForm');
  form.reset();
  $('#dialogTitle').textContent = id ? '장소 수정' : '장소 추가';
  if (id) {
    const p = findPlace(id);
    for (const [k, v] of Object.entries(p)) {
      const el = form.elements[k];
      if (!el || el.type === 'checkbox') continue;
      el.value = Array.isArray(v) ? v.join(', ') : (v ?? '');
    }
  } else {
    if (state.filters.region !== '전체') form.elements.region.value = state.filters.region;
    if (state.filters.category !== '전체') form.elements.category.value = state.filters.category;
  }
  $('#ksInput').value = '';
  $('#ksResults').innerHTML = '';
  $('#ksMsg').innerHTML = kakaoKey() ? '' : '카카오 키를 넣으면 이름만으로 주소·좌표를 채울 수 있어요. <button type="button" class="link-btn" data-open-settings>설정 열기</button>';
  $('#kakaoSearch').hidden = !!id && !kakaoKey();
  $('#pickMap').hidden = true;
  setGeoStatus('');
  $('#placeDialog').showModal();
  if (!id && kakaoKey()) setTimeout(() => $('#ksInput').focus(), 50);
}

async function handleSubmit(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const editing = state.editingId ? findPlace(state.editingId) : null;
  const insta = String(f.get('instagram_url') || '').trim();
  const kakaoUrl = String(f.get('kakaomap_url') || '').trim();

  let id = editing?.id;
  if (!id) {
    const kid = kakaoPlaceId(kakaoUrl);
    id = instagramId(insta) || (kid ? `kakao-${kid}` : `local-${Date.now().toString(36)}`);
    if (findPlace(id)) {
      toast('같은 인스타 게시물(또는 카카오 장소)로 저장된 장소가 이미 있어요.');
      return;
    }
  }

  const place = normalize({
    id,
    name: f.get('name'),
    region: f.get('region'),
    sub_region: f.get('sub_region'),
    address: f.get('address'),
    category: f.get('category'),
    tags: f.get('tags'),
    memo: f.get('memo'),
    kakaomap_url: kakaoUrl,
    instagram_url: insta,
    lat: f.get('lat'),
    lng: f.get('lng'),
    added_at: editing?.added_at || today(),
    visited: editing?.visited || false,
    visited_at: editing?.visited_at || '',
    rating: editing?.rating ?? null,
    review: editing?.review || '',
  });

  $('#placeDialog').close();
  toast(editing ? '수정했어요.' : `‘${place.name}’ 추가했어요.`);
  await commitPlace(place, { fit: !editing });
}

/* ---------- 주소 → 좌표 / 지도에서 위치 찍기 ---------- */
let pickMap = null;
let pickMarker = null;

function setGeoStatus(msg, kind = '') {
  const el = $('#geoStatus');
  el.textContent = msg;
  el.className = `geo-status ${kind}`;
}

function setFormCoord(lat, lng) {
  const form = $('#placeForm');
  form.elements.lat.value = Number(lat).toFixed(6);
  form.elements.lng.value = Number(lng).toFixed(6);
}

// 카카오맵 주소 → 검색이 잘 되는 형태로 여러 후보 만들기
// "경기 시흥시 은계번영길 11 은계프라자 305호" → 도로명+건물번호까지만 남기기 등
function addressCandidates(raw) {
  const PROV = { 서울: '서울특별시', 부산: '부산광역시', 대구: '대구광역시', 인천: '인천광역시', 광주: '광주광역시',
    대전: '대전광역시', 울산: '울산광역시', 세종: '세종특별자치시', 경기: '경기도', 강원: '강원특별자치도',
    충북: '충청북도', 충남: '충청남도', 전북: '전북특별자치도', 전남: '전라남도', 경북: '경상북도', 경남: '경상남도', 제주: '제주특별자치도' };
  const a = String(raw).replace(/\(.*?\)/g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const road = a.match(/^(.*?\S(?:로|길)\s*\d+(?:-\d+)?)(?=\s|$)/);
  const jibun = a.match(/^(.*?\S(?:동|리|가)\s*(?:산\s*)?\d+(?:-\d+)?)(?=\s|$)/);
  const expand = (s) => { const f = s.split(' ')[0]; return PROV[f] ? s.replace(f, PROV[f]) : s; };
  const precise = [road && road[1], jibun && jibun[1], a].filter(Boolean);
  const list = [...precise, ...precise.map(expand)].map((q) => ({ q, rough: false }));
  // 마지막 수단: 건물번호 없이 도로명까지만 → 대략적인 위치
  if (road) {
    const bare = road[1].replace(/\s*\d+(?:-\d+)?$/, '');
    list.push({ q: bare, rough: true }, { q: expand(bare), rough: true });
  }
  const seen = new Set();
  return list.filter((c) => !seen.has(c.q) && seen.add(c.q));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geocodeAddress() {
  const form = $('#placeForm');
  const addr = form.elements.address.value.trim();
  if (!addr) { setGeoStatus('주소를 먼저 넣어 주세요.', 'warn'); form.elements.address.focus(); return; }
  const btn = $('#geocodeBtn');
  btn.disabled = true;
  setGeoStatus('찾는 중…');
  const found = (lat, lng, rough, by) => {
    setFormCoord(lat, lng);
    setGeoStatus(rough ? '도로까지만 찾았어요. 지도에서 정확한 위치를 눌러 주세요.' : `찾았어요${by}! 지도에서 위치를 확인해 주세요.`, rough ? 'warn' : 'ok');
    showPickMap(Number(lat), Number(lng), rough ? 16 : 17);
  };
  try {
    const cands = addressCandidates(addr);
    // 1) 카카오 주소 검색 (키가 있을 때, 한국 주소에 가장 정확)
    if (kakaoKey()) {
      try {
        for (const c of cands) {
          const r = await kakaoAddressSearch(c.q);
          if (r) { found(r.lat, r.lng, c.rough, ' (카카오)'); return; }
        }
      } catch (e) { /* 카카오 실패 시 아래 무료 검색으로 */ }
    }
    // 2) 오픈스트리트맵 무료 검색 (1초에 1번 규칙)
    for (let i = 0; i < cands.length; i++) {
      if (i > 0) await sleep(1100);
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=kr&accept-language=ko&q=${encodeURIComponent(cands[i].q)}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.length) { found(data[0].lat, data[0].lon, cands[i].rough, ''); return; }
    }
    setGeoStatus('주소로 못 찾았어요. ‘지도에서 직접 찍기’를 이용해 주세요.', 'warn');
    showPickMap();
  } catch (err) {
    setGeoStatus(`검색 실패(${err.message}). ‘지도에서 직접 찍기’를 이용해 주세요.`, 'warn');
  } finally {
    btn.disabled = false;
  }
}

function showPickMap(lat = null, lng = null, zoom = 16) {
  if (!window.L) { setGeoStatus('지도를 불러오지 못했어요.', 'warn'); return; }
  const box = $('#pickMap');
  box.hidden = false;
  if (!pickMap) {
    pickMap = L.map(box, { zoomControl: true });
    addTiles(pickMap);
    pickMap.on('click', (e) => {
      placePickMarker(e.latlng.lat, e.latlng.lng);
      setFormCoord(e.latlng.lat, e.latlng.lng);
      setGeoStatus('위치를 찍었어요.', 'ok');
    });
  }
  const form = $('#placeForm');
  const curLat = lat ?? (form.elements.lat.value ? Number(form.elements.lat.value) : null);
  const curLng = lng ?? (form.elements.lng.value ? Number(form.elements.lng.value) : null);
  setTimeout(() => {
    pickMap.invalidateSize();
    if (curLat != null && curLng != null) {
      pickMap.setView([curLat, curLng], zoom);
      placePickMarker(curLat, curLng);
    } else {
      if (pickMarker) { pickMarker.remove(); pickMarker = null; }
      const center = state.userPos ? L.latLng(state.userPos.lat, state.userPos.lng) : map ? map.getCenter() : L.latLng(DEFAULT_CENTER);
      pickMap.setView(center, state.userPos ? 15 : map ? Math.max(map.getZoom(), 11) : 7);
      if (!lat) setGeoStatus('지도를 확대해서 장소 위치를 눌러 주세요.');
    }
  }, 30);
}

function placePickMarker(lat, lng) {
  if (pickMarker) { pickMarker.setLatLng([lat, lng]); return; }
  pickMarker = L.marker([lat, lng], { draggable: true }).addTo(pickMap);
  pickMarker.on('dragend', () => {
    const { lat: a, lng: b } = pickMarker.getLatLng();
    setFormCoord(a, b);
    setGeoStatus('위치를 옮겼어요.', 'ok');
  });
}

/* ======================================================================
 * 방문 기록
 * ==================================================================== */
function setStars(n) {
  $('#visitForm').elements.rating.value = n || '';
  document.querySelectorAll('#starInput button').forEach((b) => {
    const on = Number(b.dataset.star) <= (n || 0);
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(Number(b.dataset.star) === n));
  });
}

function openVisitDialog(id) {
  const p = findPlace(id);
  if (!p) return;
  state.visitingId = id;
  const form = $('#visitForm');
  form.reset();
  $('#visitPlace').textContent = p.name;
  form.elements.visited_at.value = p.visited_at || today();
  form.elements.visited_at.max = today();
  form.elements.review.value = p.review || '';
  setStars(p.rating || 0);
  $('#unvisitBtn').hidden = !p.visited;
  $('#visitDialog').showModal();
}

async function handleVisitSubmit(e) {
  e.preventDefault();
  const p = findPlace(state.visitingId);
  if (!p) return;
  const f = new FormData(e.target);
  const wasVisited = p.visited;
  $('#visitDialog').close();
  toast(wasVisited ? '방문 기록을 고쳤어요.' : `‘${p.name}’ 가본 곳으로 기록했어요!`);
  await commitPlace({
    ...p,
    visited: true,
    visited_at: String(f.get('visited_at') || today()),
    rating: Number(f.get('rating')) || null,
    review: String(f.get('review') || '').trim(),
  });
}

async function unvisit() {
  const p = findPlace(state.visitingId);
  if (!p) return;
  if ((p.rating || p.review) && !confirm('별점과 후기도 함께 지워져요. 가볼 곳으로 되돌릴까요?')) return;
  $('#visitDialog').close();
  toast(`‘${p.name}’ 가볼 곳으로 되돌렸어요.`);
  await commitPlace({ ...p, visited: false, visited_at: '', rating: null, review: '' });
}

/* ======================================================================
 * 설정 창
 * ==================================================================== */
function openSettings() {
  const s = getSettings();
  const form = $('#settingsForm');
  form.elements.kakaoKey.value = s.kakaoKey || '';
  form.elements.sheetUrl.value = s.sheetUrl || '';
  form.elements.token.value = s.token || '';
  form.elements.kakaoKey.placeholder = CONFIG.KAKAO_JS_KEY ? 'config.js의 키 사용 중' : '카카오 JavaScript 키';
  form.elements.sheetUrl.placeholder = CONFIG.SHEET_API_URL ? 'config.js의 URL 사용 중' : 'https://script.google.com/macros/s/.../exec';
  $('#settingsStatus').textContent = '';
  $('#settingsDialog').showModal();
}

function readSettingsForm() {
  const form = $('#settingsForm');
  return {
    kakaoKey: form.elements.kakaoKey.value.trim(),
    sheetUrl: form.elements.sheetUrl.value.trim(),
    token: form.elements.token.value.trim(),
  };
}

async function testSettings() {
  const s = readSettingsForm();
  const out = [];
  const status = $('#settingsStatus');
  status.textContent = '확인 중…';
  const kKey = s.kakaoKey || CONFIG.KAKAO_JS_KEY;
  if (kKey) {
    try {
      await loadKakao(kKey);
      const r = await kakaoKeywordSearch('서울역');
      out.push(r.length ? '✓ 카카오 검색 연결됨' : '△ 카카오 SDK는 불러왔지만 검색 결과가 없어요');
    } catch (err) { out.push(`✗ 카카오: ${err.message}`); }
  } else out.push('· 카카오 키 없음');

  const url = s.sheetUrl || CONFIG.SHEET_API_URL;
  if (url) {
    try {
      const data = await sheetGet(url);
      out.push(`✓ 시트 읽기 성공 (${data.length}곳)`);
      if (s.token) {
        try { await sheetPost({ action: 'ping' }, { url, token: s.token }); out.push('✓ 비밀번호 맞음 (저장 가능)'); }
        catch (err) { out.push(/unauthorized/i.test(err.message) ? '✗ 비밀번호가 Apps Script의 TOKEN과 달라요' : `✗ 저장 확인 실패: ${err.message}`); }
      } else out.push('· 비밀번호 없음 → 이 기기는 보기 전용');
    } catch (err) { out.push(`✗ 시트: ${err.message} (URL·배포 설정 확인)`); }
  } else out.push('· 시트 URL 없음 → places.json 사용');
  status.innerHTML = out.map(esc).join('<br>');
}

function handleSettingsSubmit(e) {
  e.preventDefault();
  const before = { kakao: kakaoKey(), sheet: sheetUrl(), token: sheetToken() };
  saveSettings(readSettingsForm());
  $('#settingsDialog').close();
  // 시트 주소나 카카오 키가 바뀌면 새로 불러와야 적용됨 (카카오 SDK는 한 번 불러오면 키를 못 바꿈)
  if (before.sheet !== sheetUrl() || (before.kakao !== kakaoKey() && window.kakao)) {
    toast('설정을 저장했어요. 새로 불러올게요.');
    setTimeout(() => location.reload(), 600);
    return;
  }
  toast('설정을 저장했어요.');
  updateStatusUI();
  if (state.mode === 'sheet' && sheetToken() && localChangeCount()) flushQueue();
}

/* ======================================================================
 * 내보내기 / 가져오기 / 초기화
 * ==================================================================== */
function exportJSON() {
  const data = sorted(state.places).map((p) => ({ ...p }));
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'places.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(state.mode === 'sheet' ? '백업용 places.json을 내려받았어요.' : 'places.json을 내려받았어요. 저장소의 파일을 이걸로 교체하세요.');
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data)) throw new Error('배열 형식이 아니에요');
      const items = {};
      for (const raw of data) {
        const p = normalize(raw);
        if (!p.id) p.id = instagramId(p.instagram_url) || `local-${Math.random().toString(36).slice(2, 9)}`;
        if (!p.name) continue;
        items[p.id] = p;
      }
      const n = Object.keys(items).length;
      if (state.mode === 'sheet') {
        if (!sheetToken()) { toast('비밀번호가 있어야 시트로 가져올 수 있어요.'); return; }
        if (!confirm(`${n}곳으로 구글 시트 내용을 통째로 바꿀까요? (지금 시트 내용은 지워져요)`)) return;
        const list = Object.values(items);
        await sheetPost({ action: 'replaceAll', places: list.map(toSheetPlace) });
        state.base = list;
        state.local = { items: {}, deleted: [] };
        saveLocal(); cacheSheet();
      } else {
        if (!confirm(`${n}곳을 가져와 현재 목록을 대체할까요?`)) return;
        state.local = { items, deleted: state.base.map((p) => String(p.id)).filter((id) => !items[id]) };
        saveLocal();
      }
      merge(); buildChips(); render({ fit: true });
      toast('가져오기 완료.');
    } catch (err) {
      toast(`가져오기 실패: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function resetLocal() {
  const msg = state.mode === 'sheet'
    ? '시트에 아직 저장되지 않은 변경을 모두 버릴까요?'
    : '브라우저에 저장된 추가·수정·방문 기록을 모두 지우고 places.json 상태로 돌아갈까요?';
  if (!confirm(msg)) return;
  state.local = { items: {}, deleted: [] };
  saveLocal();
  merge(); buildChips(); render({ fit: true });
  toast('초기화했어요.');
}

/* ======================================================================
 * 이벤트 연결
 * ==================================================================== */
function bind() {
  let qTimer;
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); render({ fit: true }); }, 150);
  });
  $('#sortSelect').addEventListener('change', (e) => changeSort(e.target.value, state.sort));

  $('#visitedSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-visited]');
    if (!b) return;
    state.filters.visited = b.dataset.visited;
    document.querySelectorAll('#visitedSeg button').forEach((x) => x.classList.toggle('active', x === b));
    render({ fit: true });
  });

  for (const key of ['region', 'category']) {
    $(`#${key}Chips`).addEventListener('click', (e) => {
      const b = e.target.closest(`button[data-${key}]`);
      if (!b) return;
      state.filters[key] = b.dataset[key];
      buildChips();
      render({ fit: true });
    });
  }

  $('#cardList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.closest('.card').dataset.id;
    const p = findPlace(id);
    if (!p) return;
    switch (btn.dataset.action) {
      case 'visit': openVisitDialog(id); break;
      case 'locate': locateOnMap(id); break;
      case 'edit': openDialog(id); break;
      case 'delete':
        if (confirm(`‘${p.name}’을(를) 삭제할까요?`)) { toast('삭제했어요.'); commitDelete(id); }
        break;
    }
  });

  document.querySelectorAll('.view-toggle button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  // 추가/수정 창
  $('#addBtn').addEventListener('click', () => openDialog());
  $('#cancelBtn').addEventListener('click', () => $('#placeDialog').close());
  $('#placeForm').addEventListener('submit', handleSubmit);
  $('#geocodeBtn').addEventListener('click', geocodeAddress);
  $('#pickBtn').addEventListener('click', () => showPickMap());
  $('#ksBtn').addEventListener('click', runKakaoSearch);
  $('#ksInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runKakaoSearch(); }
  });
  $('#ksResults').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ks]');
    if (b) applyKakaoResult(ksResults[Number(b.dataset.ks)]);
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-settings]')) {
      e.preventDefault();
      if ($('#placeDialog').open) $('#placeDialog').close();
      openSettings();
    }
  });

  // 방문 기록 창
  $('#starInput').addEventListener('click', (e) => {
    const b = e.target.closest('[data-star]');
    if (!b) return;
    const n = Number(b.dataset.star);
    setStars(Number($('#visitForm').elements.rating.value) === n ? 0 : n);
  });
  $('#visitForm').addEventListener('submit', handleVisitSubmit);
  $('#visitCancel').addEventListener('click', () => $('#visitDialog').close());
  $('#unvisitBtn').addEventListener('click', unvisit);

  // 설정 창
  $('#settingsForm').addEventListener('submit', handleSettingsSubmit);
  $('#settingsClose').addEventListener('click', () => $('#settingsDialog').close());
  $('#settingsTest').addEventListener('click', testSettings);

  // 메뉴
  const menu = $('#menu');
  $('#menuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    $('#menuBtn').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => {
    const action = e.target.dataset.menu;
    if (action === 'settings') openSettings();
    if (action === 'refresh') reloadSheet();
    if (action === 'export') exportJSON();
    if (action === 'import') $('#importInput').click();
    if (action === 'reset') resetLocal();
  });
  $('#importInput').addEventListener('change', (e) => {
    if (e.target.files[0]) importJSON(e.target.files[0]);
    e.target.value = '';
  });
  $('#dirtyBadge').addEventListener('click', () => {
    if (state.mode === 'file') exportJSON();
    else if (!sheetToken()) openSettings();
    else flushQueue();
  });
  $('#modePill').addEventListener('click', openSettings);

  $('#notice').addEventListener('click', (e) => {
    if (e.target.closest('[data-pick-base]')) pickBaseFile();
    const mig = e.target.closest('[data-migrate]');
    if (mig) migrateToSheet(pendingMigration);
  });

  // 헤더 높이를 CSS 변수로 (지도 높이 계산용)
  const header = $('#appHeader');
  const setH = () => {
    document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
    if (map) map.invalidateSize();
  };
  new ResizeObserver(setH).observe(header);
  setH();
}

/* ======================================================================
 * 유틸
 * ==================================================================== */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function showNotice(html) {
  const el = $('#notice');
  el.innerHTML = html;
  el.hidden = false;
}

/* ======================================================================
 * 시작
 * ==================================================================== */
let pendingMigration = null;

// 파일 더블클릭(file://)으로 열었을 때: places.json을 직접 골라 읽기
function pickBaseFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        $('#notice').hidden = true;
        setBase(data, file.name);
        try { localStorage.setItem(BASE_CACHE_KEY, JSON.stringify(data)); } catch (e) { /* 무시 */ }
        merge(); buildChips(); render({ fit: true });
        toast(`${file.name}에서 ${state.base.length}곳을 불러왔어요.`);
      } catch (err) {
        toast(`읽기 실패: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

async function fetchPlacesJson() {
  const res = await fetch(DATA_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadFromSheet() {
  try {
    const data = await sheetGet();
    setBase(data, '구글 시트', { quietEmpty: true });
    cacheSheet();
    if (data.length === 0) {
      // 시트가 비었으면 places.json 내용을 옮길지 물어보기
      try {
        const json = await fetchPlacesJson();
        if (Array.isArray(json) && json.length) {
          pendingMigration = json;
          showNotice(`구글 시트가 비어 있어요. places.json에 있던 ${json.length}곳을 시트로 옮길까요? `
            + '<button type="button" class="notice-btn" data-migrate>시트로 옮기기</button>');
        }
      } catch (e) { /* places.json 없음 */ }
    }
  } catch (err) {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(SHEET_CACHE_KEY)); } catch (e) { /* 무시 */ }
    if (Array.isArray(cached)) {
      setBase(cached, '저장된 시트 내용', { quietEmpty: true });
      showNotice(`구글 시트에 연결하지 못해(${esc(err.message)}) 마지막으로 불러온 내용을 보여 주고 있어요. 바꾼 내용은 연결되면 다시 보낼 수 있어요.`);
    } else {
      showNotice(`구글 시트에 연결하지 못했어요 (${esc(err.message)}). ⋯ → 설정에서 URL과 Apps Script 배포 설정을 확인해 주세요.`);
    }
  }
}

async function loadFromJson() {
  const isFile = location.protocol === 'file:';
  try {
    setBase(await fetchPlacesJson());
  } catch (err) {
    state.base = [];
    let cached = null;
    if (isFile) {
      try { cached = JSON.parse(localStorage.getItem(BASE_CACHE_KEY)); } catch (e) { /* 무시 */ }
    }
    if (isFile && Array.isArray(cached)) {
      setBase(cached);
      showNotice('파일을 직접 열어서 지난번에 골랐던 places.json 내용을 보여 주고 있어요. '
        + '<button type="button" class="notice-btn" data-pick-base>places.json 다시 고르기</button>');
    } else if (isFile) {
      showNotice('파일을 더블클릭해서 열면 브라우저가 places.json 자동 읽기를 막아요. '
        + '<button type="button" class="notice-btn" data-pick-base>places.json 직접 고르기</button>'
        + '<br><small>GitHub Pages에 올리면 이 과정 없이 자동으로 읽혀요.</small>');
    } else {
      showNotice(`places.json을 불러오지 못했어요 (${esc(err.message)}). 파일 위치와 JSON 문법을 확인해 주세요.`);
    }
  }
}

async function init() {
  state.mode = sheetUrl() ? 'sheet' : 'file';
  bind();
  updateStatusUI();
  if (state.mode === 'sheet') await loadFromSheet();
  else await loadFromJson();
  merge();
  buildChips();
  render({ fit: true });
  if (state.mode === 'sheet' && localChangeCount() && sheetToken()) flushQueue({ silent: true });
}

document.addEventListener('DOMContentLoaded', init);
