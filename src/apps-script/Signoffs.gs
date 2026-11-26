/**
 * Clinical sign-offs and practical attendance.
 *
 * Four tabs, created on first use if missing (see docs/SHEET_SETUP.md):
 *   SignoffItems — the required sign-offs for a cohort (editable by any supervisor)
 *   Signoffs     — one row per sign-off instance a student was given
 *   Practicals   — the practical / tutorial sessions for a cohort
 *   Attendance   — one row per practical + student
 *
 * Sign-off status is never stored: a requirement is complete when a student has
 * at least RequiredCount 'Competent' records, so changing RequiredCount simply
 * re-evaluates everyone.
 *
 * GET  ?action=signoffs_cohort&cohort=…   — supervisor: everything for a cohort
 * GET  ?action=signoffs&student=…         — student (own) or supervisor: one student
 * POST saveSignoffItems   { items:[…] }               — create/update (bulk, also used for reordering)
 * POST deleteSignoffItem  { itemId }                  — refused if any record uses it
 * POST recordSignoff      { record:{…} }
 * POST deleteSignoffRecord{ recordId }
 * POST savePracticals     { practicals:[…] }
 * POST deletePractical    { practicalId }             — refused if attendance exists
 * POST setAttendance      { practicalId, statuses:{studentId: 'Attended'|'Absent'|'Excused'|''} }
 */

var SO_HEADERS = {
  SignoffItems: ['ItemID', 'Cohort', 'Category', 'Name', 'Description', 'RequiredCount', 'Optional', 'SortOrder', 'Active', 'PlacementMatch'],
  Signoffs:     ['RecordID', 'ItemID', 'StudentID', 'Date', 'Level', 'SignedBy', 'Location', 'Source', 'Notes', 'RecordedBy', 'Timestamp'],
  Practicals:   ['PracticalID', 'Cohort', 'Date', 'Title', 'Hours', 'Facilitator', 'Compulsory', 'SortOrder', 'Active'],
  Attendance:   ['PracticalID', 'StudentID', 'Status', 'Note', 'RecordedBy', 'Timestamp']
};
var SO_LEVELS = ['Exposure', 'Emerging', 'Competent'];
var SO_ATTENDANCE = ['Attended', 'Absent', 'Excused'];

/* ===== Sheet helpers ===== */

function soSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    var h = SO_HEADERS[name];
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  soCheckHeader_(sh, name);
  return sh;
}

/**
 * Refuses to read or write a same-named tab with a different layout (e.g. a pasted copy
 * of the legacy Excel "Practicals" grid), rather than silently mangling it.
 */
function soCheckHeader_(sh, name) {
  var h = SO_HEADERS[name];
  var row = sh.getRange(1, 1, 1, h.length).getValues()[0];
  for (var i = 0; i < h.length; i++) {
    if (String(row[i]).trim() !== h[i]) {
      throw new Error('The "' + name + '" tab does not have the expected header row (' + h.join(' | ') +
        '). Rename that tab so a fresh one can be created — see docs/SHEET_SETUP.md.');
    }
  }
}

/** Data rows (no header) padded to the tab's width; [] if the tab doesn't exist yet. */
function soRows_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (sh) soCheckHeader_(sh, name);
  if (!sh || sh.getLastRow() < 2) return [];
  var w = SO_HEADERS[name].length;
  return sh.getRange(2, 1, sh.getLastRow() - 1, w).getValues();
}

function soBool_(v, dflt) {
  if (v === '' || v == null) return !!dflt;
  return v === true || /^(true|yes|y|1)$/i.test(String(v).trim());
}

function soDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v || '').trim();
}

function soId_(prefix) {
  return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase();
}

/** Text cell value; a leading apostrophe stops Sheets turning e.g. '2026-03-04' into a Date. */
function soText_(v) { return sanitizeSheetText(v == null ? '' : String(v)); }
function soDateCell_(s) { return s ? "'" + String(s) : ''; }

function soItemFromRow_(r) {
  return {
    id: String(r[0]), cohort: String(r[1]), category: String(r[2] || ''), name: String(r[3] || ''),
    description: String(r[4] || ''), requiredCount: Math.max(1, Number(r[5]) || 1),
    optional: soBool_(r[6], false), sortOrder: Number(r[7]) || 0, active: soBool_(r[8], true),
    placementMatch: String(r[9] || '')
  };
}
function soItemToRow_(it) {
  return [it.id, String(it.cohort), soText_(it.category), soText_(it.name), soText_(it.description),
    Math.max(1, Math.round(Number(it.requiredCount) || 1)), !!it.optional, Number(it.sortOrder) || 0,
    it.active !== false, soText_(it.placementMatch)];
}
function soPracFromRow_(r) {
  return {
    id: String(r[0]), cohort: String(r[1]), date: soDate_(r[2]), title: String(r[3] || ''),
    hours: Number(r[4]) || 0, facilitator: String(r[5] || ''), compulsory: soBool_(r[6], true),
    sortOrder: Number(r[7]) || 0, active: soBool_(r[8], true)
  };
}
function soPracToRow_(p) {
  return [p.id, String(p.cohort), soDateCell_(p.date), soText_(p.title), Number(p.hours) || 0,
    soText_(p.facilitator), p.compulsory !== false, Number(p.sortOrder) || 0, p.active !== false];
}
/** Empty optional fields are left out to keep the cached cohort payload small. */
function soRecFromRow_(r) {
  var o = { id: String(r[0]), itemId: String(r[1]), studentId: String(r[2]), date: soDate_(r[3]), level: String(r[4] || 'Competent') };
  if (r[5]) o.signedBy = String(r[5]);
  if (r[6]) o.location = String(r[6]);
  if (r[7] && String(r[7]) !== 'MANUAL') o.source = String(r[7]);
  if (r[8]) o.notes = String(r[8]);
  return o;
}

/**
 * getCached() for values that may exceed CacheService's 100 KB per-entry limit (a cohort's
 * sign-off records + attendance grows through the year): the JSON is split across several
 * entries. Same versioned key scheme as getCached, so bumpDataVersion() invalidates it.
 */
var SO_CHUNK = 90000;
function soCachedLarge_(key, computeFn) {
  var cache = CacheService.getScriptCache();
  var vk = key + '@' + API_VERSION + '@' + getDataVersion();
  var n = Number(cache.get(vk + '#n'));
  if (n > 0) {
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(vk + '#' + i);
    var parts = cache.getAll(keys), json = '', ok = true;
    for (var j = 0; j < n; j++) { if (parts[keys[j]] == null) { ok = false; break; } json += parts[keys[j]]; }
    if (ok) { try { var v = JSON.parse(json); _cacheStats.hits++; return v; } catch (e) { /* recompute */ } }
  }
  _cacheStats.misses++;
  var value = computeFn();
  try {
    var s = JSON.stringify(value), put = {}, count = Math.ceil(s.length / SO_CHUNK) || 1;
    for (var k = 0; k < count; k++) put[vk + '#' + k] = s.slice(k * SO_CHUNK, (k + 1) * SO_CHUNK);
    cache.putAll(put, DATA_CACHE_TTL_SECONDS);
    cache.put(vk + '#n', String(count), DATA_CACHE_TTL_SECONDS);
  } catch (e) { /* too large even chunked — skip caching */ }
  return value;
}

/** StudentID → cohort, from the Students tab. */
function soStudentCohort_(studentId) {
  var map = getCached('studentCohortMap_v1', function () {
    var m = {};
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Students');
    sh.getDataRange().getValues().slice(1).forEach(function (r) { if (r[0]) m[String(r[0])] = String(r[1]); });
    return m;
  }, DATA_CACHE_TTL_SECONDS);
  return map[String(studentId)] || null;
}

/* ===== Reads ===== */

function getCohortSignoffs(cohort) {
  if (!cohort) return { error: 'cohort parameter required' };
  return soCachedLarge_('signoffs_v1:' + cohort, function () {
    var items = soRows_('SignoffItems').filter(function (r) { return r[0] && String(r[1]) === String(cohort); })
      .map(soItemFromRow_).sort(function (a, b) { return a.sortOrder - b.sortOrder; });
    var itemIds = {};
    items.forEach(function (it) { itemIds[it.id] = true; });
    var practicals = soRows_('Practicals').filter(function (r) { return r[0] && String(r[1]) === String(cohort); })
      .map(soPracFromRow_).sort(function (a, b) {
        return a.date < b.date ? -1 : a.date > b.date ? 1 : a.sortOrder - b.sortOrder;
      });
    var pracIds = {};
    practicals.forEach(function (p) { pracIds[p.id] = true; });
    var records = soRows_('Signoffs').filter(function (r) { return r[0] && itemIds[String(r[1])]; })
      .map(soRecFromRow_).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    // Compact { practicalId: { studentId: status } } — a full year is ~55 practicals × ~22
    // students, and an array of objects would push the cached payload past CacheService's 100 KB.
    var attendance = {};
    soRows_('Attendance').forEach(function (r) {
      if (!r[0] || !pracIds[String(r[0])] || !r[2]) return;
      (attendance[String(r[0])] = attendance[String(r[0])] || {})[String(r[1])] = String(r[2]);
    });
    return { cohort: String(cohort), items: items, practicals: practicals, records: records, attendance: attendance };
  }, DATA_CACHE_TTL_SECONDS);
}

function getStudentSignoffs(studentId) {
  if (!studentId) return { error: 'student parameter required' };
  var cohort = soStudentCohort_(studentId);
  if (!cohort) return { error: 'Student not found' };
  var all = getCohortSignoffs(cohort);
  var sid = String(studentId);
  var attendance = {};
  Object.keys(all.attendance).forEach(function (pid) {
    if (all.attendance[pid][sid]) { attendance[pid] = {}; attendance[pid][sid] = all.attendance[pid][sid]; }
  });
  return {
    cohort: cohort, studentId: sid, items: all.items, practicals: all.practicals,
    records: all.records.filter(function (r) { return r.studentId === sid; }),
    attendance: attendance
  };
}

/* ===== Writes ===== */

function soWithLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** Generic upsert by ID in column A. `rows` are full rows whose [0] is the ID. */
function soUpsert_(name, rows) {
  var sh = soSheet_(name);
  var w = SO_HEADERS[name].length;
  var last = sh.getLastRow();
  var rowById = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (v, i) { if (v[0]) rowById[String(v[0])] = i + 2; });
  var append = [];
  rows.forEach(function (row) {
    var at = rowById[String(row[0])];
    if (at) sh.getRange(at, 1, 1, w).setValues([row]);
    else append.push(row);
  });
  if (append.length) sh.getRange(sh.getLastRow() + 1, 1, append.length, w).setValues(append);
}

function soDeleteWhere_(name, predicate) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return 0;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, SO_HEADERS[name].length).getValues();
  var n = 0;
  for (var i = rows.length - 1; i >= 0; i--) {
    if (predicate(rows[i])) { sh.deleteRow(i + 2); n++; }
  }
  return n;
}

function saveSignoffItems(items) {
  if (!items || !items.length) return { success: false, message: 'No items to save.' };
  return soWithLock_(function () {
    var existing = soRows_('SignoffItems');
    var maxOrder = 0;
    existing.forEach(function (r) { maxOrder = Math.max(maxOrder, Number(r[7]) || 0); });
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      if (!it.cohort) return { success: false, message: 'Cohort is required.' };
      if (!String(it.name || '').trim()) return { success: false, message: 'Sign-off name is required.' };
      if (!it.id) { it.id = soId_('SOI-'); if (!it.sortOrder) it.sortOrder = ++maxOrder; }
      it.name = String(it.name).trim();
      out.push(soItemToRow_(it));
    }
    soUpsert_('SignoffItems', out);
    return { success: true, ids: out.map(function (r) { return r[0]; }) };
  });
}

function deleteSignoffItem(itemId) {
  if (!itemId) return { success: false, message: 'itemId is required.' };
  return soWithLock_(function () {
    var used = soRows_('Signoffs').some(function (r) { return String(r[1]) === String(itemId); });
    if (used) return { success: false, message: 'This sign-off has student records — retire it instead of deleting.' };
    var n = soDeleteWhere_('SignoffItems', function (r) { return String(r[0]) === String(itemId); });
    return n ? { success: true } : { success: false, message: 'Sign-off not found.' };
  });
}

function recordSignoff(rec, auth) {
  rec = rec || {};
  if (!rec.itemId || !rec.studentId) return { success: false, message: 'Sign-off and student are required.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rec.date || ''))) return { success: false, message: 'A valid date is required.' };
  var level = SO_LEVELS.indexOf(rec.level) !== -1 ? rec.level : 'Competent';
  var item = soRows_('SignoffItems').filter(function (r) { return String(r[0]) === String(rec.itemId); })[0];
  if (!item) return { success: false, message: 'Sign-off not found.' };
  if (String(item[1]) !== String(soStudentCohort_(rec.studentId))) return { success: false, message: 'That sign-off belongs to a different cohort.' };
  var id = soId_('SGN-');
  return soWithLock_(function () {
    soSheet_('Signoffs').appendRow([id, String(rec.itemId), String(rec.studentId), soDateCell_(rec.date), level,
      soText_(rec.signedBy), soText_(rec.location), 'MANUAL', soText_(rec.notes), auth.email || '', new Date()]);
    return { success: true, recordId: id };
  });
}

function deleteSignoffRecord(recordId) {
  if (!recordId) return { success: false, message: 'recordId is required.' };
  return soWithLock_(function () {
    var n = soDeleteWhere_('Signoffs', function (r) { return String(r[0]) === String(recordId); });
    return n ? { success: true } : { success: false, message: 'Record not found.' };
  });
}

function savePracticals(practicals) {
  if (!practicals || !practicals.length) return { success: false, message: 'No practicals to save.' };
  return soWithLock_(function () {
    var out = [];
    for (var i = 0; i < practicals.length; i++) {
      var p = practicals[i] || {};
      if (!p.cohort) return { success: false, message: 'Cohort is required.' };
      if (!String(p.title || '').trim()) return { success: false, message: 'Practical title is required.' };
      if (p.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(p.date))) return { success: false, message: 'Dates must be YYYY-MM-DD.' };
      if (!p.id) p.id = soId_('PRC-');
      p.title = String(p.title).trim();
      out.push(soPracToRow_(p));
    }
    soUpsert_('Practicals', out);
    return { success: true, ids: out.map(function (r) { return r[0]; }) };
  });
}

function deletePractical(practicalId) {
  if (!practicalId) return { success: false, message: 'practicalId is required.' };
  return soWithLock_(function () {
    var used = soRows_('Attendance').some(function (r) { return String(r[0]) === String(practicalId); });
    if (used) return { success: false, message: 'Attendance has been recorded for this practical — retire it instead of deleting.' };
    var n = soDeleteWhere_('Practicals', function (r) { return String(r[0]) === String(practicalId); });
    return n ? { success: true } : { success: false, message: 'Practical not found.' };
  });
}

/** statuses: { studentId: 'Attended' | 'Absent' | 'Excused' | '' } — '' clears the entry. */
function setAttendance(practicalId, statuses, auth) {
  if (!practicalId || !statuses) return { success: false, message: 'practicalId and statuses are required.' };
  return soWithLock_(function () {
    var sh = soSheet_('Attendance');
    var w = SO_HEADERS.Attendance.length;
    var last = sh.getLastRow();
    var rows = last >= 2 ? sh.getRange(2, 1, last - 1, w).getValues() : [];
    var rowByStudent = {};
    rows.forEach(function (r, i) { if (String(r[0]) === String(practicalId)) rowByStudent[String(r[1])] = i + 2; });
    var append = [], clear = [], n = 0;
    Object.keys(statuses).forEach(function (sid) {
      var st = statuses[sid];
      var at = rowByStudent[sid];
      if (!st) { if (at) clear.push(at); return; }
      if (SO_ATTENDANCE.indexOf(st) === -1) return;
      var row = [String(practicalId), sid, st, at ? rows[at - 2][3] : '', auth.email || '', new Date()];
      if (at) sh.getRange(at, 1, 1, w).setValues([row]); else append.push(row);
      n++;
    });
    if (append.length) sh.getRange(sh.getLastRow() + 1, 1, append.length, w).setValues(append);
    clear.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
    return { success: true, saved: n, cleared: clear.length };
  });
}

/* ===== Block placement Evaluation → sign-offs ===== */

function soNormSkill_(s) {
  return String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Matches parsed Evaluation skills to the student's cohort sign-off items.
 * skills: [{ skill, level, raw:{Exposure,Emerging,Competent} }]
 * Returns [{ key, skill, itemId, itemName, level, raw, status: new|exists|unmatched }]
 */
function soMatchPlacementSkills(studentId, skills, source) {
  var cohort = soStudentCohort_(studentId);
  var items = cohort ? getCohortSignoffs(cohort).items.filter(function (it) { return it.active; }) : [];
  var byName = {};
  items.forEach(function (it) {
    (it.placementMatch ? it.placementMatch.split(',') : []).concat([it.name]).forEach(function (n) {
      var k = soNormSkill_(n);
      if (k && !byName[k]) byName[k] = it;
    });
  });
  var have = {};
  soRows_('Signoffs').forEach(function (r) {
    if (String(r[2]) === String(studentId)) have[String(r[1]) + '|' + String(r[7]) + '|' + String(r[4])] = true;
  });
  return skills.map(function (s, i) {
    var it = byName[soNormSkill_(s.skill)];
    var out = { key: 'ev' + i, skill: s.skill, level: s.level, raw: s.raw, date: s.date || '',
      itemId: it ? it.id : null, itemName: it ? it.name : null };
    out.status = !it ? 'unmatched' : (s.level && have[it.id + '|' + source + '|' + s.level] ? 'exists' : 'new');
    return out;
  });
}

/**
 * Writes the chosen Evaluation sign-offs. choices: { key: { import:bool, level, itemId } }
 * (level/itemId let the supervisor correct the parse in the preview).
 */
function soImportPlacementSignoffs(studentId, matched, choices, source, location, fallbackDate, auth) {
  choices = choices || {};
  var have = {};
  soRows_('Signoffs').forEach(function (r) {
    if (String(r[2]) === String(studentId)) have[String(r[1]) + '|' + String(r[7]) + '|' + String(r[4])] = true;
  });
  var rows = [];
  (matched || []).forEach(function (m) {
    var c = choices[m.key] || {};
    var want = c.import != null ? !!c.import : m.status === 'new';
    var itemId = c.itemId || m.itemId;
    var level = SO_LEVELS.indexOf(c.level) !== -1 ? c.level : m.level;
    if (!want || !itemId || !level) return;
    var k = itemId + '|' + source + '|' + level;
    if (have[k]) return;
    have[k] = true;
    var raw = m.raw && m.raw[level] ? String(m.raw[level]) : '';
    rows.push([soId_('SGN-'), itemId, String(studentId), soDateCell_(m.date || fallbackDate), level,
      soText_(raw), soText_(location), source, 'Block placement evaluation', auth.email || '', new Date()]);
  });
  if (rows.length) {
    var sh = soSheet_('Signoffs');
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, SO_HEADERS.Signoffs.length).setValues(rows);
  }
  return rows.length;
}
