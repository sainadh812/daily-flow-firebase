// SW SELF-DESTRUCT v2 — clears all caches and unregisters itself
// The app does not need a service worker. Firebase handles sync.
// A caching SW causes stale files after every deploy — removing it permanently.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll())
      .then(clients => clients.forEach(c => c.navigate(c.url)))
  );
});
