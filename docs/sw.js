// Keeps the whole app on the phone so it opens instantly and works without internet.
// Bump VERSION on every release so phones pick up the new files.
const VERSION = 'diary-v13';
const SHELL = [
  './', './index.html', './style.css', './app.js', './api.js', './config.js', './stats.js', './store.js', './weather.js',
  './manifest.webmanifest', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Weather and geocoding go straight to the network.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first so a new release shows up right away (no-cache: revalidate, don't trust the HTTP cache);
  // the cached copy when offline.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./')))
  );
});
