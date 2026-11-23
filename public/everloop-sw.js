const CACHE = 'everloop-public-v1';
const OFFLINE = '/everloop/offline.html';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.add(OFFLINE)));
});

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys
      .filter(key => key.startsWith('everloop-public-') && key !== CACHE)
      .map(key => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

// Authenticated pages, API results and media never enter this cache.
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(OFFLINE)) ?? Response.error();
  }));
});

self.addEventListener('push', event => {
  let inbox = '/inbox';
  try {
    const id = event.data?.json()?.conversation;
    if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) inbox += '?c=' + id;
  } catch {
    // A malformed payload can still open the authenticated inbox.
  }
  event.waitUntil(self.registration.showNotification('Everloop', {
    icon: '/everloop/icon-192.png',
    tag: 'everloop-inbox',
    data: { inbox },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const relative = event.notification.data?.inbox;
  const path = typeof relative === 'string' && /^\/inbox(?:\?c=[0-9a-f-]{36})?$/i.test(relative) ? relative : '/inbox';
  const url = new URL(path, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
    const inbox = windows.find(client => new URL(client.url).pathname === '/inbox');
    if (inbox) {
      const client = await inbox.navigate(url);
      if (client) return client.focus();
    }
    return self.clients.openWindow(url);
  }));
});
