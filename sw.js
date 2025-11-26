const CACHE_NAME = 'nicotracker-v2.1';
const APP_SHELL = [
  './',
  './index.html',
  './data.js',    // <--- PŘIDÁNO: Nový datový soubor
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;
  
  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Cache-First strategie pro statické soubory (rychlejší start)
      // ale Network-First pro API (pokud bys nějaké měl)
      return cached || fetch(event.request).then(response => {
         return caches.open(CACHE_NAME).then(cache => {
             cache.put(event.request, response.clone());
             return response;
         });
      });
    })
  );
});
