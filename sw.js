'use strict';

// The production build substitutes a hash of the complete shell here.
const SHELL_VERSION = 'development-v3';
const CACHE_PREFIX = 'dailyflow-shell-';
const CACHE_NAME = CACHE_PREFIX + SHELL_VERSION;
const SHELL_FILES = [
  'index.html', 'app.html', 'style.css', 'app.js', 'firebase-init.js', 'manifest.json',
  'sync-client.js', 'shared/sync-core.js', 'web-workflows.js',
  'vendor/firebase-sdk.js', 'vendor/xlsx.full.min.js',
];
const shellUrls = SHELL_FILES.map(file => new URL(file, self.registration.scope).href);
const shellByPath = new Map(shellUrls.map(url => [new URL(url).pathname, url]));
shellByPath.set(new URL(self.registration.scope).pathname, new URL('index.html', self.registration.scope).href);

self.addEventListener('install', event => {
  // Installation is atomic: a failed asset fetch leaves the previous worker in place.
  // A new version waits until existing tabs close; it never interrupts active work.
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(
    shellUrls.map(url => new Request(url, {cache:'reload',credentials:'same-origin'}))
  )));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const asset = shellByPath.get(url.pathname);
  if (!asset) return; // No API, auth handler, user document, or arbitrary URL is cached.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const saved = await cache.match(asset);
    return saved || fetch(request);
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'ping') event.source?.postMessage({type:'shell-status',version:SHELL_VERSION});
});
