// MERIDIAN Service Worker — enables PWA install prompt
const CACHE = 'meridian-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Network-first strategy: always fetch fresh, fall back to cache for the HTML shell
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Only cache the app shell (HTML page)
  if (url.pathname === '/' || url.pathname === '/meridian-app.html') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  }
  // All other requests (API calls, fonts) pass through untouched
});
