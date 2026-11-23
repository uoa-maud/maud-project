/**
 * Block Placement Importer — Google Apps Script
 *
 * Handles the 'importBlockPlacement' POST action from the supervisor dashboard.
 * Supervisors upload the Block Placement Template Excel file directly from the
 * dashboard UI; the file arrives as a base64 string, is converted to a temporary
 * Google Sheet for parsing, and the resulting per-date sessions are written to
 * the live Sessions tab using the same column layout as submitSession() and
 * CohortHoursImporter.gs.
 *
 * Rows are tagged with '*BLOCK-PLACEMENT*' in column AI. A block-placement row
 * is identified by student + date + clinic location; see the two-step
 * preview/import flow below for how duplicates are resolved.
 */

// Activity label → { ct: clinic type, sub: sub-type label }
// Mirrors COHORT_IMPORT_ACTIVITY_MAP in CohortHoursImporter.gs but for the
// Block Placement Template row labels (same source doc, same labels).
var BPI_ACTIVITY_MAP = {
  // Adult Diagnostic
  'Full diagnostic hearing test (AC, BC, Speech, Immittance)': { ct: 'Adult Diagnostic', sub: 'Full diagnostic (AC/BC/Speech/Immittance)' },
  'Hearing screening (Pure-tone AC only)':                     { ct: 'Adult Diagnostic', sub: 'Hearing screening (AC only)' },
  'Extended High Frequency testing (Ototoxity, Tinnitus)':     { ct: 'Adult Diagnostic', sub: 'Extended HF / Tinnitus assessment' },
  'Tinnitus assessment (level and pitch matching)':            { ct: 'Adult Diagnostic', sub: 'Extended HF / Tinnitus assessment' },
  'APD testing (behavioural)':                                 { ct: 'Adult Diagnostic', sub: 'APD testing' },
  'Other objective tests (DPOAE, ABR, Corticals)':             { ct: 'Adult Diagnostic', sub: 'Other objective tests (DPOAE/ABR/Corticals)' },
  'Vestibular testing':                                        { ct: 'Adult Diagnostic', sub: 'Vestibular testing' },
  'Cochlear Implant assessment':                               { ct: 'Adult Diagnostic', sub: 'CI Assessment' },
  'Tele-audiology: diagnostics':                               { ct: 'Adult Diagnostic', sub: 'Tele-audiology' },

  // Adult Rehabilitation
  'Needs Assessment':                                          { ct: 'Adult Rehabilitation', sub: 'Needs Assessment' },
  'Device Selection':                                          { ct: 'Adult Rehabilitation', sub: 'Device Selection' },
  'Hearing Aid Fitting / Real Ear Measures':                   { ct: 'Adult Rehabilitation', sub: 'HA Fitting / Real Ear Measures' },
  'Hearing aid follow up':                                     { ct: 'Adult Rehabilitation', sub: 'HA Follow-up' },
  'Tinnitus rehabilitation':                                   { ct: 'Adult Rehabilitation', sub: 'Tinnitus Rehabilitation' },
  'Cochlear Implant rehabilitation':                           { ct: 'Adult Rehabilitation', sub: 'CI Rehabilitation' },
  'Ear impressions, HA repairs/troubleshooting':               { ct: 'Adult Rehabilitation', sub: 'Ear Impressions / HA Repairs' },
  'Tele-audiology: rehabilitation':                            { ct: 'Adult Rehabilitation', sub: 'Tele-audiology' },

  // Paediatric Diagnostic
  'Newborn Hearing Screening (aABR)':                          { ct: 'Paediatric Diagnostic', sub: 'Newborn Hearing Screening (aABR)' },
  'Immittance (Tymp/ART) / DPOAE clinic':                      { ct: 'Paediatric Diagnostic', sub: 'Immittance / DPOAE clinic' },
  'Newborn Assessment (ABR)':                                  { ct: 'Paediatric Diagnostic', sub: 'Newborn Assessment (ABR)' },
  'Behavioural Observation Audiometry (BOA)':                  { ct: 'Paediatric Diagnostic', sub: 'BOA' },
  'Infant Assessment (VRA, MLV)':                              { ct: 'Paediatric Diagnostic', sub: 'Infant Assessment (VRA/MLV)' },
  'Preschool Assessments (CPA, KTT)':                          { ct: 'Paediatric Diagnostic', sub: 'Preschool Assessment (CPA/KTT)' },
  'School age child Assessments (PTA, CVC)':                   { ct: 'Paediatric Diagnostic', sub: 'School-age Assessment (PTA/CVC)' },
  'APD Testing (behavioural)':                                 { ct: 'Paediatric Diagnostic', sub: 'APD testing' },
  'Evoked Potentials':                                         { ct: 'Paediatric Diagnostic', sub: 'Evoked Potentials' },

  // Paediatric Rehabilitation
  'Hearing Aid Fitting / Real Ear Measures / Test-box measures': { ct: 'Paediatric Rehabilitation', sub: 'HA Fitting / REM / Test-box' },

  // Other — observations go in here; ORL/SLT are handled separately below
  'Observation of Ear Nurse Clinic':                           { ct: 'Other', sub: 'Observation – Ear Nurse' },
  'Observation of Hearing Therapist':                          { ct: 'Other', sub: 'Observation – Hearing Therapist / AODC / VHT' },
  'Observation of AODC/VHT':                                   { ct: 'Other', sub: 'Observation – Hearing Therapist / AODC / VHT' },
  'Equipment set-up and Troubleshooting':                      { ct: 'Other', sub: 'Equipment setup / Troubleshooting' },
  'Report writing and Case Discussions':                       { ct: 'Other', sub: 'Report writing / Case Discussion' },
  'HA Rep visit / seminar attendance/extra learning':          { ct: 'Other', sub: 'Seminar / HA Rep / Extra learning' }
};

// Rows whose hours go into the ORL column (col S in Sessions, index 18)
var BPI_ORL_LABELS = [
  'Observation of ORL specialist in clinic',
  'Observation of ORL surgery/theatre'
];

// Rows whose hours go into the SLT column (col T, index 19)
var BPI_SLT_LABELS = [
  'Observation of Speech Language Therapist'
];

// Rows whose hours go into the Supervision column (col V, index 21)
var BPI_SUPERVISION_LABELS = [
  'Clinical Supervision of MAud Year 1 Students'
];

// Rows whose hours go into the Simulation column (col U, index 20)
var BPI_SIMULATION_LABELS = [
  'Clinical Simulation'
];

/**
 * Two-step import, so duplicates are shown and resolved rather than silently
 * skipped or double-counted:
 *
 *   1. POST { action:'previewBlockPlacement', token, studentId, clinicName, fileBase64, filename }
 *      Parses the file and classifies every date (read-only, not a write action):
 *        new       — no block-placement row yet for this student + date + clinic
 *        unchanged — already imported with identical hours (nothing to do)
 *        changed   — already imported, but the file now has different hours
 *      Each date also lists `overlaps`: any other Sessions row for the same student
 *      and date (student self-log STU-, supervisor form SES-, cohort import IMP-, or a
 *      block placement at another clinic) so possible double-counting is visible.
 *      The parsed file is cached for 30 min under the returned previewId.
 *      Returns { success, previewId, dates:[...], emptyDates }
 *
 *   2. POST { action:'importBlockPlacement', token, studentId, previewId, decisions }
 *      decisions = { <date key>: 'import' | 'update' | 'skip' }. Re-checks each date
 *      against the current sheet before writing, so a stale preview can't create a
 *      duplicate. Missing decisions default to import for new dates, skip otherwise.
 *      Returns { success, created, updated, skipped, totalHrs, message }
 *
 * Legacy single-step call (old cached dashboard): importBlockPlacement with
 * fileBase64 and no previewId runs a preview and commits it with default decisions.
 */

var BPI_TAG = '*BLOCK-PLACEMENT*';
var BPI_TAG_COL = 34;          // col AI (0-based)
var BPI_HOURS_FROM = 8;        // col I  — first hours column (0-based)
var BPI_HOURS_TO = 21;         // col V  — last hours column (0-based, inclusive)
var BPI_ROW_WIDTH = 35;        // cols A..AI
var BPI_PREVIEW_TTL = 1800;    // seconds

/** Step 1 — parse + classify, no writes. */
function previewBlockPlacement(studentId, clinicName, fileBase64, filename) {
  if (!studentId) return { success: false, message: 'studentId is required.' };
  if (!fileBase64) return { success: false, message: 'No file data received.' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sessSheet = ss.getSheetByName('Sessions');
  if (!sessSheet) return { success: false, message: 'Sessions tab not found — check sheet setup.' };

  var parsed = bpiParseUpload(fileBase64, filename);
  if (parsed.error) return { success: false, message: parsed.error };

  var items = bpiBuildItems(parsed.dates, clinicName);
  var emptyDates = parsed.dates.length - items.rawCount;
  items = items.list;
  if (items.length === 0) {
    return { success: false, message: 'No hours found in the Clinical Hours sheet (' + parsed.dates.length + ' date columns, all empty).' };
  }

  var existing = bpiReadStudentRows(sessSheet, studentId);
  items.forEach(function (it) { bpiClassify(it, existing); });

  var previewId = Utilities.getUuid();
  var payload = JSON.stringify({ studentId: String(studentId), clinicName: clinicName || '', items: items });
  try {
    CacheService.getScriptCache().put('bpi:' + previewId, payload, BPI_PREVIEW_TTL);
  } catch (e) {
    return { success: false, message: 'File is too large to preview (' + Math.round(payload.length / 1024) + ' KB of parsed data).' };
  }

  return {
    success: true,
    previewId: previewId,
    emptyDates: emptyDates,
    dates: items.map(bpiPublicItem)
  };
}

/** Step 2 — apply decisions. Also handles the legacy single-step call. */
function importBlockPlacement(studentId, previewId, decisions, legacyClinicName, legacyFileBase64, legacyFilename) {
  if (!previewId && legacyFileBase64) {
    var pv = previewBlockPlacement(studentId, legacyClinicName, legacyFileBase64, legacyFilename);
    if (!pv.success) return pv;
    previewId = pv.previewId;
    decisions = {};
  }
  if (!studentId) return { success: false, message: 'studentId is required.' };
  if (!previewId) return { success: false, message: 'No preview to import — upload the file again.' };

  var cache = CacheService.getScriptCache();
  var raw = cache.get('bpi:' + previewId);
  if (!raw) return { success: false, message: 'This preview has expired (30 min). Upload the file again.' };
  var preview = JSON.parse(raw);
  if (preview.studentId !== String(studentId)) {
    return { success: false, message: 'Preview was for a different student — upload the file again.' };
  }
  decisions = decisions || {};

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sessSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sessions');
    var existing = bpiReadStudentRows(sessSheet, studentId);
    var takenIds = bpiAllSessionIds(sessSheet);
    var tz = Session.getScriptTimeZone();

    var toAppend = [], created = 0, updated = 0, skipped = 0, totalHrs = 0, notes = [];

    preview.items.forEach(function (it) {
      bpiClassify(it, existing); // re-check against the sheet as it is now
      var want = decisions[it.key] || (it.status === 'new' ? 'import' : 'skip');

      if (it.status === 'unchanged' || want === 'skip') { skipped++; return; }

      if (it.status === 'changed' && want === 'update') {
        var range = sessSheet.getRange(it.match.row, 1, 1, BPI_ROW_WIDTH);
        var row = range.getValues()[0];
        bpiFillRow(row, it, null, tz);
        range.setValues([row]);
        updated++; totalHrs += it.total;
        return;
      }

      if (it.status === 'new' && want === 'import') {
        var base = 'BLK-' + it.dateKey.replace(/-/g, '') + '-' + String(studentId).replace(/[^0-9A-Za-z]/g, '');
        var id = base, n = 2;
        while (takenIds[id]) id = base + '-' + (n++);
        takenIds[id] = true;
        var newRow = new Array(BPI_ROW_WIDTH);
        for (var i = 0; i < BPI_ROW_WIDTH; i++) newRow[i] = '';
        newRow[0] = new Date();
        newRow[1] = id;
        newRow[2] = studentId;
        newRow[32] = false;     // AG Approved
        newRow[BPI_TAG_COL] = BPI_TAG;
        bpiFillRow(newRow, it, id, tz);
        toAppend.push(newRow);
        created++; totalHrs += it.total;
        return;
      }

      // Decision no longer valid (e.g. a date became "changed" since the preview)
      skipped++;
      notes.push(it.dateKey + ' skipped — it changed since the preview');
    });

    if (toAppend.length) {
      sessSheet.getRange(sessSheet.getLastRow() + 1, 1, toAppend.length, BPI_ROW_WIDTH).setValues(toAppend);
    }
    cache.remove('bpi:' + previewId);

    var parts = [];
    parts.push('Imported ' + created + ' new date' + (created !== 1 ? 's' : ''));
    if (updated) parts.push('updated ' + updated);
    parts.push('skipped ' + skipped);
    return {
      success: true,
      created: created,
      updated: updated,
      skipped: skipped,
      totalHrs: Math.round(totalHrs * 10) / 10,
      message: parts.join(', ') + '.' + (notes.length ? ' ' + notes.join('; ') + '.' : '')
    };
  } finally {
    lock.releaseLock();
  }
}

/** Converts the uploaded Excel to a temp Google Sheet and parses it. */
function bpiParseUpload(fileBase64, filename) {
  var decoded = Utilities.base64Decode(fileBase64);
  var blob = Utilities.newBlob(decoded, MimeType.MICROSOFT_EXCEL, filename || 'placement.xlsx');
  var resource = { title: '_temp_bpi_' + (filename || 'placement'), mimeType: MimeType.GOOGLE_SHEETS };
  var tempFile = Drive.Files.insert(resource, blob, { convert: true });
  try {
    var tempBook = SpreadsheetApp.openById(tempFile.id);
    var hoursSheet = bpiFindClinicalHoursSheet(tempBook);
    if (!hoursSheet) return { error: 'Could not find a "Clinical Hours" sheet in the uploaded file.' };
    var parsed = bpiParseClinicalHours(hoursSheet.getDataRange().getValues());
    if (parsed.dates.length === 0) return { error: 'No date columns found in Clinical Hours sheet.' };
    return parsed;
  } finally {
    DriveApp.getFileById(tempFile.id).setTrashed(true);
  }
}

/**
 * Turns parsed date columns into serialisable items, one per date + clinic.
 * Two columns in the file with the same date and clinic are merged into one.
 * Columns with no hours are dropped.
 */
function bpiBuildItems(dates, clinicName) {
  var tz = Session.getScriptTimeZone();
  var byKey = {}, order = [], rawCount = 0;
  dates.forEach(function (di) {
    var vec = bpiHoursVector(di);
    var total = vec.reduce(function (a, b) { return a + b; }, 0);
    if (total <= 0) return;
    rawCount++;
    var dateKey = Utilities.formatDate(di.date, tz, 'yyyy-MM-dd');
    var location = di.location || clinicName || '';
    var key = dateKey + '|' + bpiNorm(location);
    var it = byKey[key];
    if (!it) {
      it = byKey[key] = {
        key: key, dateKey: dateKey, location: location, clinician: di.clinician || clinicName || '',
        hours: vec, subTypes: {}, mnzas: !!di.mnzas
      };
      order.push(key);
    } else {
      for (var i = 0; i < vec.length; i++) it.hours[i] += vec[i];
      if (di.clinician && it.clinician.indexOf(di.clinician) === -1) it.clinician += ' / ' + di.clinician;
      it.mnzas = it.mnzas || !!di.mnzas;
    }
    Object.keys(di.subTypes).forEach(function (ct) {
      var arr = it.subTypes[ct] = it.subTypes[ct] || [];
      di.subTypes[ct].forEach(function (s) { if (arr.indexOf(s) === -1) arr.push(s); });
    });
  });
  var list = order.map(function (k) {
    var it = byKey[k];
    it.hours = it.hours.map(bpiRound);
    it.total = bpiRound(it.hours.reduce(function (a, b) { return a + b; }, 0));
    return it;
  });
  return { list: list, rawCount: rawCount };
}

/** Hours in Sessions column order I..V (14 values). */
function bpiHoursVector(di) {
  var h = di.hours || {};
  return [
    h['Adult Diagnostic-obs'] || 0, h['Adult Diagnostic-test'] || 0,
    h['Paediatric Diagnostic-obs'] || 0, h['Paediatric Diagnostic-test'] || 0,
    h['Adult Rehabilitation-obs'] || 0, h['Adult Rehabilitation-test'] || 0,
    h['Paediatric Rehabilitation-obs'] || 0, h['Paediatric Rehabilitation-test'] || 0,
    h['Other-obs'] || 0, h['Other-test'] || 0,
    di.orl || 0, di.slt || 0, di.simulation || 0, di.supervision || 0
  ];
}

/** All Sessions rows for one student, with what classification needs. */
function bpiReadStudentRows(sessSheet, studentId) {
  var tz = Session.getScriptTimeZone();
  var data = sessSheet.getDataRange().getValues();
  var rows = [];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][2]) !== String(studentId)) continue;
    var d = data[r][3];
    var dateKey = (d instanceof Date) ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : String(d).slice(0, 10);
    var hours = [];
    for (var c = BPI_HOURS_FROM; c <= BPI_HOURS_TO; c++) hours.push(bpiRound(parseFloat(data[r][c]) || 0));
    rows.push({
      row: r + 1,
      sessionId: String(data[r][1] || ''),
      dateKey: dateKey,
      location: String(data[r][6] || ''),
      supervisor: String(data[r][4] || ''),
      isBlock: data[r][BPI_TAG_COL] === BPI_TAG,
      hours: hours,
      total: bpiRound(hours.reduce(function (a, b) { return a + b; }, 0))
    });
  }
  return rows;
}

function bpiAllSessionIds(sessSheet) {
  var ids = {};
  var last = sessSheet.getLastRow();
  if (last < 2) return ids;
  sessSheet.getRange(2, 2, last - 1, 1).getValues().forEach(function (v) { if (v[0]) ids[String(v[0])] = true; });
  return ids;
}

/** Sets it.status, it.match and it.overlaps against the student's existing rows. */
function bpiClassify(it, rows) {
  it.match = null;
  it.overlaps = [];
  rows.forEach(function (r) {
    if (r.dateKey !== it.dateKey) return;
    if (!it.match && r.isBlock && it.key === r.dateKey + '|' + bpiNorm(r.location)) { it.match = r; return; }
    if (r.total > 0) it.overlaps.push(r);
  });
  if (!it.match) it.status = 'new';
  else it.status = bpiSameHours(it.hours, it.match.hours) ? 'unchanged' : 'changed';
}

/** Writes an item's values into a Sessions row array (cols E, G, H, I–V, Z–AD, AF). */
function bpiFillRow(row, it, sessionId, tz) {
  var h = it.hours;
  if (sessionId) row[3] = Utilities.parseDate(it.dateKey, tz, 'yyyy-MM-dd');
  row[4] = sanitizeSheetText(it.clinician);
  row[6] = sanitizeSheetText(it.location);
  var acts = [];
  var cts = ['Adult Diagnostic', 'Paediatric Diagnostic', 'Adult Rehabilitation', 'Paediatric Rehabilitation', 'Other'];
  cts.forEach(function (ct, i) { if (h[i * 2] + h[i * 2 + 1] > 0) acts.push(ct); });
  if (h[10] > 0) acts.push('ORL Observation');
  if (h[11] > 0) acts.push('SLT Observation');
  if (h[12] > 0) acts.push('Simulation');
  row[7] = acts.join(', ');
  for (var i = 0; i < h.length; i++) row[BPI_HOURS_FROM + i] = h[i];
  cts.forEach(function (ct, i) { row[25 + i] = (it.subTypes[ct] || []).join(', '); });
  row[31] = it.mnzas;
}

/** What the dashboard sees for one date. */
function bpiPublicItem(it) {
  var SOURCES = { 'SES-': 'Supervisor form', 'STU-': 'Student self-log', 'IMP-': 'Cohort import', 'BLK-': 'Block placement' };
  return {
    key: it.key,
    date: it.dateKey,
    location: it.location,
    clinician: it.clinician,
    total: it.total,
    status: it.status,
    existing: it.match ? { sessionId: it.match.sessionId, total: it.match.total } : null,
    overlaps: it.overlaps.map(function (r) {
      var src = SOURCES[r.sessionId.slice(0, 4)] || 'Other entry';
      if (r.isBlock) src = 'Block placement' + (r.location ? ' — ' + r.location : '');
      return { sessionId: r.sessionId, source: src, total: r.total, supervisor: r.supervisor };
    })
  };
}

function bpiSameHours(a, b) {
  for (var i = 0; i < a.length; i++) if (Math.abs((a[i] || 0) - (b[i] || 0)) > 0.001) return false;
  return true;
}
function bpiRound(n) { return Math.round(n * 100) / 100; }
function bpiNorm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

/**
 * Finds the Clinical Hours sheet in the temporary workbook,
 * tolerating minor name variations.
 */
function bpiFindClinicalHoursSheet(book) {
  var names = ['Clinical Hours', 'Clinical hours', 'Hours', 'Sheet3'];
  for (var i = 0; i < names.length; i++) {
    var s = book.getSheetByName(names[i]);
    if (s) return s;
  }
  return null;
}

/**
 * Parses the 2D values array from the Clinical Hours sheet.
 *
 * Sheet layout (Block Placement Template):
 *   Row 0: "CLINICAL HOURS" | "Date of Clinic →" | <date> | <date> | ...
 *            (dates occupy one column each, but O/T pairs in row 1 tell us the
 *             observation column and test column for each date)
 *   Row 1: label | "Total Observed" | "Total Tested" | O | T | O | T | ...
 *   Rows 2–N: activity label | total-obs | total-test | obs | test | obs | test | ...
 *   Near bottom: "Clinician Full Name →" | | | name-per-date | ...
 *                "MNZAS? Y or N"         | ...
 *                "Clinic Name and Location →" | ...
 *
 * Returns { dates: [{ date, hours, subTypes, orl, slt, supervision, simulation, clinician, location }] }
 */
function bpiParseClinicalHours(data) {
  var result = { dates: [] };
  if (data.length < 2) return result;

  // --- Locate date columns ---
  // Row 0 has dates starting at col 2 (C); row 1 has O/T markers for each pair.
  var row0 = data[0];
  var row1 = data[1] || [];

  // Find O/T column pairs by scanning row 1 for the pattern "O" then "T".
  // The date for each pair is in row 0 at the same column as "O".
  var dateCols = []; // [{ obsCol, testCol, date }]
  for (var c = 2; c < row1.length - 1; c++) {
    var marker = String(row1[c] || '').trim().toUpperCase();
    var nextMarker = String(row1[c + 1] || '').trim().toUpperCase();
    if (marker === 'O' && nextMarker === 'T') {
      var rawDate = row0[c];
      // Some cells may have the date only in the first O column of the pair
      if (!rawDate && c > 2) rawDate = row0[c]; // already at obsCol
      if (rawDate instanceof Date) {
        dateCols.push({ obsCol: c, testCol: c + 1, date: rawDate });
      }
      c++; // advance past the T column
    }
  }

  if (dateCols.length === 0) return result;

  // Initialise per-date buckets
  var byCol = {};
  dateCols.forEach(function (dc) {
    byCol[dc.obsCol] = {
      date: dc.date,
      hours: {},
      subTypes: { 'Adult Diagnostic': [], 'Paediatric Diagnostic': [], 'Adult Rehabilitation': [], 'Paediatric Rehabilitation': [], 'Other': [] },
      orl: 0, slt: 0, supervision: 0, simulation: 0,
      clinician: '', location: '', mnzas: false
    };
  });

  // --- Scan activity rows ---
  // Track the current "section" for ambiguous labels (Cochlear Implant assessment
  // appears in both Adult Dx and Paed Dx sections — we resolve by current section).
  var currentSection = '';
  var SECTION_HEADERS = {
    'adults': null, 'adult': null,
    'paediatrics': null, 'paediatric': null,
    'other': null,
    'diagnostic': null,
    'rehabilitation': null, 'rehab': null
  };

  // Ambiguous labels resolved by currentSection
  var SECTION_RESOLVED = {
    'Cochlear Implant assessment':    { sub: 'CI Assessment' },
    'Tele-audiology: diagnostics':    { sub: 'Tele-audiology' },
    'Cochlear Implant rehabilitation':{ sub: 'CI Rehabilitation' },
    'Hearing aid follow up':          { sub: 'HA Follow-up' },
    'Ear impressions, HA repairs/troubleshooting': { sub: 'Ear Impressions / HA Repairs' },
    'Tele-audiology: rehabilitation': { sub: 'Tele-audiology' }
  };

  for (var r = 2; r < data.length; r++) {
    var label = String(data[r][0] || '').trim();
    var labelLower = label.toLowerCase();
    if (!label) continue;

    // --- Footer rows ---
    if (labelLower.indexOf('clinician full name') !== -1) {
      dateCols.forEach(function (dc) {
        var val = String(data[r][dc.obsCol] || '').trim();
        if (val) byCol[dc.obsCol].clinician = val;
      });
      continue;
    }
    if (labelLower.indexOf('mnzas') !== -1) {
      dateCols.forEach(function (dc) {
        var val = String(data[r][dc.obsCol] || '').trim().toLowerCase();
        byCol[dc.obsCol].mnzas = val === 'y' || val === 'yes' || val === 'true';
      });
      continue;
    }
    if (labelLower.indexOf('clinic name and location') !== -1) {
      dateCols.forEach(function (dc) {
        var val = String(data[r][dc.obsCol] || '').trim();
        if (val) byCol[dc.obsCol].location = val;
      });
      continue;
    }
    if (labelLower.indexOf('total hours') !== -1) continue;

    // --- Section headers ---
    if (labelLower === 'adults' || labelLower === 'adult') {
      currentSection = 'Adult';
      continue;
    }
    if (labelLower === 'paediatrics' || labelLower === 'paediatric') {
      currentSection = 'Paediatric';
      continue;
    }
    if (labelLower === 'other') {
      currentSection = 'Other';
      continue;
    }
    if (labelLower === 'diagnostic') {
      currentSection = (currentSection.split(' ')[0] || '') + ' Diagnostic';
      continue;
    }
    if (labelLower === 'rehabilitation' || labelLower === 'rehab') {
      currentSection = (currentSection.split(' ')[0] || '') + ' Rehabilitation';
      continue;
    }
    if (labelLower === 'observations') continue;

    // --- Special hour buckets ---
    var isOrl        = BPI_ORL_LABELS.indexOf(label) !== -1;
    var isSlt        = BPI_SLT_LABELS.indexOf(label) !== -1;
    var isSupervision= BPI_SUPERVISION_LABELS.indexOf(label) !== -1;
    var isSimulation = BPI_SIMULATION_LABELS.indexOf(label) !== -1;

    if (isOrl || isSlt || isSupervision || isSimulation) {
      dateCols.forEach(function (dc) {
        // These rows typically only use the obs column
        var hrs = parseFloat(data[r][dc.obsCol]) || 0;
        var bucket = byCol[dc.obsCol];
        if (isOrl)        bucket.orl        += hrs;
        if (isSlt)        bucket.slt        += hrs;
        if (isSupervision)bucket.supervision += hrs;
        if (isSimulation) bucket.simulation  += hrs;
      });
      continue;
    }

    // --- Regular activity rows ---
    var mapping = BPI_ACTIVITY_MAP[label];

    // If not in flat map, try section-resolved ambiguous labels
    if (!mapping && SECTION_RESOLVED[label] && currentSection) {
      var resolvedCt = currentSection; // e.g. "Adult Diagnostic"
      mapping = { ct: resolvedCt, sub: SECTION_RESOLVED[label].sub };
    }

    if (!mapping) continue; // Unknown row — skip

    var ct = mapping.ct;
    var sub = mapping.sub;
    var obsKey = ct + '-obs';
    var testKey = ct + '-test';

    dateCols.forEach(function (dc) {
      var obs  = parseFloat(data[r][dc.obsCol])  || 0;
      var test = parseFloat(data[r][dc.testCol]) || 0;
      if (obs <= 0 && test <= 0) return;

      var bucket = byCol[dc.obsCol];
      bucket.hours[obsKey]  = (bucket.hours[obsKey]  || 0) + obs;
      bucket.hours[testKey] = (bucket.hours[testKey] || 0) + test;
      if (sub && bucket.subTypes[ct] && bucket.subTypes[ct].indexOf(sub) === -1) {
        bucket.subTypes[ct].push(sub);
      }
    });
  }

  // Convert byCol map to ordered dates array
  dateCols.forEach(function (dc) {
    result.dates.push(byCol[dc.obsCol]);
  });

  return result;
}
