const CACHE_NAME = 'pouchlog-v1.12';

const APP_SHELL = [
  './',
  './index.html',
  './data.js',
  './app-core.mjs',
  './manifest.json',
  './favicon.ico',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './maskable-icon.png',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Public+Sans:wght@400;500;600;700;800&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

const isDocumentRequest = (request) =>
  request.mode === 'navigate' || request.destination === 'document' || request.headers.get('accept')?.includes('text/html');

function isMutableAppRequest(request) {
  const url = new URL(request.url);
  return url.origin === self.location.origin && ['/data.js', '/app-core.mjs'].includes(url.pathname);
}

async function putSuccessfulResponse(request, response) {
  if (response && (response.ok || response.type === 'opaque')) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return await putSuccessfulResponse(request, response);
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (isDocumentRequest(request)) return caches.match('./index.html');
    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const networkResponse = fetch(request)
    .then((response) => putSuccessfulResponse(request, response))
    .catch(() => null);
  return cached || await networkResponse || Response.error();
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  if (isDocumentRequest(event.request) || isMutableAppRequest(event.request)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const client = clientList.find((c) => c.visibilityState === 'visible');
      if (client) {
        return client.focus();
      }
      return clients.openWindow('./');
    })
  );
});
