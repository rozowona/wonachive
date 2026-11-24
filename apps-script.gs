/**
 * wonachive — 구글 시트 동기화용 Apps Script
 *
 * 사용법 (자세한 순서는 SETUP.md)
 *  1. 구글 시트를 새로 만들고 [확장 프로그램] → [Apps Script]를 연다
 *  2. 기본으로 있는 코드를 지우고 이 파일 내용을 통째로 붙여 넣는다
 *  3. 아래 TOKEN을 나만 아는 비밀번호로 바꾼다 (앱 설정의 비밀번호와 똑같이)
 *  4. [배포] → [새 배포] → 유형: 웹 앱 / 실행: 나 / 액세스 권한: 모든 사용자 → 배포
 *  5. 나온 웹 앱 URL(…/exec)을 앱의 config.js 또는 ⋯ → 설정에 넣는다
 *
 * 코드를 고친 뒤에는 [배포] → [배포 관리] → 연필 → 버전: 새 버전 → 배포 해야 반영돼요.
 */

const TOKEN = '여기에-나만의-비밀번호';   // ← 꼭 바꾸기!
const SHEET_NAME = 'places';
const HEADERS = [
  'id', 'name', 'region', 'sub_region', 'address', 'category', 'tags', 'memo',
  'kakaomap_url', 'instagram_url', 'lat', 'lng',
  'visited', 'added_at', 'visited_at', 'rating', 'review',
];

/* ---------- 읽기: 누구나 (places.json처럼 공개) ---------- */
function doGet() {
  return json_(readAll_());
}

/* ---------- 쓰기: 비밀번호가 맞을 때만 ---------- */
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad request' });
  }
  if (!TOKEN || TOKEN === '여기에-나만의-비밀번호' || body.token !== TOKEN) {
    return json_({ ok: false, error: 'unauthorized' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    switch (body.action) {
      case 'ping':
        return json_({ ok: true });
      case 'upsert':
        upsert_(body.place);
        return json_({ ok: true });
      case 'delete':
        delete_(String(body.id));
        return json_({ ok: true });
      case 'replaceAll':
        replaceAll_(body.places || []);
        return json_({ ok: true, count: (body.places || []).length });
      default:
        return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 내부 함수 ---------- */
function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// 1행 머리글 읽기 (빠진 열은 뒤에 추가 → 열 순서를 바꿔도 동작)
function headers_(sh) {
  const width = Math.max(sh.getLastColumn(), 1);
  const h = sh.getRange(1, 1, 1, width).getValues()[0].map(String);
  HEADERS.forEach(function (name) {
    if (h.indexOf(name) === -1) {
      const col = h.filter(String).length + 1;
      sh.getRange(1, col).setValue(name).setFontWeight('bold');
      h[col - 1] = name;
    }
  });
  return h;
}

function tz_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
}

function cellOut_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  return v;
}

// 시트에 쓸 값: 수식으로 오해받을 글자(= + - @)로 시작하면 앞에 ' 를 붙임
function cellIn_(key, v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) v = v.join(', ');
  if (key === 'visited') return v === true || String(v).toLowerCase() === 'true';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function readAll_() {
  const sh = sheet_();
  const h = headers_(sh);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const idCol = h.indexOf('id');
  const nameCol = h.indexOf('name');
  const rows = sh.getRange(2, 1, n, h.length).getValues();
  const out = [];
  rows.forEach(function (r, i) {
    if (String(r[nameCol]).trim() === '') return;
    // 시트에서 직접 추가한 줄에 id가 없으면 만들어 줌
    if (String(r[idCol]).trim() === '') {
      r[idCol] = 's-' + Utilities.getUuid().slice(0, 8);
      sh.getRange(i + 2, idCol + 1).setValue(r[idCol]);
    }
    const o = {};
    h.forEach(function (k, c) { if (k) o[k] = cellOut_(r[c]); });
    out.push(o);
  });
  return out;
}

function findRow_(sh, h, id) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return -1;
  const ids = sh.getRange(2, h.indexOf('id') + 1, n, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === id) return i + 2;
  }
  return -1;
}

function upsert_(place) {
  if (!place || !place.id) throw new Error('id 없음');
  const sh = sheet_();
  const h = headers_(sh);
  const row = h.map(function (k) { return k ? cellIn_(k, place[k]) : ''; });
  const r = findRow_(sh, h, String(place.id));
  if (r > 0) sh.getRange(r, 1, 1, h.length).setValues([row]);
  else sh.appendRow(row);
}

function delete_(id) {
  const sh = sheet_();
  const h = headers_(sh);
  const r = findRow_(sh, h, id);
  if (r > 0) sh.deleteRow(r);
}

function replaceAll_(places) {
  const sh = sheet_();
  const h = headers_(sh);
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 1, n, h.length).clearContent();
  if (!places.length) return;
  const rows = places.map(function (p) {
    return h.map(function (k) { return k ? cellIn_(k, p[k]) : ''; });
  });
  sh.getRange(2, 1, rows.length, h.length).setValues(rows);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
