// オフライン対応: アプリ本体のファイルを端末にキャッシュする（記録データはキャッシュせず IndexedDB に保存）。
// 更新したら VERSION を上げる。
const VERSION = 'v0.1.0';
const CACHE = 'manga-progress-' + VERSION;
const FILES = [
  './', './index.html', './help.html', './app.js', './store.js', './style.css', './manifest.webmanifest',
  './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png',
  './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('manga-progress-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// キャッシュ優先（オフラインでも起動できる）。無ければネットから取ってキャッシュする
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const hit = await caches.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
      return res;
    } catch (err) {
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      throw err;
    }
  })());
});
