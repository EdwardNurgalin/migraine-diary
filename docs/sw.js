// Keeps the whole app on the phone so it opens instantly and works without internet.
//
// The app always starts from the stored copy of the current version (no waiting for the network, which on
// weak mobile internet could leave a blank screen). A new release arrives as a whole: the browser notices a
// changed sw.js, this worker downloads every file of the new version fresh, takes over, and the page reloads
// once into it. Files of two versions are never mixed.
// Bump VERSION on every release so phones pick up the new files.
const VERSION = 'diary-v21';
const SHELL = [
  './', './index.html', './style.css', './app.js', './api.js', './config.js', './stats.js', './store.js', './weather.js', './import.js',
  './manifest.webmanifest', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' skips the HTTP cache, so the new version is stored complete and current.
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true }) || (e.request.mode === 'navigate' && await c.match('./'));
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    } catch {
      return c.match('./');
    }
  }));
});
