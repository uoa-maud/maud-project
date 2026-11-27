/*
 * Clinical Sign-offs & Practicals view for the dashboard (loaded by index.html after its
 * main script, so it shares its globals: API_URL, _idToken, _userRole, currentCohort,
 * currentStudent, studentsData, usingDemo, selectStudent, showReauthOverlay, ...).
 *
 * Data comes from the Signoffs.gs endpoints:
 *   GET signoffs_cohort&cohort=  (supervisor)  → {items, practicals, records, attendance}
 *       attendance is compact: { practicalId: { studentId: 'Attended'|'Absent'|'Excused' } }
 *   GET signoffs&student=        (student/own) → same shape, filtered to that student
 * A requirement is complete when the student has >= requiredCount 'Competent' records.
 */

let signoffsData = {};        // cohort → cohort payload (supervisor)
let studentSignoffsData = {}; // studentId → student payload (student role)
let _signoffsPending = {};    // cohort → in-flight Promise
const SO_LEVELS = ['Exposure', 'Emerging', 'Competent'];
const SO_ATT = ['Attended', 'Absent', 'Excused'];

function soEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function soToday() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function soFmtDate(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return s || '';
  var p = s.slice(0, 10).split('-');
  return p[2] + '/' + p[1] + '/' + p[0];
}
function soNum(n) { return (Math.round((Number(n) || 0) * 100) / 100).toString(); }
function soEmpty() { return { items: [], practicals: [], records: [], attendance: {} }; }
function soStudentName(id) {
  var s = (studentsData[currentCohort] || []).find(function (x) { return x.id === id; });
  if (s) return s.name;
  if (id === _userStudentId && typeof _userName !== 'undefined' && _userName) return _userName;
  return id;
}

/* ===== Loading ===== */

function fetchCohortSignoffs(cohort) {
  if (!_signoffsPending[cohort]) {
    _signoffsPending[cohort] = fetch(API_URL + '?action=signoffs_cohort&cohort=' + encodeURIComponent(cohort) + '&token=' + encodeURIComponent(_idToken || ''))
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.error) throw new Error(d.error); signoffsData[cohort] = d; return d; })
      .catch(function (e) { console.error('Sign-offs fetch failed:', e); return null; })
      .then(function (d) { delete _signoffsPending[cohort]; return d; });
  }
  return _signoffsPending[cohort];
}

function loadCohortSignoffs(cohort, cb) {
  if (signoffsData[cohort]) { cb(signoffsData[cohort]); return; }
  if (!API_URL || usingDemo) { signoffsData[cohort] = soEmpty(); cb(signoffsData[cohort]); return; }
  fetchCohortSignoffs(cohort).then(function (d) { cb(d || soEmpty()); });
}

/** One student's view. Supervisors derive it from the cohort payload so edits stay in one place. */
function loadStudentSignoffs(studentId, cb) {
  if (_userRole === 'supervisor') {
    loadCohortSignoffs(currentCohort, function (d) { cb(soFilterStudent(d, studentId)); });
    return;
  }
  if (studentSignoffsData[studentId]) { cb(studentSignoffsData[studentId]); return; }
  if (!API_URL || usingDemo) { cb(soEmpty()); return; }
  fetch(API_URL + '?action=signoffs&student=' + encodeURIComponent(studentId) + '&token=' + encodeURIComponent(_idToken || ''))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) throw new Error(d.error);
      studentSignoffsData[studentId] = d; cb(d);
    })
    .catch(function (e) { console.error('Sign-offs fetch failed:', e); cb(soEmpty()); });
}

function soFilterStudent(d, sid) {
  return {
    items: d.items, practicals: d.practicals,
    records: d.records.filter(function (r) { return r.studentId === sid; }),
    attendance: soAttFor(d.attendance, sid)
  };
}

function soPost(payload, onDone) {
  payload.token = _idToken;
  fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error === 'Supervisor access required') { showReauthOverlay(function () { soPost(payload, onDone); }); return; }
      onDone(data);
    })
    .catch(function (err) { onDone({ success: false, error: 'Network error: ' + err.message }); });
}
function soErr(d) { return d.error || d.message || 'Something went wrong.'; }

/* ===== Progress ===== */

function soProgress(item, recs) {
  var mine = recs.filter(function (r) { return r.itemId === item.id; });
  var done = mine.filter(function (r) { return r.level === 'Competent'; }).length;
  var best = -1;
  mine.forEach(function (r) { best = Math.max(best, SO_LEVELS.indexOf(r.level)); });
  return { records: mine, done: done, req: item.requiredCount, complete: done >= item.requiredCount, best: best };
}
function soCellClass(p) { return p.complete ? 'green' : (p.done > 0 || p.best >= 0) ? 'amber' : 'none'; }

function soCategories(items) {
  var order = [], by = {};
  items.forEach(function (it) {
    var c = it.category || 'Other';
    if (!by[c]) { by[c] = []; order.push(c); }
    by[c].push(it);
  });
  return order.map(function (c) { return { name: c, items: by[c] }; });
}

/** Summary used by the cohort table, student cards and PDF. */
/** { practicalId: status } for one student. */
function soAttFor(attendance, sid) {
  var out = {};
  Object.keys(attendance || {}).forEach(function (pid) {
    if (attendance[pid][sid]) { out[pid] = {}; out[pid][sid] = attendance[pid][sid]; }
  });
  return out;
}

/** d is a single student's payload (attendance already filtered to them). */
function soSummary(d, sid) {
  var active = d.items.filter(function (it) { return it.active; });
  var comp = active.filter(function (it) { return !it.optional; });
  var opt = active.filter(function (it) { return it.optional; });
  function count(list) { return list.filter(function (it) { return soProgress(it, d.records).complete; }).length; }
  var pracs = d.practicals.filter(function (p) { return p.active; });
  var att = {};
  Object.keys(d.attendance || {}).forEach(function (pid) { if (d.attendance[pid][sid]) att[pid] = d.attendance[pid][sid]; });
  var attended = pracs.filter(function (p) { return att[p.id] === 'Attended'; });
  var recorded = pracs.filter(function (p) { return att[p.id]; });
  return {
    compDone: count(comp), compTotal: comp.length, optDone: count(opt), optTotal: opt.length,
    pracAttended: attended.length, pracRecorded: recorded.length, pracTotal: pracs.length,
    pracHours: attended.reduce(function (a, p) { return a + (p.hours || 0); }, 0), att: att
  };
}

/* ===== Cohort view ===== */

function renderSignoffsCohort() {
  document.getElementById('summaryCards').innerHTML = '<div class="loading">Loading sign-offs…</div>';
  document.getElementById('dashboard').innerHTML = '';
  var cohort = currentCohort;
  loadCohortSignoffs(cohort, function (d) {
    if (currentCohort !== cohort || currentView !== 'signoffs' || currentStudent !== '__overview') return;
    var students = studentsData[cohort] || [];
    var items = d.items.filter(function (it) { return it.active; });
    var cats = soCategories(items);
    var pracs = d.practicals.filter(function (p) { return p.active; });
    var allDone = 0;
    var perStudent = students.map(function (s) {
      var sd = soFilterStudent(d, s.id), sum = soSummary(sd, s.id);
      if (sum.compTotal && sum.compDone === sum.compTotal) allDone++;
      return { s: s, d: sd, sum: sum };
    });

    var cards = '<div class="summary-cards">'
      + soCard('Compulsory sign-offs', items.filter(function (i) { return !i.optional; }).length, 'per student')
      + soCard('All compulsory done', allDone + ' / ' + students.length, 'students')
      + soCard('Practicals', pracs.length, soNum(pracs.reduce(function (a, p) { return a + p.hours; }, 0)) + ' h scheduled')
      + '<div class="summary-card" style="display:flex;align-items:center;justify-content:center">'
      + '<button class="so-btn primary" onclick="openManageListsModal()">Manage lists</button></div>'
      + '</div>';
    document.getElementById('summaryCards').innerHTML = cards;

    var h = '';
    if (!items.length && !pracs.length) {
      h += '<div class="loading">No sign-offs or practicals set up for this cohort yet — use <b>Manage lists</b> to add them'
        + ' (or copy them from another cohort).</div>';
      document.getElementById('dashboard').innerHTML = h;
      return;
    }

    // --- Sign-offs matrix ---
    if (items.length) {
      h += '<div class="section-hdr">Clinical sign-offs</div>';
      h += '<div class="legend" style="margin:4px 0 8px"><span class="legend-item"><span class="legend-pip" style="background:var(--green)"></span> Complete</span>'
        + '<span class="legend-item"><span class="legend-pip" style="background:var(--amber)"></span> In progress (n = competent sign-offs / required)</span>'
        + '<span style="color:var(--text-hint)">* optional · click a student for details</span></div>';
      h += '<div class="so-scroll"><table class="so-matrix"><thead><tr><th class="so-sticky"></th>';
      cats.forEach(function (c) { h += '<th colspan="' + c.items.length + '" class="so-cat">' + soEsc(c.name) + '</th>'; });
      h += '<th></th></tr><tr><th class="so-sticky" style="text-align:left">Student</th>';
      cats.forEach(function (c) {
        c.items.forEach(function (it) {
          h += '<th class="so-vert" title="' + soEsc(it.name + (it.description ? ' — ' + it.description : '')) + '"><span>'
            + soEsc(it.name) + (it.optional ? ' *' : '') + (it.requiredCount > 1 ? ' (×' + it.requiredCount + ')' : '') + '</span></th>';
        });
      });
      h += '<th class="so-vert"><span>Compulsory done</span></th></tr></thead><tbody>';
      perStudent.forEach(function (ps) {
        h += '<tr><td class="so-sticky"><span class="student-name-link" data-view="signoffs" data-student="' + soEsc(ps.s.id) + '">' + soEsc(ps.s.name) + '</span></td>';
        cats.forEach(function (c) {
          c.items.forEach(function (it) {
            var p = soProgress(it, ps.d.records), cls = soCellClass(p);
            var label = p.complete && p.req === 1 ? '✓' : (p.done || p.best >= 0 ? p.done + '/' + p.req : '');
            var tip = it.name + ': ' + p.done + ' of ' + p.req + ' competent' + (p.best >= 0 && !p.done ? ' (best: ' + SO_LEVELS[p.best] + ')' : '');
            h += '<td><span class="cell so-cell ' + cls + (it.optional ? ' opt' : '') + '" data-so-student="' + soEsc(ps.s.id) + '" title="' + soEsc(tip) + '">' + label + '</span></td>';
          });
        });
        var full = ps.sum.compTotal && ps.sum.compDone === ps.sum.compTotal;
        h += '<td style="text-align:center"><span class="hrs-cell ' + (full ? 'ok' : 'tracked') + '">' + ps.sum.compDone + '/' + ps.sum.compTotal + '</span></td></tr>';
      });
      h += '</tbody></table></div>';
    }

    // --- Practicals ---
    if (pracs.length) {
      h += '<div class="section-hdr" style="margin-top:1.5rem">Practicals &amp; tutorials</div>';
      h += '<p style="font-size:calc(var(--font-scale,1)*11px);color:var(--text-hint);margin:0 0 6px">Click a practical to record attendance.</p>';
      h += '<table class="session-table"><thead><tr><th>Date</th><th>Practical</th><th style="text-align:right">Hours</th><th>Facilitator</th><th>Attended</th><th>Absent / excused</th></tr></thead><tbody>';
      pracs.forEach(function (p) {
        var pa = d.attendance[p.id] || {};
        var att = Object.keys(pa).map(function (sid) { return { studentId: sid, status: pa[sid] }; });
        var yes = att.filter(function (a) { return a.status === 'Attended'; }).length;
        var missing = att.filter(function (a) { return a.status !== 'Attended'; })
          .map(function (a) { return soEsc(soStudentName(a.studentId)) + (a.status === 'Excused' ? ' (exc.)' : ''); });
        h += '<tr class="so-prac-row" data-prac="' + soEsc(p.id) + '" style="cursor:pointer"><td style="white-space:nowrap">' + soFmtDate(p.date) + '</td>'
          + '<td>' + soEsc(p.title) + (p.compulsory ? '' : ' <span style="color:var(--text-hint)">(optional)</span>') + '</td>'
          + '<td style="text-align:right">' + soNum(p.hours) + '</td><td>' + soEsc(p.facilitator) + '</td>'
          + '<td><span class="hrs-cell ' + (att.length ? (yes === students.length ? 'ok' : 'tracked') : 'tracked') + '">' + (att.length ? yes + '/' + students.length : '—') + '</span></td>'
          + '<td style="color:var(--text-muted)">' + missing.join(', ') + '</td></tr>';
      });
      h += '</tbody></table>';

      h += '<div class="section-hdr" style="margin-top:1.5rem">Practical attendance by student</div>';
      h += '<table class="hours-target-table"><thead><tr><th>Student</th><th>Attended</th><th>Absent / excused</th><th>Not recorded</th><th>Practical hours</th></tr></thead><tbody>';
      perStudent.forEach(function (ps) {
        var s = ps.sum, pct = s.pracTotal ? s.pracAttended / s.pracTotal : 1;
        h += '<tr><td><span class="student-name-link" data-view="signoffs" data-student="' + soEsc(ps.s.id) + '">' + soEsc(ps.s.name) + '</span></td>'
          + '<td><span class="hrs-cell ' + (pct >= 1 ? 'ok' : pct >= .85 ? 'warn' : 'low') + '">' + s.pracAttended + ' / ' + s.pracTotal + '</span></td>'
          + '<td>' + (s.pracRecorded - s.pracAttended) + '</td><td>' + (s.pracTotal - s.pracRecorded) + '</td>'
          + '<td>' + soNum(s.pracHours) + '</td></tr>';
      });
      h += '</tbody></table>';
    }
    document.getElementById('dashboard').innerHTML = h;
  });
}

function soCard(label, value, detail) {
  return '<div class="summary-card"><div class="sc-label">' + soEsc(label) + '</div><div class="sc-value" style="font-size:calc(var(--font-scale,1)*18px)">'
    + soEsc(value) + '</div>' + (detail ? '<div class="sc-detail">' + soEsc(detail) + '</div>' : '') + '</div>';
}

/* ===== Individual student view ===== */

function renderSignoffsStudent() {
  var sid = currentStudent;
  document.getElementById('summaryCards').innerHTML = '<div class="loading">Loading sign-offs…</div>';
  document.getElementById('dashboard').innerHTML = '';
  loadStudentSignoffs(sid, function (d) {
    if (currentStudent !== sid || currentView !== 'signoffs') return;
    var sup = _userRole === 'supervisor';
    var sum = soSummary(d, sid);
    document.getElementById('summaryCards').innerHTML = '<div class="summary-cards">'
      + soCard('Compulsory sign-offs', sum.compDone + ' / ' + sum.compTotal, 'complete')
      + (sum.optTotal ? soCard('Optional sign-offs', sum.optDone + ' / ' + sum.optTotal, 'complete') : '')
      + soCard('Practicals attended', sum.pracAttended + ' / ' + sum.pracTotal, soNum(sum.pracHours) + ' h')
      + (sup ? '<div class="summary-card" style="display:flex;align-items:center;justify-content:center">'
        + '<button class="so-btn primary" onclick="printClinicalRecordPDF()">Clinical record PDF</button></div>' : '')
      + '</div>';

    // Active items, plus retired ones the student has records for
    var items = d.items.filter(function (it) { return it.active || d.records.some(function (r) { return r.itemId === it.id; }); });
    var h = '';
    if (!items.length) h += '<div class="loading">No sign-offs set up for this cohort yet.</div>';
    soCategories(items).forEach(function (c) {
      h += '<div class="section"><div class="section-hdr">' + soEsc(c.name) + '</div>';
      c.items.forEach(function (it) {
        var p = soProgress(it, d.records), cls = soCellClass(p);
        var pct = Math.min(100, Math.round(p.done / p.req * 100));
        var col = p.complete ? 'var(--green)' : cls === 'amber' ? 'var(--amber)' : 'var(--border-strong)';
        h += '<div class="so-item' + (it.active ? '' : ' retired') + '"><div class="so-item-head">'
          + '<div><span class="so-item-name">' + soEsc(it.name) + '</span>'
          + (it.optional ? ' <span class="so-tag">optional</span>' : '') + (it.active ? '' : ' <span class="so-tag">retired</span>')
          + (it.description ? '<div class="so-item-desc">' + soEsc(it.description) + '</div>' : '') + '</div>'
          + '<div class="so-item-prog"><span class="hrs-cell ' + (p.complete ? 'ok' : cls === 'amber' ? 'warn' : 'tracked') + '">' + p.done + ' / ' + p.req + '</span>'
          + '<div class="hrs-bar-wrap" style="width:90px"><div class="hrs-bar" style="width:' + pct + '%;background:' + col + '"></div></div></div>'
          + (sup && it.active ? '<button class="so-btn" data-so-record="' + soEsc(it.id) + '">+ Record</button>' : '')
          + '</div>';
        if (p.records.length) {
          h += '<div class="so-log">';
          p.records.forEach(function (r) {
            var src = r.source && r.source !== 'MANUAL' ? 'Imported from ' + r.source.replace(/^BLK:/, 'block placement — ') : '';
            h += '<div class="so-log-row"><span class="so-lvl so-lvl-' + soEsc(r.level) + '">' + soEsc(r.level) + '</span> '
              + soFmtDate(r.date) + (r.signedBy ? ' · ' + soEsc(r.signedBy) : '') + (r.location ? ' · ' + soEsc(r.location) : '')
              + (r.notes ? ' · <span style="color:var(--text-hint)">' + soEsc(r.notes) + '</span>' : '')
              + (src ? ' <span style="color:var(--text-hint)">(' + soEsc(src) + ')</span>' : '')
              + (sup ? ' <button class="so-x" title="Delete this sign-off" data-so-del="' + soEsc(r.id) + '">✕</button>' : '') + '</div>';
          });
          h += '</div>';
        }
        h += '</div>';
      });
      h += '</div>';
    });

    var pracs = d.practicals.filter(function (p) { return p.active || sum.att[p.id]; });
    if (pracs.length) {
      h += '<div class="section"><div class="section-hdr">Practicals &amp; tutorials</div>';
      h += '<table class="session-table"><thead><tr><th>Date</th><th>Practical</th><th style="text-align:right">Hours</th><th>Status</th></tr></thead><tbody>';
      pracs.forEach(function (p) {
        var st = sum.att[p.id] || '';
        var cls = st === 'Attended' ? 'ok' : st === 'Excused' ? 'warn' : st === 'Absent' ? 'low' : 'tracked';
        h += '<tr' + (sup ? ' class="so-prac-row" data-prac="' + soEsc(p.id) + '" style="cursor:pointer"' : '') + '><td style="white-space:nowrap">' + soFmtDate(p.date) + '</td><td>' + soEsc(p.title) + '</td>'
          + '<td style="text-align:right">' + soNum(p.hours) + '</td><td><span class="hrs-cell ' + cls + '">' + (st || 'Not recorded') + '</span></td></tr>';
      });
      h += '</tbody></table></div>';
    }
    document.getElementById('dashboard').innerHTML = h;
  });
}

/* ===== Clicks inside the dashboard ===== */

document.getElementById('dashboard').addEventListener('click', function (e) {
  var link = e.target.closest('[data-view="signoffs"][data-student]');
  if (link) { selectStudent(link.dataset.student, 'signoffs'); return; }
  var cell = e.target.closest('[data-so-student]');
  if (cell) { selectStudent(cell.dataset.soStudent, 'signoffs'); return; }
  var rec = e.target.closest('[data-so-record]');
  if (rec) { openRecordSignoffModal(rec.dataset.soRecord); return; }
  var del = e.target.closest('[data-so-del]');
  if (del) { soDeleteRecord(del.dataset.soDel, del); return; }
  var pr = e.target.closest('.so-prac-row');
  if (pr && _userRole === 'supervisor') { openAttendanceModal(pr.dataset.prac); return; }
});

function soDeleteRecord(recordId, btn) {
  if (!confirm('Delete this sign-off record? This cannot be undone.')) return;
  btn.disabled = true;
  function done() {
    var d = signoffsData[currentCohort];
    if (d) d.records = d.records.filter(function (r) { return r.id !== recordId; });
    renderSignoffsStudent();
  }
  if (!API_URL || usingDemo) { done(); return; }
  soPost({ action: 'deleteSignoffRecord', recordId: recordId }, function (res) {
    if (!res.success) { alert('Delete failed: ' + soErr(res)); btn.disabled = false; return; }
    done();
  });
}

/* ===== Modals (shared shell) ===== */

function soModal(title, bodyHtml, buttons, width) {
  var ov = document.getElementById('soOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'soOverlay';
    ov.className = 'so-overlay';
    ov.addEventListener('click', function (e) { if (e.target === ov) soCloseModal(); });
    document.body.appendChild(ov);
  }
  ov.innerHTML = '<div class="so-dialog" style="width:' + (width || 'min(480px,92vw)') + '">'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px"><h2 class="so-h2">' + title + '</h2>'
    + '<button class="so-x" style="font-size:18px" onclick="soCloseModal()">✕</button></div>'
    + '<div id="soBody">' + bodyHtml + '</div>'
    + '<div id="soStatus" class="so-status" style="display:none"></div>'
    + '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">' + buttons + '</div></div>';
  ov.style.display = 'flex';
}
function soCloseModal() { var ov = document.getElementById('soOverlay'); if (ov) ov.style.display = 'none'; }
function soStatus(msg, type) {
  var el = document.getElementById('soStatus');
  if (!el) return;
  el.style.display = msg ? 'block' : 'none';
  el.textContent = msg || '';
  el.style.background = type === 'error' ? 'var(--red-bg)' : type === 'success' ? 'var(--green-bg)' : 'var(--accent-bg)';
  el.style.color = type === 'error' ? 'var(--red-text)' : type === 'success' ? 'var(--green-text)' : 'var(--accent-text)';
}
function soField(label, input) { return '<div class="so-field"><label>' + label + '</label>' + input + '</div>'; }

/* ---- Record a sign-off ---- */

function openRecordSignoffModal(itemId) {
  var d = signoffsData[currentCohort];
  var it = d && d.items.find(function (x) { return x.id === itemId; });
  if (!it) return;
  var who = supervisorName || (typeof _userName !== 'undefined' ? _userName : '') || '';
  var body = '<p class="so-hint">' + soEsc(soStudentName(currentStudent)) + ' — <b>' + soEsc(it.name) + '</b>'
    + (it.requiredCount > 1 ? ' (' + it.requiredCount + ' required)' : '') + '</p>'
    + soField('Date', '<input id="soRecDate" type="date" class="so-input" value="' + soToday() + '">')
    + soField('Level', '<select id="soRecLevel" class="so-input">' + SO_LEVELS.map(function (l) {
      return '<option' + (l === 'Competent' ? ' selected' : '') + '>' + l + '</option>';
    }).join('') + '</select>')
    + '<p class="so-hint" style="margin-top:-6px">Only <b>Competent</b> counts towards the sign-off; Exposure / Emerging are kept as progress.</p>'
    + soField('Signed off by', '<input id="soRecBy" class="so-input" value="' + soEsc(who) + '">')
    + soField('Location', '<input id="soRecLoc" class="so-input" placeholder="e.g. UoA Clinic">')
    + soField('Notes (optional)', '<input id="soRecNotes" class="so-input">');
  soModal('Record sign-off', body, '<button class="so-btn" onclick="soCloseModal()">Cancel</button>'
    + '<button class="so-btn primary" id="soRecSave">Save</button>');
  document.getElementById('soRecSave').onclick = function () { soSaveRecord(it); };
}

function soSaveRecord(it) {
  var rec = {
    itemId: it.id, studentId: currentStudent,
    date: document.getElementById('soRecDate').value,
    level: document.getElementById('soRecLevel').value,
    signedBy: document.getElementById('soRecBy').value.trim(),
    location: document.getElementById('soRecLoc').value.trim(),
    notes: document.getElementById('soRecNotes').value.trim()
  };
  if (!rec.date) { soStatus('Please choose a date.', 'error'); return; }
  if (rec.signedBy && !supervisorName) { supervisorName = rec.signedBy; localStorage.setItem('maud_supervisor', rec.signedBy); }
  var btn = document.getElementById('soRecSave');
  btn.disabled = true; btn.textContent = 'Saving…';
  function done(id) {
    rec.id = id; rec.source = 'MANUAL';
    var d = signoffsData[currentCohort];
    if (d) d.records.push(rec);
    soCloseModal();
    renderSignoffsStudent();
  }
  if (!API_URL || usingDemo) { done('DEMO-' + Date.now()); return; }
  soPost({ action: 'recordSignoff', record: rec }, function (res) {
    if (!res.success) { soStatus(soErr(res), 'error'); btn.disabled = false; btn.textContent = 'Save'; return; }
    done(res.recordId);
  });
}

/* ---- Attendance for one practical ---- */

var _soAtt = null; // { practicalId, statuses: {studentId: status}, original }

function openAttendanceModal(practicalId) {
  var d = signoffsData[currentCohort];
  var p = d && d.practicals.find(function (x) { return x.id === practicalId; });
  if (!p) return;
  var students = studentsData[currentCohort] || [];
  var statuses = {};
  Object.assign(statuses, d.attendance[practicalId] || {});
  _soAtt = { practicalId: practicalId, statuses: Object.assign({}, statuses), original: statuses };
  var body = '<p class="so-hint">' + soFmtDate(p.date) + ' · ' + soNum(p.hours) + ' h' + (p.facilitator ? ' · ' + soEsc(p.facilitator) : '') + '</p>'
    + '<div style="margin-bottom:8px"><button class="so-btn" onclick="soAttAll(\'Attended\')">Mark everyone attended</button> '
    + '<button class="so-btn" onclick="soAttAll(\'\')">Clear</button></div>'
    + '<div id="soAttList">' + students.map(function (s) {
      return '<div class="so-att-row"><span>' + soEsc(s.name) + '</span><span class="so-seg" data-sid="' + soEsc(s.id) + '">'
        + SO_ATT.map(function (st) { return '<button data-st="' + st + '">' + st + '</button>'; }).join('') + '</span></div>';
    }).join('') + '</div>';
  soModal(soEsc(p.title), body, '<button class="so-btn" onclick="soCloseModal()">Cancel</button>'
    + '<button class="so-btn primary" id="soAttSave">Save attendance</button>', 'min(560px,94vw)');
  document.getElementById('soAttList').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-st]'); if (!b) return;
    var sid = b.parentNode.dataset.sid;
    _soAtt.statuses[sid] = _soAtt.statuses[sid] === b.dataset.st ? '' : b.dataset.st;
    soAttPaint();
  });
  document.getElementById('soAttSave').onclick = soSaveAttendance;
  soAttPaint();
}
function soAttAll(st) {
  (studentsData[currentCohort] || []).forEach(function (s) { _soAtt.statuses[s.id] = st; });
  soAttPaint();
}
function soAttPaint() {
  document.querySelectorAll('#soAttList .so-seg').forEach(function (seg) {
    var cur = _soAtt.statuses[seg.dataset.sid] || '';
    seg.querySelectorAll('button').forEach(function (b) { b.className = b.dataset.st === cur ? 'on on-' + cur : ''; });
  });
}
function soSaveAttendance() {
  var changed = {}, n = 0;
  Object.keys(_soAtt.statuses).forEach(function (sid) {
    if ((_soAtt.statuses[sid] || '') !== (_soAtt.original[sid] || '')) { changed[sid] = _soAtt.statuses[sid] || ''; n++; }
  });
  if (!n) { soCloseModal(); return; }
  var btn = document.getElementById('soAttSave');
  btn.disabled = true; btn.textContent = 'Saving…';
  var pid = _soAtt.practicalId;
  function done() {
    var d = signoffsData[currentCohort];
    var pa = d.attendance[pid] = d.attendance[pid] || {};
    Object.keys(changed).forEach(function (sid) { if (changed[sid]) pa[sid] = changed[sid]; else delete pa[sid]; });
    soCloseModal();
    render();
  }
  if (!API_URL || usingDemo) { done(); return; }
  soPost({ action: 'setAttendance', practicalId: pid, statuses: changed }, function (res) {
    if (!res.success) { soStatus(soErr(res), 'error'); btn.disabled = false; btn.textContent = 'Save attendance'; return; }
    done();
  });
}

/* ---- Manage lists (sign-off items + practicals) ---- */

var _soMgr = null; // { tab, items:[…], practicals:[…], dirtyItems:{}, dirtyPracs:{} }

function openManageListsModal() {
  loadCohortSignoffs(currentCohort, function (d) {
    _soMgr = {
      tab: _soMgr ? _soMgr.tab : 'items',
      items: d.items.map(function (x) { return Object.assign({}, x); }),
      practicals: d.practicals.map(function (x) { return Object.assign({}, x); }),
      dirtyItems: {}, dirtyPracs: {}
    };
    soModal('Manage lists — ' + soEsc(currentCohort) + ' cohort', '<div id="soMgr"></div>',
      '<button class="so-btn" onclick="soCloseModal()">Close</button>'
      + '<button class="so-btn primary" id="soMgrSave" onclick="soMgrSave()">Save changes</button>', 'min(1080px,96vw)');
    soMgrRender();
  });
}

function soMgrRender() {
  var m = _soMgr, h = '';
  h += '<div class="view-tabs" style="margin-bottom:10px"><button class="view-tab' + (m.tab === 'items' ? ' active' : '') + '" onclick="soMgrTab(\'items\')">Sign-offs</button>'
    + '<button class="view-tab' + (m.tab === 'pracs' ? ' active' : '') + '" onclick="soMgrTab(\'pracs\')">Practicals</button></div>';
  if (m.tab === 'items') {
    h += '<p class="so-hint">Changing <b>Required</b> re-evaluates every student straight away. <b>Retire</b> (untick Active) hides a sign-off but keeps students\' records; '
      + 'delete only works when nobody has a record. <b>Placement match</b> = the skill name(s) in the block placement Evaluation tab that fill this sign-off (comma separated; the name itself always matches).</p>';
    h += '<div class="so-scroll"><table class="so-mgr"><thead><tr><th></th><th>Category</th><th>Name</th><th>Description</th><th>Required</th><th>Optional</th><th>Placement match</th><th>Active</th><th></th></tr></thead><tbody>';
    m.items.forEach(function (it, i) {
      h += '<tr class="' + (it.active ? '' : 'retired') + '"><td class="so-ord"><button onclick="soMgrMove(' + i + ',-1)">▲</button><button onclick="soMgrMove(' + i + ',1)">▼</button></td>'
        + '<td><input data-i="' + i + '" data-k="category" value="' + soEsc(it.category) + '" list="soCatList"></td>'
        + '<td><input data-i="' + i + '" data-k="name" value="' + soEsc(it.name) + '"></td>'
        + '<td><input data-i="' + i + '" data-k="description" value="' + soEsc(it.description) + '"></td>'
        + '<td><input data-i="' + i + '" data-k="requiredCount" type="number" min="1" style="width:56px" value="' + it.requiredCount + '"></td>'
        + '<td style="text-align:center"><input data-i="' + i + '" data-k="optional" type="checkbox"' + (it.optional ? ' checked' : '') + '></td>'
        + '<td><input data-i="' + i + '" data-k="placementMatch" value="' + soEsc(it.placementMatch) + '"></td>'
        + '<td style="text-align:center"><input data-i="' + i + '" data-k="active" type="checkbox"' + (it.active ? ' checked' : '') + '></td>'
        + '<td><button class="so-x" title="Delete" onclick="soMgrDelete(' + i + ')">✕</button></td></tr>';
    });
    h += '</tbody></table></div>';
    var cats = {};
    m.items.forEach(function (it) { if (it.category) cats[it.category] = 1; });
    h += '<datalist id="soCatList">' + Object.keys(cats).map(function (c) { return '<option value="' + soEsc(c) + '">'; }).join('') + '</datalist>';
    h += '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center"><button class="so-btn" onclick="soMgrAdd()">+ Add sign-off</button>';
    var others = Array.from(document.getElementById('cohortSelect').options).map(function (o) { return o.value; })
      .filter(function (v) { return v && v !== currentCohort; });
    if (others.length) {
      h += '<span class="so-hint" style="margin:0 0 0 12px">Copy list from</span><select id="soCopyFrom" class="so-input" style="width:auto">'
        + others.map(function (v) { return '<option>' + soEsc(v) + '</option>'; }).join('') + '</select><button class="so-btn" onclick="soMgrCopy()">Copy</button>';
    }
    h += '</div>';
  } else {
    h += '<p class="so-hint">Practical hours are recorded separately and are <b>not</b> added to clinical hours. Retire (untick Active) a practical that was cancelled after attendance was taken.</p>';
    h += '<div class="so-scroll"><table class="so-mgr"><thead><tr><th>Date</th><th>Title</th><th>Hours</th><th>Facilitator</th><th>Compulsory</th><th>Active</th><th></th></tr></thead><tbody>';
    m.practicals.forEach(function (p, i) {
      h += '<tr class="' + (p.active ? '' : 'retired') + '"><td><input data-p="' + i + '" data-k="date" type="date" value="' + soEsc(p.date) + '"></td>'
        + '<td><input data-p="' + i + '" data-k="title" value="' + soEsc(p.title) + '" style="min-width:260px"></td>'
        + '<td><input data-p="' + i + '" data-k="hours" type="number" step="0.25" min="0" style="width:64px" value="' + p.hours + '"></td>'
        + '<td><input data-p="' + i + '" data-k="facilitator" value="' + soEsc(p.facilitator) + '"></td>'
        + '<td style="text-align:center"><input data-p="' + i + '" data-k="compulsory" type="checkbox"' + (p.compulsory ? ' checked' : '') + '></td>'
        + '<td style="text-align:center"><input data-p="' + i + '" data-k="active" type="checkbox"' + (p.active ? ' checked' : '') + '></td>'
        + '<td><button class="so-x" title="Delete" onclick="soMgrDeletePrac(' + i + ')">✕</button></td></tr>';
    });
    h += '</tbody></table></div><div style="margin-top:8px"><button class="so-btn" onclick="soMgrAddPrac()">+ Add practical</button></div>';
  }
  var el = document.getElementById('soMgr');
  el.innerHTML = h;
  el.oninput = el.onchange = soMgrInput;
}

function soMgrInput(e) {
  var t = e.target, k = t.dataset.k; if (!k) return;
  var v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value;
  if (t.dataset.i != null) { var it = _soMgr.items[+t.dataset.i]; it[k] = v; _soMgr.dirtyItems[+t.dataset.i] = true; if (k === 'active') t.closest('tr').className = v ? '' : 'retired'; }
  if (t.dataset.p != null) { var p = _soMgr.practicals[+t.dataset.p]; p[k] = v; _soMgr.dirtyPracs[+t.dataset.p] = true; if (k === 'active') t.closest('tr').className = v ? '' : 'retired'; }
}
function soMgrTab(t) { _soMgr.tab = t; soMgrRender(); }
function soMgrAdd() {
  var last = _soMgr.items[_soMgr.items.length - 1];
  _soMgr.items.push({ id: '', cohort: currentCohort, category: last ? last.category : '', name: '', description: '', requiredCount: 1, optional: false, active: true, placementMatch: '', sortOrder: 0 });
  _soMgr.dirtyItems[_soMgr.items.length - 1] = true;
  soMgrRender();
}
function soMgrAddPrac() {
  _soMgr.practicals.push({ id: '', cohort: currentCohort, date: soToday(), title: '', hours: 2, facilitator: '', compulsory: true, active: true, sortOrder: 0 });
  _soMgr.dirtyPracs[_soMgr.practicals.length - 1] = true;
  soMgrRender();
}
function soMgrMove(i, dir) {
  var j = i + dir, a = _soMgr.items;
  if (j < 0 || j >= a.length) return;
  var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  // Renumber everything so the order saved is exactly what's shown
  a.forEach(function (it, k) { it.sortOrder = k + 1; _soMgr.dirtyItems[k] = true; });
  soMgrRender();
}
function soMgrCopy() {
  var from = document.getElementById('soCopyFrom').value;
  soStatus('Loading ' + from + ' list…');
  loadCohortSignoffs(from, function (d) {
    var src = d.items.filter(function (it) { return it.active; });
    if (!src.length) { soStatus('The ' + from + ' cohort has no sign-offs to copy.', 'error'); return; }
    src.forEach(function (it) {
      _soMgr.items.push(Object.assign({}, it, { id: '', cohort: currentCohort, sortOrder: 0 }));
      _soMgr.dirtyItems[_soMgr.items.length - 1] = true;
    });
    soStatus('Copied ' + src.length + ' sign-offs — adjust as needed, then Save changes.', 'success');
    soMgrRender();
  });
}
function soMgrDelete(i) {
  var it = _soMgr.items[i];
  if (!it.id) { _soMgr.items.splice(i, 1); soMgrReindexDirty('dirtyItems', i); soMgrRender(); return; }
  if (!confirm('Delete "' + it.name + '"? Only possible if no student has a record for it.')) return;
  if (!API_URL || usingDemo) { soMgrDeleted('items', i, it.id); return; }
  soPost({ action: 'deleteSignoffItem', itemId: it.id }, function (res) {
    if (!res.success) { soStatus(soErr(res), 'error'); return; }
    soMgrDeleted('items', i, it.id);
  });
}
function soMgrDeletePrac(i) {
  var p = _soMgr.practicals[i];
  if (!p.id) { _soMgr.practicals.splice(i, 1); soMgrReindexDirty('dirtyPracs', i); soMgrRender(); return; }
  if (!confirm('Delete "' + p.title + '"? Only possible if no attendance has been recorded.')) return;
  if (!API_URL || usingDemo) { soMgrDeleted('practicals', i, p.id); return; }
  soPost({ action: 'deletePractical', practicalId: p.id }, function (res) {
    if (!res.success) { soStatus(soErr(res), 'error'); return; }
    soMgrDeleted('practicals', i, p.id);
  });
}
function soMgrReindexDirty(key, removed) {
  var out = {};
  Object.keys(_soMgr[key]).forEach(function (k) { k = +k; if (k < removed) out[k] = true; else if (k > removed) out[k - 1] = true; });
  _soMgr[key] = out;
}
function soMgrDeleted(list, i, id) {
  _soMgr[list].splice(i, 1);
  soMgrReindexDirty(list === 'items' ? 'dirtyItems' : 'dirtyPracs', i);
  var d = signoffsData[currentCohort];
  if (d) d[list] = d[list].filter(function (x) { return x.id !== id; });
  soStatus('Deleted.', 'success');
  soMgrRender();
  render();
}

function soMgrSave() {
  var m = _soMgr;
  var items = Object.keys(m.dirtyItems).map(function (i) { return m.items[+i]; }).filter(Boolean);
  var pracs = Object.keys(m.dirtyPracs).map(function (i) { return m.practicals[+i]; }).filter(Boolean);
  if (items.some(function (it) { return !String(it.name || '').trim(); })) { soStatus('Every sign-off needs a name.', 'error'); return; }
  if (pracs.some(function (p) { return !String(p.title || '').trim(); })) { soStatus('Every practical needs a title.', 'error'); return; }
  if (!items.length && !pracs.length) { soStatus('No changes to save.'); return; }
  var btn = document.getElementById('soMgrSave');
  btn.disabled = true; btn.textContent = 'Saving…';
  // New items keep the on-screen order: number them after whatever is already saved
  var maxOrder = 0;
  m.items.forEach(function (it) { maxOrder = Math.max(maxOrder, it.sortOrder || 0); });
  m.items.forEach(function (it) { if (!it.sortOrder) it.sortOrder = ++maxOrder; });

  var steps = [];
  if (items.length) steps.push(function (next) {
    if (!API_URL || usingDemo) { items.forEach(function (it, k) { if (!it.id) it.id = 'DEMO-I' + Date.now() + k; }); next(); return; }
    soPost({ action: 'saveSignoffItems', items: items }, function (res) {
      if (!res.success) return next(soErr(res));
      items.forEach(function (it, k) { it.id = res.ids[k]; });
      next();
    });
  });
  if (pracs.length) steps.push(function (next) {
    if (!API_URL || usingDemo) { pracs.forEach(function (p, k) { if (!p.id) p.id = 'DEMO-P' + Date.now() + k; }); next(); return; }
    soPost({ action: 'savePracticals', practicals: pracs }, function (res) {
      if (!res.success) return next(soErr(res));
      pracs.forEach(function (p, k) { p.id = res.ids[k]; });
      next();
    });
  });
  (function run(i) {
    if (i >= steps.length) {
      var d = signoffsData[currentCohort];
      d.items = m.items.map(function (x) { return Object.assign({}, x); }).sort(function (a, b) { return a.sortOrder - b.sortOrder; });
      d.practicals = m.practicals.map(function (x) { return Object.assign({}, x); })
        .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      m.dirtyItems = {}; m.dirtyPracs = {};
      m.items = d.items.map(function (x) { return Object.assign({}, x); });
      m.practicals = d.practicals.map(function (x) { return Object.assign({}, x); });
      btn.disabled = false; btn.textContent = 'Save changes';
      soMgrRender();
      soStatus('Saved.', 'success');
      render();
      return;
    }
    steps[i](function (err) {
      if (err) { soStatus(err, 'error'); btn.disabled = false; btn.textContent = 'Save changes'; return; }
      run(i + 1);
    });
  })(0);
}

/* ===== Clinical record PDF (hours + practicals; supervisors only) ===== */

function printClinicalRecordPDF() {
  var sid = currentStudent;
  var btns = document.querySelectorAll('#summaryCards .so-btn.primary');
  btns.forEach(function (b) { b.disabled = true; b.textContent = 'Preparing…'; });
  loadStudentHours(sid, function (sessions) {
    loadStudentSignoffs(sid, function (so) {
      btns.forEach(function (b) { b.disabled = false; b.textContent = 'Clinical record PDF'; });
      var name = soStudentName(sid);
      var doc = buildClinicalRecordPDF({ id: sid, name: name, cohort: currentCohort }, sessions || [], so);
      pdfMake.createPdf(doc).download(String(name).replace(/[^a-zA-Z0-9 _-]/g, '') + ' — Clinical Record.pdf');
    });
  });
}

function buildClinicalRecordPDF(student, sessions, so) {
  var BLUE = '#185FA5', GRAY = '#666666', GREEN = '#3B6D11', AMBER = '#854F0B', RED = '#A32D2D';
  var hrsKeys = ['adultDxObs', 'adultDxTest', 'paedDxObs', 'paedDxTest', 'adultRehabObs', 'adultRehabTest',
    'paedRehabObs', 'paedRehabTest', 'otherObs', 'otherTest', 'orl', 'slt', 'simulation', 'supervision'];
  var agg = {}, pend = {}, pendingCount = 0;
  hrsKeys.forEach(function (k) { agg[k] = 0; pend[k] = 0; });
  sessions.forEach(function (s) {
    var dest = s.approved ? agg : pend;
    if (!s.approved) pendingCount++;
    hrsKeys.forEach(function (k) { dest[k] += (s.hrs && s.hrs[k]) || 0; });
  });
  var t = calcTotals(agg), tp = calcTotals(pend);
  var dates = sessions.map(function (s) { return s.date; }).filter(Boolean).sort();
  var line = function (w) { return { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: w || 0.5, lineColor: w ? BLUE : '#dddddd' }], margin: [0, 6, 0, 8] }; };
  var hdr = function (txt) { return { text: txt, fontSize: 9, color: BLUE, bold: true, characterSpacing: 1, margin: [0, 8, 0, 6] }; };
  var th = function (txt, align) { return { text: txt, bold: true, fontSize: 8.5, color: GRAY, alignment: align || 'left' }; };
  var tableLayout = { hLineWidth: function () { return 0.5; }, hLineColor: function () { return '#e5e5e5'; }, vLineWidth: function () { return 0; },
    paddingTop: function () { return 3; }, paddingBottom: function () { return 3; } };
  var content = [];

  content.push({ text: 'Clinical Training Record', fontSize: 18, bold: true, color: BLUE });
  content.push({ text: 'University of Auckland — Master of Audiology', fontSize: 9, color: GRAY, margin: [0, 2, 0, 0] });
  content.push(line(1.5));
  content.push({ table: { widths: [110, '*'], body: [
    [{ text: 'Student', color: GRAY, fontSize: 10 }, { text: student.name, bold: true, fontSize: 11 }],
    [{ text: 'Student ID', color: GRAY, fontSize: 10 }, { text: student.id, fontSize: 10 }],
    [{ text: 'Cohort', color: GRAY, fontSize: 10 }, { text: 'MAud ' + student.cohort, fontSize: 10 }],
    [{ text: 'Sessions recorded', color: GRAY, fontSize: 10 }, { text: sessions.length + (dates.length ? '  (' + soFmtDate(dates[0]) + ' – ' + soFmtDate(dates[dates.length - 1]) + ')' : ''), fontSize: 10 }],
    [{ text: 'Record generated', color: GRAY, fontSize: 10 }, { text: soFmtDate(soToday()), fontSize: 10 }]
  ] }, layout: 'noBorders' });

  // --- Hours ---
  content.push(hdr('CLINICAL HOURS'));
  var rows = [[th('Category'), th('Confirmed hours', 'right'), th('Requirement', 'right'), th('Status', 'right')]];
  HRS_TARGETS.forEach(function (tg) {
    var v = t[tg.key] || 0, req = '', status = 'Tracked', col = GRAY;
    if (tg.min != null) { req = '≥ ' + tg.min; status = v >= tg.min ? 'Met' : 'Not met'; col = v >= tg.min ? GREEN : RED; }
    if (tg.max != null) { req = '≤ ' + tg.max; status = v <= tg.max ? 'Within limit' : 'Over limit'; col = v <= tg.max ? GREEN : RED; }
    rows.push([{ text: tg.label, fontSize: 10, bold: tg.key === 'total' }, { text: soNum(v), fontSize: 10, alignment: 'right', bold: tg.key === 'total' },
      { text: req, fontSize: 10, alignment: 'right', color: GRAY }, { text: status, fontSize: 10, alignment: 'right', color: col }]);
  });
  content.push({ table: { headerRows: 1, widths: ['*', 90, 80, 80], body: rows }, layout: tableLayout });
  content.push({ text: 'Confirmed (supervisor-approved) hours only.' + (pendingCount
    ? ' ' + pendingCount + ' session' + (pendingCount !== 1 ? 's' : '') + ' (' + soNum(tp.total) + ' h towards the total) awaiting confirmation are not included.'
    : ''), fontSize: 8.5, color: pendingCount ? AMBER : GRAY, margin: [0, 4, 0, 0] });

  // --- Practicals ---
  var sum = soSummary(so, student.id);
  var pracs = so.practicals.filter(function (p) { return p.active || sum.att[p.id]; });
  content.push(hdr('PRACTICALS & TUTORIALS'));
  if (pracs.length) {
    content.push({ text: 'Attended ' + sum.pracAttended + ' of ' + sum.pracTotal + ' (' + soNum(sum.pracHours) + ' h). Practical hours are not included in the clinical hours above.', fontSize: 10, margin: [0, 0, 0, 4] });
    var pb = [[th('Date'), th('Practical'), th('Hours', 'right'), th('Status', 'right')]];
    pracs.forEach(function (p) {
      var st = sum.att[p.id] || 'Not recorded';
      pb.push([{ text: soFmtDate(p.date), fontSize: 9 }, { text: p.title, fontSize: 9 }, { text: soNum(p.hours), fontSize: 9, alignment: 'right' },
        { text: st, fontSize: 9, alignment: 'right', color: st === 'Attended' ? GREEN : st === 'Excused' ? AMBER : st === 'Absent' ? RED : GRAY }]);
    });
    content.push({ table: { headerRows: 1, dontBreakRows: true, widths: [62, '*', 40, 70], body: pb }, layout: tableLayout });
  } else {
    content.push({ text: 'No practicals recorded.', fontSize: 10, color: GRAY });
  }

  // --- Sign-off block ---
  content.push({ unbreakable: true, margin: [0, 28, 0, 0], stack: [
    { text: 'Confirmed by course coordinator', fontSize: 9, color: GRAY, margin: [0, 0, 0, 22] },
    { columns: [
      { stack: [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 220, y2: 0, lineWidth: 0.5 }] }, { text: 'Signature', fontSize: 8, color: GRAY, margin: [0, 3, 0, 0] }] },
      { stack: [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 140, y2: 0, lineWidth: 0.5 }] }, { text: 'Date', fontSize: 8, color: GRAY, margin: [0, 3, 0, 0] }] }
    ] }
  ] });

  return {
    content: content, pageSize: 'A4', pageMargins: [40, 40, 40, 44],
    defaultStyle: { font: 'Roboto', color: '#1a1a1a' },
    info: { title: student.name + ' — Clinical Training Record' },
    footer: function (page, pages) {
      return { columns: [{ text: student.name + ' · ' + student.id, fontSize: 8, color: GRAY }, { text: 'Page ' + page + ' of ' + pages, fontSize: 8, color: GRAY, alignment: 'right' }], margin: [40, 12, 40, 0] };
    }
  };
}
