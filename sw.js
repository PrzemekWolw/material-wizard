// Network first, so a deploy shows up on the next load; the cache only serves when offline.
const CACHE = 'material-wizard';
const SHELL = [
  './',
  'index.html',
  'app.js',
  'version.js',
  'src/engine/classes.js',
  'src/engine/engine.js',
  'src/engine/fields.js',
  'src/engine/hdr.js',
  'src/engine/lit.js',
  'src/engine/maps.js',
  'src/engine/sky.js',
  'src/engine/targets.js',
  'src/export.js',
  'src/jobs.js',
  'src/work.worker.js',
  'src/services/worker.js',
  'src/modules/batch.js',
  'src/modules/curve.js',
  'src/modules/terrain.js',
  'src/modules/layers.js',
  'src/modules/tooltip.js',
  'src/modules/exporter.js',
  'src/modules/hdr.js',
  'src/modules/layout.js',
  'src/modules/phone.js',
  'src/modules/pick.js',
  'src/modules/project.js',
  'src/modules/render.js',
  'src/modules/slots.js',
  'src/modules/sun.js',
  'src/modules/tiling.js',
  'src/modules/view.js',
  'src/modules/zones.js',
  'src/services/history.js',
  'src/services/i18n.js',
  'src/services/presets.js',
  'src/services/state.js',
  'src/shaders/albedo.glsl.js',
  'src/shaders/basic.glsl.js',
  'src/shaders/common.glsl.js',
  'src/shaders/lit.glsl.js',
  'src/shaders/post.glsl.js',
  'src/shaders/sky.glsl.js',
  'src/shaders/surface.glsl.js',
  'src/shaders/terrain.glsl.js',
  'src/tile/blend.js',
  'src/tile/bomb.js',
  'src/tile/repeat.js',
  'src/tile-editor.js',
  'src/tile/fft.js',
  'src/tile/geometry.js',
  'src/tile/index.js',
  'src/tile/lights.js',
  'src/tile/seam.js',
  'src/utils/color.js',
  'src/utils/lut.js',
  'src/utils/terrain.js',
  'src/utils/images.js',
  'src/utils/sizes.js',
  'styles/base.css',
  'styles/controls.css',
  'styles/layout.css',
  'styles/maps.css',
  'styles/motion.css',
  'styles/panels.css',
  'styles/phone.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  '../style.css',
  'locales/en_US/main.translation.json',
  'locales/pl_PL/main.translation.json',
  'locales/es_ES/main.translation.json',
  'locales/de_DE/main.translation.json',
  'locales/it_IT/main.translation.json',
  'locales/zh_CN/main.translation.json',
  'locales/ja_JP/main.translation.json',
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
