/*
 * Keeps the app's own files on the phone so it opens at once, even offline. Each file is answered from the saved copy
 * and checked against the server in the background; when a file has changed the page is told, and the new version
 * runs the next time the app is opened. Ororo's API, posters and video are never touched, and neither are pull
 * request previews (/pr-preview/), which must always show the branch they were built from.
 */
var CACHE = 'ororo-app-v1';
var SHELL = ['', 'index.html', 'style.css', 'app.js', 'seek.js', 'icon.png', 'apple-touch-icon.png', 'manifest.webmanifest'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u || './', { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function changed(a, b) {
  var x = a.headers.get('etag') || a.headers.get('last-modified'), y = b.headers.get('etag') || b.headers.get('last-modified');
  return !!(x && y && x !== y);
}

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url), scope = new URL(self.registration.scope).pathname;
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.indexOf('/pr-preview/') >= 0) return;
  if (url.pathname.indexOf(scope) !== 0 || SHELL.indexOf(url.pathname.slice(scope.length)) < 0) return;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      var fresh = fetch(req, { cache: 'no-cache' }).then(function (res) {
        if (!res.ok) return hit || res;
        if (hit && changed(hit, res)) {
          self.clients.matchAll().then(function (cs) { cs.forEach(function (c) { c.postMessage({ type: 'updated' }); }); });
        }
        return cache.put(req, res.clone()).then(function () { return res; });
      }).catch(function () { return hit; });
      e.waitUntil(fresh.catch(function () {}));
      return hit || fresh;
    });
  }));
});
