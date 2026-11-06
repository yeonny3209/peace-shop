/* 피스 상점 서비스워커 — 새 구매 요청 알림을 받아 보여 준다. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { /* 본문 없음 */ }
  e.waitUntil(self.registration.showNotification(data.title || '피스 상점', {
    body: data.body || '새 요청이 왔어요',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'peace-request',
    renotify: true,
    data: { url: data.url || '/#admin' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/#admin', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
        c.navigate(url).catch(() => {});
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
