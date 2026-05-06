// Taskra - Service Worker v6
const CACHE_NAME = 'taskra-v30';
const STATIC_ASSETS = [
  '/task-app/',
  '/task-app/index.html',
  '/task-app/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS.map(url => new Request(url, { mode: 'no-cors' }))).catch(()=>{});
    }).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  // ナビゲーションリクエストは index.html を返す（ハッシュはブラウザ側で処理）
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('/task-app/index.html').then(cached => {
        return fetch('/task-app/index.html').then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put('/task-app/index.html', clone));
          }
          return response;
        }).catch(() => cached);
      })
    );
    return;
  }

  // その他（JS/CSS/画像など）はキャッシュ優先
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
