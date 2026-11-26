/**
 * One-off importer: the "Clinic Sign offs" and "Practicals" tabs of the legacy
 * Year 1 Clinical Hours workbook (e.g. "0. 2026 MAud Year 1 Clinical Hours.xlsx")
 * → SignoffItems / Signoffs / Practicals / Attendance (see Signoffs.gs).
 *
 * HOW TO RUN (no code edits — the online editor's code is replaced by every clasp push)
 *   1. Upload the .xlsx to Google Drive (or use an existing Google Sheets copy).
 *   2. Copy its file ID from the URL (…/d/<FILE_ID>/…).
 *   3. Apps Script editor → Project Settings (⚙) → Script properties → add
 *        LEGACY_SIGNOFFS_FILE_ID = <FILE_ID>
 *        LEGACY_SIGNOFFS_COHORT  = 2026
 *   4. Editor → select runLegacySignoffsImport → Run. Check the execution log.
 *
 * Safe to re-run: practicals are matched on cohort + date + title, sign-off items on
 * cohort + category + name, and existing attendance / sign-off records are never
 * overwritten or duplicated.
 */

function runLegacySignoffsImport() {
  var props = PropertiesService.getScriptProperties();
  var fileId = props.getProperty('LEGACY_SIGNOFFS_FILE_ID');
  var cohort = props.getProperty('LEGACY_SIGNOFFS_COHORT');
  if (!fileId || !cohort) throw new Error('Set the LEGACY_SIGNOFFS_FILE_ID and LEGACY_SIGNOFFS_COHORT script properties first (Project Settings → Script properties).');
  importLegacySignoffs(fileId, cohort);
}

function importLegacySignoffs(fileId, cohort) {
  if (!fileId) throw new Error('fileId is required.');
  cohort = String(cohort);
  var file = DriveApp.getFileById(fileId);
  var tempId = null, book;
  if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
    book = SpreadsheetApp.openById(fileId);
  } else {
    var converted = Drive.Files.insert({ title: '_temp_legacy_signoffs', mimeType: MimeType.GOOGLE_SHEETS }, file.getBlob(), { convert: true });
    tempId = converted.id;
    book = SpreadsheetApp.openById(tempId);
  }
  try {
    var students = lsiStudentIndex_(cohort);
    var log = [];
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var pr = book.getSheetByName('Practicals');
      if (pr) lsiImportPracticals_(pr, cohort, students, log); else log.push('No "Practicals" tab found.');
      var so = book.getSheetByName('Clinic Sign offs') || book.getSheetByName('Clinical Sign offs');
      if (so) lsiImportSignoffs_(so, cohort, students, log); else log.push('No "Clinic Sign offs" tab found.');
    } finally {
      lock.releaseLock();
    }
    bumpDataVersion();
    Logger.log(log.join('\n'));
    return log;
  } finally {
    if (tempId) DriveApp.getFileById(tempId).setTrashed(true);
  }
}

/** normalised name → studentId for the cohort */
function lsiStudentIndex_(cohort) {
  var idx = {};
  (getStudents(cohort).students || []).forEach(function (s) { idx[lsiNorm_(s.name)] = s.id; });
  return idx;
}
function lsiNorm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function lsiDate_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return bpiLooseDate(String(v || ''));
}
function lsiRowIndex_(data, label) {
  for (var i = 0; i < data.length; i++) if (lsiNorm_(data[i][0]) === lsiNorm_(label)) return i;
  return -1;
}

function lsiImportPracticals_(sheet, cohort, students, log) {
  var tz = Session.getScriptTimeZone();
  var data = sheet.getDataRange().getValues();
  var rDate = lsiRowIndex_(data, 'Date'), rHours = lsiRowIndex_(data, 'Hours'), rBy = lsiRowIndex_(data, 'Signed off by');
  if (rDate < 0 || rHours < 0) { log.push('Practicals: could not find the Date / Hours rows.'); return; }
  var rTitle = rDate + 1;
  var firstStudentRow = (rBy >= 0 ? rBy : rHours) + 1;

  // Existing practicals for this cohort (re-run safety)
  var existing = {};
  soRows_('Practicals').forEach(function (r) {
    if (String(r[1]) === cohort) existing[soDate_(r[2]) + '|' + lsiNorm_(r[3])] = String(r[0]);
  });
  var haveAtt = {};
  soRows_('Attendance').forEach(function (r) { haveAtt[String(r[0]) + '|' + String(r[1])] = true; });

  var newPracs = [], attRows = [], created = 0, reused = 0, unmatched = {};
  var now = new Date();
  for (var c = 1; c < data[rTitle].length; c++) {
    var title = String(data[rTitle][c] || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    var rawDate = data[rDate][c];
    var date = lsiDate_(rawDate, tz);
    if (!(rawDate instanceof Date) && rawDate) title += ' [' + String(rawDate).trim() + ']';
    var key = date + '|' + lsiNorm_(title);
    var pid = existing[key];
    if (pid) reused++;
    else {
      pid = soId_('PRC-');
      existing[key] = pid;
      newPracs.push(soPracToRow_({ id: pid, cohort: cohort, date: date, title: title, hours: Number(data[rHours][c]) || 0,
        facilitator: rBy >= 0 ? String(data[rBy][c] || '').trim() : '', compulsory: true, sortOrder: c, active: true }));
      created++;
    }
    for (var r = firstStudentRow; r < data.length; r++) {
      var name = String(data[r][0] || '').trim();
      if (!name || /^last updated/i.test(name)) break;
      var v = String(data[r][c] == null ? '' : data[r][c]).trim().toUpperCase();
      if (v !== 'Y' && v !== 'N' && v !== 'TRUE' && v !== 'FALSE') continue;
      var sid = students[lsiNorm_(name)];
      if (!sid) { unmatched[name] = true; continue; }
      if (haveAtt[pid + '|' + sid]) continue;
      haveAtt[pid + '|' + sid] = true;
      attRows.push([pid, sid, (v === 'Y' || v === 'TRUE') ? 'Attended' : 'Absent', 'Imported from legacy workbook', 'legacy import', now]);
    }
  }
  if (newPracs.length) { var ps = soSheet_('Practicals'); ps.getRange(ps.getLastRow() + 1, 1, newPracs.length, SO_HEADERS.Practicals.length).setValues(newPracs); }
  if (attRows.length) { var as = soSheet_('Attendance'); as.getRange(as.getLastRow() + 1, 1, attRows.length, SO_HEADERS.Attendance.length).setValues(attRows); }
  log.push('Practicals: ' + created + ' created, ' + reused + ' already existed; ' + attRows.length + ' attendance rows added.');
  var um = Object.keys(unmatched);
  if (um.length) log.push('Practicals: names not in the ' + cohort + ' Students tab (skipped): ' + um.join(', '));
}

/**
 * Sign-off header: row with "Skill" in column A holds the skill names; the row above holds
 * category groups (merged across their columns). "(n)" in a name, or a header merged across
 * n columns, means n sign-offs are required — one cell per instance.
 */
var LSI_PLACEMENT_MATCH = {
  'setting up rems testbox': 'Setting up REMs',
  'appropriate ha selection': 'Appropriate Hearing Aid selection',
  'ha fitting': 'Hearing Aid Fitting'
};

function lsiImportSignoffs_(sheet, cohort, students, log) {
  var data = sheet.getDataRange().getValues();
  var rSkill = lsiRowIndex_(data, 'Skill');
  if (rSkill < 1) { log.push('Sign-offs: could not find the "Skill" header row.'); return; }
  var rCat = rSkill - 1;
  var width = data[rSkill].length;

  // Merge widths of header cells (merged cells read blank after the first column)
  var mergeW = {};
  sheet.getRange(rSkill + 1, 1, 1, width).getMergedRanges().forEach(function (m) { mergeW[m.getColumn() - 1] = m.getNumColumns(); });

  var existing = {}, maxOrder = 0;
  soRows_('SignoffItems').forEach(function (r) {
    maxOrder = Math.max(maxOrder, Number(r[7]) || 0);
    if (String(r[1]) === cohort) existing[lsiNorm_(r[2]) + '|' + lsiNorm_(r[3])] = String(r[0]);
  });
  var have = {};
  soRows_('Signoffs').forEach(function (r) { if (String(r[7]) === 'LEGACY') have[String(r[1]) + '|' + String(r[2]) + '|' + String(r[8])] = true; });

  var items = [], recs = [], created = 0, reused = 0, unmatched = {}, category = '', now = new Date();
  for (var c = 1; c < width; c++) {
    if (String(data[rCat][c] || '').trim()) category = lsiCategory_(String(data[rCat][c]));
    var rawName = String(data[rSkill][c] || '').replace(/\s+/g, ' ').trim();
    if (!rawName) continue;
    var m = rawName.match(/\((\d+)\)/);
    var span = mergeW[c] || 1;
    var required = m ? Number(m[1]) : span;
    var optional = /not\s+comp/i.test(rawName);
    var name = rawName.replace(/\((\d+)\)/, '').replace(/\(not\s+comp\w*\)/i, '').replace(/\s+/g, ' ').trim();
    var key = lsiNorm_(category) + '|' + lsiNorm_(name);
    var id = existing[key];
    if (id) reused++;
    else {
      id = soId_('SOI-');
      existing[key] = id;
      var isPracticum = /practicum/i.test(category);
      items.push(soItemToRow_({ id: id, cohort: cohort, category: category, name: name, description: '', requiredCount: required,
        optional: optional, sortOrder: ++maxOrder, active: true,
        placementMatch: isPracticum ? (LSI_PLACEMENT_MATCH[lsiNorm_(name)] || '') : '' }));
      created++;
    }
    // Y / ticked cells across the item's columns → one Competent record each
    for (var r = rSkill + 1; r < data.length; r++) {
      var stu = String(data[r][0] || '').trim();
      if (!stu || /^notes$/i.test(stu)) break;
      for (var k = 0; k < span; k++) {
        var v = data[r][c + k];
        var pass = v === true || /^(y|yes|true)$/i.test(String(v == null ? '' : v).trim());
        if (!pass) continue;
        var sid = students[lsiNorm_(stu)];
        if (!sid) { unmatched[stu] = true; continue; }
        var note = 'Imported from legacy workbook (#' + (k + 1) + ')';
        if (have[id + '|' + sid + '|' + note]) continue;
        have[id + '|' + sid + '|' + note] = true;
        recs.push([soId_('SGN-'), id, sid, '', 'Competent', '', '', 'LEGACY', note, 'legacy import', now]);
      }
    }
    c += span - 1;
  }
  if (items.length) { var is = soSheet_('SignoffItems'); is.getRange(is.getLastRow() + 1, 1, items.length, SO_HEADERS.SignoffItems.length).setValues(items); }
  if (recs.length) { var rs = soSheet_('Signoffs'); rs.getRange(rs.getLastRow() + 1, 1, recs.length, SO_HEADERS.Signoffs.length).setValues(recs); }
  log.push('Sign-offs: ' + created + ' items created, ' + reused + ' already existed; ' + recs.length + ' sign-off records added.');
  var um = Object.keys(unmatched);
  if (um.length) log.push('Sign-offs: names not in the ' + cohort + ' Students tab (skipped): ' + um.join(', '));
}

/** Tidies the workbook's group headings into category names. */
function lsiCategory_(s) {
  s = s.replace(/\s+/g, ' ').trim();
  if (/paediatric/i.test(s)) return 'Practicum – Paediatric';
  if (/adult/i.test(s)) return 'Practicum – Adult';
  if (/yr ?2|year 2/i.test(s)) return 'Year 2 – UoA Clinic';
  return s;
}
