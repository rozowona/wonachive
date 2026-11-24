/* 장소 아카이브 — 정적 웹 프로토타입
 * - places.json을 불러와 카드/지도로 표시
 * - 추가·수정·삭제·방문 체크는 브라우저(localStorage)에 "변경분"으로 저장
 * - "JSON 내보내기"로 합쳐진 최종 places.json을 받아 저장소에 덮어쓰면 반영 완료
 */

const DATA_URL = 'places.json';
const STORAGE_KEY = 'place-archive:v1';
const REGIONS = ['서울', '경기', '부산', '제주', '경주', '강릉'];
const CATEGORIES = ['카페', '밥집', '전시/문화', '도서관/작업', '데이트', '공방'];
const DEFAULT_CENTER = [36.5, 127.8]; // 대한민국 전체
const COLORS = { todo: '#BF092F', done: '#3B9797' };

const state = {
  base: [],            // places.json 원본
  local: loadLocal(),  // { items: {id: place}, deleted: [id] }
  places: [],          // 원본 + 변경분 합친 결과
  filters: { q: '', region: '전체', category: '전체', visited: 'all' },
  sort: 'recent',
  view: 'list',
  editingId: null,
};

let map = null;
let markerLayer = null;
const markers = new Map();

const $ = (sel) => document.querySelector(sel);

/* ---------- 저장소 ---------- */
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
  updateDirtyBadge();
}

function localChangeCount() {
  return Object.keys(state.local.items).length + state.local.deleted.length;
}

/* ---------- 데이터 ---------- */
function normalize(p) {
  const num = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));
  return {
    id: String(p.id ?? ''),
    name: String(p.name ?? '').trim(),
    region: String(p.region ?? '').trim(),
    sub_region: String(p.sub_region ?? '').trim(),
    category: String(p.category ?? '').trim(),
    tags: Array.isArray(p.tags) ? p.tags.map(String).filter(Boolean)
      : String(p.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    memo: String(p.memo ?? ''),
    kakaomap_url: String(p.kakaomap_url ?? ''),
    instagram_url: String(p.instagram_url ?? ''),
    lat: num(p.lat),
    lng: num(p.lng),
    visited: Boolean(p.visited),
    added_at: String(p.added_at ?? ''),
  };
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

function removePlace(id) {
  delete state.local.items[id];
  if (isInBase(id) && !state.local.deleted.includes(id)) state.local.deleted.push(id);
  saveLocal();
  merge();
}

/* ---------- 필터 ---------- */
function matches(p) {
  const f = state.filters;
  if (f.region !== '전체' && p.region !== f.region) return false;
  if (f.category !== '전체' && p.category !== f.category) return false;
  if (f.visited === 'todo' && p.visited) return false;
  if (f.visited === 'done' && !p.visited) return false;
  if (f.q) {
    const hay = [p.name, p.region, p.sub_region, p.category, p.memo, ...p.tags].join(' ').toLowerCase();
    const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.every((t) => hay.includes(t.replace(/^#/, '')))) return false;
  }
  return true;
}

function sorted(list) {
  const arr = [...list];
  if (state.sort === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  else if (state.sort === 'region') arr.sort((a, b) => (a.region + a.sub_region).localeCompare(b.region + b.sub_region, 'ko') || a.name.localeCompare(b.name, 'ko'));
  else arr.sort((a, b) => b.added_at.localeCompare(a.added_at));
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
  $('#categorySelect').innerHTML = unionWithData(CATEGORIES, 'category').map((c) => `<option>${esc(c)}</option>`).join('');
}

/* ---------- 링크 ---------- */
function validUrl(u) {
  return /^https?:\/\//i.test(u) && !/\.\.\.$/.test(u) ? u : '';
}

function kakaoLink(p) {
  const u = validUrl(p.kakaomap_url);
  if (u) return u;
  if (p.lat != null && p.lng != null) return `https://map.kakao.com/link/map/${encodeURIComponent(p.name)},${p.lat},${p.lng}`;
  return `https://map.kakao.com/link/search/${encodeURIComponent([p.sub_region, p.name].filter(Boolean).join(' '))}`;
}

function kakaoRouteLink(p) {
  if (p.lat == null || p.lng == null) return '';
  return `https://map.kakao.com/link/to/${encodeURIComponent(p.name)},${p.lat},${p.lng}`;
}

/* ---------- 렌더링 ---------- */
function render({ fit = false } = {}) {
  const list = visiblePlaces();
  const total = state.places.length;
  const visitedCount = state.places.filter((p) => p.visited).length;
  $('#resultCount').textContent = `${list.length}곳 표시 · 전체 ${total}곳 (가본 곳 ${visitedCount}) · places.json ${state.base.length}곳`;

  $('#cardList').innerHTML = list.map(cardHTML).join('');
  $('#emptyMsg').hidden = list.length > 0;
  $('#emptyMsg').textContent = total === 0
    ? '아직 장소가 없어요. places.json에 장소를 넣거나 ＋ 버튼으로 추가해 보세요.'
    : '조건에 맞는 장소가 없어요. 필터를 ‘전체’로 바꿔 보세요.';
  renderMarkers(list, fit);
  updateDirtyBadge();
}

function cardHTML(p) {
  const loc = [p.region, p.sub_region].filter(Boolean).join(' · ');
  const insta = validUrl(p.instagram_url);
  const route = kakaoRouteLink(p);
  const hasCoord = p.lat != null && p.lng != null;
  const isLocal = !!state.local.items[p.id];
  return `
  <li class="card${p.visited ? ' visited' : ''}" data-id="${esc(p.id)}">
    <div class="card-head">
      <div>
        <h3 class="card-title">${esc(p.name)}${isLocal ? '<span class="local-mark">· 브라우저 저장</span>' : ''}</h3>
        <div class="card-loc">${esc(loc)}</div>
      </div>
      <button class="visit-btn" data-action="toggle-visited" aria-pressed="${p.visited}">
        ${p.visited ? '✓ 가본 곳' : '가볼 곳'}
      </button>
    </div>
    <div class="tag-row">
      ${p.category ? `<span class="tag cat">${esc(p.category)}</span>` : ''}
      ${p.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}
    </div>
    ${p.memo ? `<p class="memo">${esc(p.memo)}</p>` : ''}
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

function updateDirtyBadge() {
  const n = localChangeCount();
  const badge = $('#dirtyBadge');
  badge.hidden = n === 0;
  badge.textContent = `저장 안 된 변경 ${n}건 · 내보내기`;
}

/* ---------- 지도 (Leaflet + OpenStreetMap) ---------- */
function initMap() {
  if (map || !window.L) return;
  map = L.map('map', { zoomControl: true }).setView(DEFAULT_CENTER, 7);
  // 지도 타일: 웹 주소(GitHub Pages, localhost)로 열면 CARTO,
  // 파일 더블클릭(file://)으로 열면 요청 출처가 비어 CARTO·OSM이 막으므로 Esri 타일 사용
  if (location.protocol === 'file:') {
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri',
    }).addTo(map);
  } else {
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 20,
      subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
  }
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
  if (fit) {
    if (pts.length === 1) map.setView(pts[0], 13);
    else if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
  }
}

function popupHTML(p) {
  const insta = validUrl(p.instagram_url);
  const route = kakaoRouteLink(p);
  return `
    <div class="pop-title">${esc(p.name)}</div>
    <div class="pop-sub">${esc([p.sub_region || p.region, p.category].filter(Boolean).join(' · '))}${p.visited ? ' · 가본 곳' : ''}</div>
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

/* ---------- 추가 / 수정 ---------- */
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
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = Array.isArray(v) ? v.join(', ') : (v ?? '');
    }
  } else if (state.filters.region !== '전체') {
    form.elements.region.value = state.filters.region;
    if (state.filters.category !== '전체') form.elements.category.value = state.filters.category;
  }
  $('#placeDialog').showModal();
}

function handleSubmit(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const editing = state.editingId ? findPlace(state.editingId) : null;
  const insta = String(f.get('instagram_url') || '').trim();

  let id = editing?.id;
  if (!id) {
    id = instagramId(insta) || `local-${Date.now().toString(36)}`;
    if (findPlace(id)) {
      toast('같은 인스타 게시물로 저장된 장소가 이미 있어요.');
      return;
    }
  }

  const place = normalize({
    id,
    name: f.get('name'),
    region: f.get('region'),
    sub_region: f.get('sub_region'),
    category: f.get('category'),
    tags: f.get('tags'),
    memo: f.get('memo'),
    kakaomap_url: String(f.get('kakaomap_url') || '').trim(),
    instagram_url: insta,
    lat: f.get('lat'),
    lng: f.get('lng'),
    visited: f.get('visited') === 'on',
    added_at: editing?.added_at || today(),
  });

  upsertLocal(place);
  $('#placeDialog').close();
  buildChips();
  render({ fit: !editing });
  toast(editing ? '수정했어요.' : '추가했어요. 브라우저에 저장됐어요.');
}

/* ---------- 내보내기 / 가져오기 / 초기화 ---------- */
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
  toast('places.json을 내려받았어요. 저장소의 파일을 이걸로 교체하세요.');
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
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
      if (!confirm(`${Object.keys(items).length}곳을 가져와 현재 목록을 대체할까요?`)) return;
      state.local = { items, deleted: state.base.map((p) => String(p.id)).filter((id) => !items[id]) };
      saveLocal();
      merge();
      buildChips();
      render({ fit: true });
      toast('가져오기 완료.');
    } catch (err) {
      toast(`가져오기 실패: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function resetLocal() {
  if (!confirm('브라우저에 저장된 추가·수정·방문 체크를 모두 지우고 places.json 상태로 돌아갈까요?')) return;
  state.local = { items: {}, deleted: [] };
  saveLocal();
  merge();
  buildChips();
  render({ fit: true });
  toast('초기화했어요.');
}

/* ---------- 이벤트 ---------- */
function bind() {
  let qTimer;
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); render({ fit: true }); }, 150);
  });
  $('#sortSelect').addEventListener('change', (e) => { state.sort = e.target.value; render(); });

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
      case 'toggle-visited':
        upsertLocal({ ...p, visited: !p.visited });
        render();
        toast(!p.visited ? `‘${p.name}’ 가본 곳으로 체크!` : `‘${p.name}’ 가볼 곳으로 되돌렸어요.`);
        break;
      case 'locate': locateOnMap(id); break;
      case 'edit': openDialog(id); break;
      case 'delete':
        if (confirm(`‘${p.name}’을(를) 삭제할까요?`)) { removePlace(id); buildChips(); render(); }
        break;
    }
  });

  document.querySelectorAll('.view-toggle button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  $('#addBtn').addEventListener('click', () => openDialog());
  $('#cancelBtn').addEventListener('click', () => $('#placeDialog').close());
  $('#placeForm').addEventListener('submit', handleSubmit);

  const menu = $('#menu');
  $('#menuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    $('#menuBtn').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => {
    const action = e.target.dataset.menu;
    if (action === 'export') exportJSON();
    if (action === 'import') $('#importInput').click();
    if (action === 'reset') resetLocal();
  });
  $('#importInput').addEventListener('change', (e) => {
    if (e.target.files[0]) importJSON(e.target.files[0]);
    e.target.value = '';
  });
  $('#dirtyBadge').addEventListener('click', exportJSON);

  // 헤더 높이를 CSS 변수로 (지도 높이 계산용)
  const header = $('#appHeader');
  const setH = () => {
    document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
    if (map) map.invalidateSize();
  };
  new ResizeObserver(setH).observe(header);
  setH();
}

/* ---------- 유틸 ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function showNotice(html) {
  const el = $('#notice');
  el.innerHTML = html;
  el.hidden = false;
}

/* ---------- 시작 ---------- */
const BASE_CACHE_KEY = 'place-archive:base-cache';

// places.json 배열을 원본 데이터로 등록 (id 없는 항목은 자동 id 부여)
function setBase(data, sourceLabel = 'places.json') {
  if (!Array.isArray(data)) throw new Error('places.json은 배열이어야 해요');
  state.base = data.filter((p) => p && typeof p === 'object' && p.name).map((p) => ({
    ...p,
    id: p.id != null && p.id !== '' ? String(p.id)
      : instagramId(p.instagram_url || '') || `auto-${p.name}-${p.region || ''}`,
  }));
  if (data.length === 0) {
    showNotice(`${sourceLabel}은 불러왔지만 장소가 하나도 없어요. 파일 내용을 확인해 주세요.`);
  } else if (state.base.length < data.length) {
    showNotice(`${sourceLabel}의 ${data.length}개 항목 중 ${data.length - state.base.length}개는 <code>name</code>이 없어 건너뛰었어요.`);
  }
}

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
        merge();
        buildChips();
        render({ fit: true });
        toast(`${file.name}에서 ${state.base.length}곳을 불러왔어요.`);
      } catch (err) {
        toast(`읽기 실패: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

async function init() {
  const isFile = location.protocol === 'file:';
  try {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setBase(await res.json());
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
  $('#notice').addEventListener('click', (e) => {
    if (e.target.closest('[data-pick-base]')) pickBaseFile();
  });
  merge();
  buildChips();
  bind();
  render({ fit: true });
}

document.addEventListener('DOMContentLoaded', init);
