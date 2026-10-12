/**
 * ระบบกลางสำหรับแบบประเมินผู้สูงอายุ One Page — คลินิกผู้สูงอายุ โรงพยาบาลบ้านกรวด
 * วางโค้ดนี้ใน Google Sheet › ส่วนขยาย › Apps Script แล้ว Deploy เป็น "เว็บแอป"
 * (เรียกใช้ในฐานะ: ฉัน · ผู้มีสิทธิ์เข้าถึง: ทุกคน)
 *
 * - ผู้ใช้ต้องลงทะเบียนและได้รับอนุมัติจากผู้ดูแลก่อนใช้งาน
 * - ผู้ที่ลงทะเบียน "คนแรก" จะเป็นผู้ดูแลระบบ (admin) โดยอัตโนมัติ
 * - รหัสผ่านเก็บแบบ hash + salt ไม่มีการเก็บรหัสจริง
 */

const SHEET_NAME = 'ผลการประเมิน';
const USER_SHEET = 'ผู้ใช้งาน';
const USER_HEAD = ['ชื่อผู้ใช้', 'ชื่อ-สกุล', 'ตำแหน่ง', 'สถานะ', 'สิทธิ์', 'salt', 'hash', 'ลงทะเบียนเมื่อ', 'เข้าใช้ล่าสุด'];
const JSON_HEAD = 'ข้อมูล (JSON)';
const BY_HEAD = 'บันทึกโดย (บัญชี)';
const HASH_ROUNDS = 300;
const MAX_FAILS = 5;          // ใส่รหัสผิดได้กี่ครั้งก่อนล็อก
const LOCK_SECONDS = 15 * 60; // ล็อกนานเท่าไร

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.action === 'register') return json_(withLock_(() => register_(req)));
    if (req.action === 'login') return json_(login_(req));

    const me = auth_(req.token);
    if (!me) return json_({ ok: false, error: 'bad_session' });
    switch (req.action) {
      case 'me': return json_({ ok: true, user: pub_(me) });
      case 'logout': PropertiesService.getScriptProperties().deleteProperty('s_' + req.token); return json_({ ok: true });
      case 'save': return json_(withLock_(() => save_(req, me)));
      case 'list': return json_(list_());
      case 'delete': return json_(withLock_(() => remove_(String(req.id || ''))));
      case 'changePassword': return json_(withLock_(() => changePassword_(req, me)));
    }
    if (me.role !== 'admin') return json_({ ok: false, error: 'forbidden' });
    switch (req.action) {
      case 'users': return json_({ ok: true, users: users_().list.map(pub_) });
      case 'setUser': return json_(withLock_(() => setUser_(req, me)));
      case 'resetPassword': return json_(withLock_(() => resetPassword_(req, me)));
    }
    return json_({ ok: false, error: 'bad_action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// เปิด URL ในเบราว์เซอร์เพื่อทดสอบว่า Deploy สำเร็จ
function doGet() {
  return json_({ ok: true, app: 'onepage', auth: true });
}

/* ---------- accounts ---------- */
function register_(req) {
  const username = String(req.username || '').trim().toLowerCase();
  const name = String(req.name || '').trim();
  const position = String(req.position || '').trim();
  const password = String(req.password || '');
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return { ok: false, error: 'bad_username' };
  if (password.length < 8) return { ok: false, error: 'weak_password' };
  if (!name) return { ok: false, error: 'missing_name' };
  const u = users_();
  if (u.list.some(x => x.username === username)) return { ok: false, error: 'username_taken' };
  const first = u.list.length === 0;
  const salt = token_();
  u.sh.appendRow([username, safe_(name), safe_(position), first ? 'active' : 'pending', first ? 'admin' : 'user',
    salt, hash_(password, salt), new Date(), '']);
  return { ok: true, status: first ? 'active' : 'pending', role: first ? 'admin' : 'user' };
}

function login_(req) {
  const username = String(req.username || '').trim().toLowerCase();
  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + username;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILS) return { ok: false, error: 'locked' };
  const user = users_().list.find(x => x.username === username);
  if (!user || hash_(String(req.password || ''), user.salt) !== user.hash) {
    cache.put(failKey, String(fails + 1), LOCK_SECONDS);
    return { ok: false, error: 'bad_login' };
  }
  cache.remove(failKey);
  if (user.status === 'pending') return { ok: false, error: 'pending' };
  if (user.status !== 'active') return { ok: false, error: 'disabled' };
  const token = token_();
  PropertiesService.getScriptProperties().setProperty('s_' + token, JSON.stringify({ u: username, t: Date.now() }));
  user.sh.getRange(user.row, 9).setValue(new Date());
  return { ok: true, token: token, user: pub_(user) };
}

// คืนข้อมูลผู้ใช้ถ้า token ใช้ได้และบัญชียังเปิดใช้งาน
function auth_(token) {
  if (!token || !/^[a-f0-9]{40,}$/.test(token)) return null;
  const s = PropertiesService.getScriptProperties().getProperty('s_' + token);
  if (!s) return null;
  const user = users_().list.find(x => x.username === JSON.parse(s).u);
  return user && user.status === 'active' ? user : null;
}

function changePassword_(req, me) {
  if (hash_(String(req.oldPassword || ''), me.salt) !== me.hash) return { ok: false, error: 'bad_login' };
  if (String(req.newPassword || '').length < 8) return { ok: false, error: 'weak_password' };
  setPassword_(me, String(req.newPassword));
  return { ok: true };
}

function setUser_(req, me) {
  const user = users_().list.find(x => x.username === String(req.username || ''));
  if (!user) return { ok: false, error: 'not_found' };
  if (user.username === me.username) return { ok: false, error: 'self' };
  if (req.status) {
    if (['active', 'disabled'].indexOf(req.status) < 0) return { ok: false, error: 'bad_request' };
    user.sh.getRange(user.row, 4).setValue(req.status);
    if (req.status === 'disabled') endSessions_(user.username);
  }
  if (req.role) {
    if (['admin', 'user'].indexOf(req.role) < 0) return { ok: false, error: 'bad_request' };
    user.sh.getRange(user.row, 5).setValue(req.role);
  }
  return { ok: true };
}

function resetPassword_(req, me) {
  const user = users_().list.find(x => x.username === String(req.username || ''));
  if (!user) return { ok: false, error: 'not_found' };
  if (String(req.newPassword || '').length < 8) return { ok: false, error: 'weak_password' };
  setPassword_(user, String(req.newPassword));
  endSessions_(user.username);
  return { ok: true };
}

function setPassword_(user, password) {
  const salt = token_();
  user.sh.getRange(user.row, 6, 1, 2).setValues([[salt, hash_(password, salt)]]);
}

function endSessions_(username) {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  Object.keys(all).forEach(k => {
    if (k.indexOf('s_') === 0) { try { if (JSON.parse(all[k]).u === username) props.deleteProperty(k); } catch (e) {} }
  });
}

function users_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(USER_SHEET);
  if (!sh) {
    sh = ss.insertSheet(USER_SHEET);
    sh.appendRow(USER_HEAD);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, USER_HEAD.length).setFontWeight('bold').setBackground('#d4f5e2');
  }
  const n = sh.getLastRow();
  const vals = n > 1 ? sh.getRange(2, 1, n - 1, USER_HEAD.length).getValues() : [];
  const list = vals.map((v, i) => ({
    sh: sh, row: i + 2, username: String(v[0]), name: String(v[1]), position: String(v[2]),
    status: String(v[3]), role: String(v[4]), salt: String(v[5]), hash: String(v[6]),
    created: v[7] ? new Date(v[7]).toISOString() : '', lastLogin: v[8] ? new Date(v[8]).toISOString() : '',
  })).filter(x => x.username);
  return { sh: sh, list: list };
}

function pub_(u) {
  return { username: u.username, name: u.name, position: u.position, status: u.status, role: u.role, created: u.created, lastLogin: u.lastLogin };
}

/* ---------- assessment records ---------- */
function save_(req, me) {
  if (!req.id || !Array.isArray(req.row) || !Array.isArray(req.header) || typeof req.json !== 'string' || req.json.length > 45000) {
    return { ok: false, error: 'bad_request' };
  }
  const rec = JSON.parse(req.json);
  rec.savedBy = me.username;
  rec.savedByName = me.name;
  const json = JSON.stringify(rec);
  const sh = sheet_(req.header);
  const c = cols_(sh);
  // data fills the columns before "บันทึกโดย"; extra values are dropped so the JSON column never moves
  const row = [String(req.id)].concat(req.row.map(safe_)).slice(0, c.by - 1);
  while (row.length < c.by - 1) row.push('');
  row.push(safe_(me.name + ' (' + me.username + ')'));
  while (row.length < c.json - 1) row.push('');
  row.push(json);
  const r = findRow_(sh, String(req.id));
  if (r > 0) {
    // keep the newer version if two devices edit the same record
    try {
      const old = JSON.parse(sh.getRange(r, c.json).getValue());
      if (old.savedAt && req.savedAt && old.savedAt > req.savedAt) return { ok: true, skipped: true };
    } catch (e) { /* unreadable old row: overwrite */ }
    sh.getRange(r, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
  }
  return { ok: true, record: rec };
}

function list_() {
  const sh = sheet_();
  const n = sh.getLastRow();
  if (n < 2) return { ok: true, records: [] };
  const vals = sh.getRange(2, cols_(sh).json, n - 1, 1).getValues();
  const records = [];
  vals.forEach(v => { try { records.push(JSON.parse(v[0])); } catch (e) { /* skip edited/broken rows */ } });
  records.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  return { ok: true, records: records };
}

function remove_(id) {
  const sh = sheet_();
  const r = findRow_(sh, id);
  if (r > 0) sh.deleteRow(r);
  return { ok: true };
}

// sheet layout: ID, ...data columns, บันทึกโดย, ข้อมูล (JSON)  — the JSON column is always last
function sheet_(header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (!Array.isArray(header)) return sh;
  const want = header.map(String).filter(x => x !== JSON_HEAD);
  if (sh.getLastRow() > 0) {
    // the app's columns changed (e.g. name/HN replaced by EL): keep the old sheet as an archive and start a new one
    const have = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String).filter(x => x !== JSON_HEAD && x !== BY_HEAD);
    if (have.join('|') === want.join('|')) return sh;
    sh.setName(SHEET_NAME + ' (เดิม ' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH.mm') + ')');
    sh = ss.insertSheet(SHEET_NAME);
  }
  const h = want.concat([BY_HEAD, JSON_HEAD]);
  sh.appendRow(h);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, h.length).setFontWeight('bold').setBackground('#ebe8ff');
  return sh;
}

// positions (1-based) of the "บันทึกโดย" and JSON columns, read from the header row
function cols_(sh) {
  const head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
  const json = head.lastIndexOf(JSON_HEAD) + 1 || head.length;
  const by = head.indexOf(BY_HEAD) + 1 || json;
  return { by: by, json: json };
}

function findRow_(sh, id) {
  const n = sh.getLastRow();
  if (n < 2) return -1;
  const ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return -1;
}

/* ---------- helpers ---------- */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function hash_(password, salt) {
  let h = salt + ':' + password;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    h = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function hex_(bytes) {
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function token_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
}

// stop text such as "=..." from running as a spreadsheet formula
function safe_(v) {
  const s = v == null ? '' : String(v);
  return /^[=+@-]/.test(s) && !/^-?\d/.test(s) ? "'" + s : s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
