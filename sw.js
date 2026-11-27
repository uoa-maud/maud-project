/*
 * Minimal service worker — makes the site installable and lets the app shell open offline.
 *
 * Deliberately conservative so it can never serve stale code while online:
 *  - Our own files (HTML/JS/CSS/icons): NETWORK-FIRST. The cache is only read when the
 *    network fails, and is refreshed on every successful fetch.
 *  - Everything else (Apps Script API, Google sign-in, cdnjs, POSTs) is not touched at
 *    all — cdnjs is already cached long-term by the browser's normal HTTP cache.
 *
 * Kill switch: if this ever misbehaves, replace this file's contents with
 *   self.addEventListener('install', () => self.skipWaiting());
 *   self.addEventListener('activate', e => e.waitUntil(
 *     caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))))
 *       .then(() => self.registration.unregister())));
 * and push — browsers re-check sw.js on every navigation.
 */
var CACHE = 'maud-shell-v1';

self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then(function (res) {
          if (res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        })
        .catch(function () {
          return caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(function (hit) {
            return hit || new Response(
              '<!doctype html><meta name="viewport" content="width=device-width"><title>Offline</title>' +
              '<p style="font-family:sans-serif;padding:24px">You\'re offline. Reconnect and try again.</p>',
              { status: 503, headers: { 'Content-Type': 'text/html' } });
          });
        })
    );
  }
});
