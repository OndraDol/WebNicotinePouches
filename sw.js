// ZMĚNA VERZE ZDE DONUTÍ PROHLÍŽEČ STÁHNOUT NOVOU VERZI APLIKACE
const CACHE_NAME = 'nicotracker-v3.0'; 

const APP_SHELL = [
  './',
  './index.html',
  './data.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting(); // Důležité: okamžitě aktivovat nový SW
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim(); // Důležité: převzít kontrolu nad otevřenými stránkami
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;
  
  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Network-first strategie pro index.html zajistí, že uživatel má vždy nejnovější verzi,
      // pokud je online. Pokud je offline, použije se cache.
      if (event.request.url.includes('index.html')) {
         return fetch(event.request)
            .then(response => {
                const resClone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
                return response;
            })
            .catch(() => cached);
      }

      return cached || fetch(event.request).then(response => {
         return caches.open(CACHE_NAME).then(cache => {
             cache.put(event.request, response.clone());
             return response;
         });
      });
    })
  );
});
