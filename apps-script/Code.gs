/**
 * ระบบกลางสำหรับแบบประเมินผู้สูงอายุ One Page
 * วางโค้ดนี้ใน Google Sheet › ส่วนขยาย › Apps Script แล้ว Deploy เป็น "เว็บแอป"
 * (เรียกใช้ในฐานะ: ฉัน · ผู้มีสิทธิ์เข้าถึง: ทุกคน)
 *
 * ทุกคนที่มีลิงก์แอปบันทึกผลได้ แต่การดูประวัติรวมและการลบต้องใช้รหัสผ่านทีม
 */

// ตั้งรหัสผ่านทีมตรงนี้ (อย่าใช้รหัสง่าย ๆ และห้ามนำโค้ดที่ใส่รหัสแล้วไปเผยแพร่)
const PASSWORD = 'CHANGE_ME';
const SHEET_NAME = 'ผลการประเมิน';

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.action === 'save') return json_(save_(req));
    if (PASSWORD === 'CHANGE_ME' || req.password !== PASSWORD) return json_({ ok: false, error: 'bad_password' });
    if (req.action === 'list') return json_(list_());
    if (req.action === 'delete') return json_(remove_(String(req.id || '')));
    return json_({ ok: false, error: 'bad_action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// เปิด URL ในเบราว์เซอร์เพื่อทดสอบว่า Deploy สำเร็จ
function doGet() {
  return json_({ ok: true, app: 'onepage', sheet: SHEET_NAME });
}

function save_(req) {
  if (!req.id || !Array.isArray(req.row) || typeof req.json !== 'string' || req.json.length > 45000) {
    return { ok: false, error: 'bad_request' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(req.header);
    const row = [String(req.id)].concat(req.row.map(safe_), [req.json]);
    const r = findRow_(sh, String(req.id));
    if (r > 0) {
      // keep the newer version if two devices edit the same record
      try {
        const old = JSON.parse(sh.getRange(r, sh.getLastColumn()).getValue());
        if (old.savedAt && req.savedAt && old.savedAt > req.savedAt) return { ok: true, skipped: true };
      } catch (e) { /* unreadable old row: overwrite */ }
      sh.getRange(r, 1, 1, row.length).setValues([row]);
    } else {
      sh.appendRow(row);
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function list_() {
  const sh = sheet_();
  const n = sh.getLastRow();
  if (n < 2) return { ok: true, records: [] };
  const vals = sh.getRange(2, sh.getLastColumn(), n - 1, 1).getValues();
  const records = [];
  vals.forEach(v => { try { records.push(JSON.parse(v[0])); } catch (e) { /* skip edited/broken rows */ } });
  records.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  return { ok: true, records: records };
}

function remove_(id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_();
    const r = findRow_(sh, id);
    if (r > 0) sh.deleteRow(r);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function sheet_(header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (Array.isArray(header) && sh.getLastRow() === 0) {
    sh.appendRow(header.map(String));
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#ebe8ff');
  }
  return sh;
}

function findRow_(sh, id) {
  const n = sh.getLastRow();
  if (n < 2) return -1;
  const ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return -1;
}

// stop text such as "=..." from running as a spreadsheet formula
function safe_(v) {
  const s = v == null ? '' : String(v);
  return /^[=+@]/.test(s) ? "'" + s : s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
