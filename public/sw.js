self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text?.() || '' }; }
  const title = String(payload.title || 'AFK Bank').slice(0, 100);
  const options = {
    body: String(payload.body || 'У тебе нове сповіщення.').slice(0, 240),
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    tag: 'afk-bank-notice',
    renotify: false,
    data: { url: typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
