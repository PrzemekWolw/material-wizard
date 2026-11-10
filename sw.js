// Network first, so a deploy shows up on the next load; the cache only serves when offline.
const CACHE = 'material-wizard';
const SHELL = [
  './',
  'index.html',
  'app.js',
  'pbr.js',
  'tile.js',
  'tile-editor.js',
  'export.js',
  'version.js',
  'material-wizard.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  '../style.css',
  'locales/en_US/main.translation.json',
  'locales/pl_PL/main.translation.json',
  'locales/es_ES/main.translation.json',
  'locales/de_DE/main.translation.json',
  'locales/it_IT/main.translation.json',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith('http')) return;
  event.respondWith(fetch(request).then((response) => {
    if (response.ok || response.type === 'opaque') {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  }).catch(() => caches.match(request, { ignoreSearch: true })));
});
