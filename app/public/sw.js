// Installable-PWA service worker. No offline caching -- this app is only
// useful when it can reach the server -- but it does own two things that
// only a service worker can do: receiving Web Push while the app isn't
// open, and reacting to a tap on that notification.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = { title: '🍾 bottlecaps', body: 'Timer expired.' };
  if (event.data) {
    try { data = event.data.json(); } catch (e) { /* fall back to default */ }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: 'bottlecaps-expired',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
      const existing = all.find((c) => 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow('/');
    })
  );
});
