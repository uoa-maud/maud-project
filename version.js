/*
 * Site version footer. Bump SITE_VERSION on every frontend push (format YYYY.MM.DD,
 * add .2/.3 for repeat pushes on one day) so a successful publish is visible at a glance.
 * On pages that define API_URL it also shows the live Apps Script API_VERSION, and the
 * tooltip shows when the sheet data last changed (useful for checking the cache).
 */
var SITE_VERSION = '2026.11.23';

(function () {
  function render() {
    var el = document.createElement('div');
    el.id = 'versionFooter';
    el.style.cssText = 'text-align:center;font-size:11px;padding:16px;color:var(--text-hint,#888);font-family:var(--font,inherit)';
    el.textContent = 'Site v' + SITE_VERSION;
    document.body.appendChild(el);

    if (typeof API_URL === 'undefined') return;
    fetch(API_URL + '?action=version')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        el.textContent = 'Site v' + SITE_VERSION + ' · API v' + (d.apiVersion || '?');
        var dv = Number(d.dataVersion);
        if (dv) el.title = 'Data last changed: ' + new Date(dv).toLocaleString();
      })
      .catch(function () { el.textContent = 'Site v' + SITE_VERSION + ' · API unreachable'; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
