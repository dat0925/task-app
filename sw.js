// Taskra - Service Worker v63 (stale-while-revalidate)
const CACHE_NAME = 'taskra-v77';
const CDN_CACHE  = 'taskra-cdn-v33';

// キャッシュするアセット
const APP_ASSETS = ['./', './index.html', './icon-192.png', './icon-512.png'];
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
  'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js',
];

// インストール: アプリ本体とCDNを先読みキャッシュ
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then(c =>
        // HTTP キャッシュ（GitHub Pages は max-age=600）を通すと、新しい SW に古い index.html が入ることがある
        c.addAll(APP_ASSETS.map(u => new Request(u, { cache: 'reload' }))).catch(() => {})
      ),
      caches.open(CDN_CACHE).then(c =>
        Promise.all(CDN_ASSETS.map(url =>
          c.add(url).catch(() => {}) // CDN失敗しても続行
        ))
      ),
    ])
  );
});

// アクティベート: 古いキャッシュを削除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== CDN_CACHE)
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
    .then(async () => {
      // 新SWが有効化されたら全クライアントにリロード指示を送る
      const all = await self.clients.matchAll({ type: 'window' });
      all.forEach(c => c.postMessage({ type: 'SW_UPDATED' }));
    })
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // CDNアセット → cache-first（CDNは内容が変わらないので）
  if (CDN_ASSETS.includes(event.request.url)) {
    event.respondWith(
      caches.open(CDN_CACHE).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const fresh = await fetch(event.request);
        if (fresh.ok) cache.put(event.request, fresh.clone());
        return fresh;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Supabase API / 外部API → network-only（キャッシュしない）
  if (url.hostname.includes('supabase.co') ||
      url.hostname.includes('googleapis.com') ||
      url.protocol === 'chrome-extension:' ||
      event.request.method !== 'GET') {
    event.respondWith(fetch(event.request).catch(() => new Response('offline', {status: 503})));
    return;
  }

  // 画面遷移（index.html）→ network-first。オンラインなら必ず最新版を返し、失敗・遅延時だけキャッシュ。
  // 以前は stale-while-revalidate だったため、修正を出しても「開いた1回目は旧版」になり、
  // 障害対応（2026-09-29 のメンテナンス表示）がスマホ・PWA に届かなかった。
  if (url.origin === self.location.origin &&
      (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html'))) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const net = fetch(event.request, { cache: 'no-cache' }).then(fresh => {
          if (fresh.ok) cache.put(event.request, fresh.clone());
          return fresh;
        });
        // 電波が弱いときに白画面で待たせないよう、4秒でキャッシュに切り替える
        const timeout = new Promise(r => setTimeout(() => r(null), 4000));
        try {
          const fresh = await Promise.race([net, timeout]);
          if (fresh) return fresh;
        } catch (e) {}
        const cached = await cache.match(event.request) || await cache.match('./index.html');
        return cached || net;
      })
    );
    return;
  }

  // その他のアプリ本体（アイコン等）→ stale-while-revalidate
  // キャッシュから即座に返しつつ、バックグラウンドで更新
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(event.request);
        const fetchPromise = fetch(event.request).then(fresh => {
          if (fresh.ok) cache.put(event.request, fresh.clone());
          return fresh;
        }).catch(() => null);

        return cached || fetchPromise; // キャッシュがあれば即返す
      })
    );
    return;
  }

  // その他 → network-first
  event.respondWith(fetch(event.request).catch(() => new Response('offline', {status: 503})));
});

// ===== Push通知（既存のまま） =====
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) { data = { title:'Taskra', body: event.data?.text()||'' }; }
  const title = data.title || 'Taskra';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url||'/', taskId: data.taskId||null, kind: data.kind||null },
    requireInteraction: !!data.requireInteraction,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  const taskId = event.notification.data && event.notification.data.taskId;
  const fullUrl = taskId ? (targetUrl + (targetUrl.includes('?') ? '&' : '?') + 'task=' + encodeURIComponent(taskId)) : targetUrl;
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type:'window', includeUncontrolled:true });
    for (const c of allClients) {
      if (c.url.includes(self.location.origin)) {
        await c.focus();
        if (taskId) { try { c.postMessage({ type:'OPEN_TASK', taskId }); } catch(e) {} }
        return;
      }
    }
    if (clients.openWindow) await clients.openWindow(fullUrl);
  })());
});

self.addEventListener('pushsubscriptionchange', event => {
  console.log('pushsubscriptionchange', event);
});
