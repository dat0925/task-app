// Taskra - Service Worker v7 (cache disabled)
const CACHE_NAME = 'taskra-v30';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// キャッシュを使わず常にネットワークから取得
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request).catch(() => new Response('offline')));
});
