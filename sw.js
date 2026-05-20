// Taskra - Service Worker v8 (push notifications enabled)
const CACHE_NAME = 'taskra-v31';

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

// ===== Push 通知 =====
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Taskra', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Taskra';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: {
      url: data.url || '/',
      taskId: data.taskId || null,
      kind: data.kind || null
    },
    requireInteraction: !!data.requireInteraction
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  const taskId = event.notification.data && event.notification.data.taskId;
  const fullUrl = taskId ? (targetUrl + (targetUrl.includes('?') ? '&' : '?') + 'task=' + encodeURIComponent(taskId)) : targetUrl;

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 既に開いているウィンドウがあればフォーカス
    for (const c of allClients) {
      if (c.url.includes(self.location.origin)) {
        await c.focus();
        if (taskId) {
          try { c.postMessage({ type: 'OPEN_TASK', taskId }); } catch (e) {}
        }
        return;
      }
    }
    // なければ新規ウィンドウ
    if (clients.openWindow) {
      await clients.openWindow(fullUrl);
    }
  })());
});

// 購読が無効化されたら再購読
self.addEventListener('pushsubscriptionchange', (event) => {
  // 端末側で再subscribeはフロントで対応するのでログのみ
  console.log('pushsubscriptionchange', event);
});
