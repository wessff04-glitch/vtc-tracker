importScripts('/js/app-version.js');

const CACHE_NAME = `vtc-tracker-${self.APP_VERSION || 'v1'}`;
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/inscription.html',
    '/dashboard-chauffeur.html',
    '/dashboard-admin.html',
    '/mes-courses.html',
    '/statistiques.html',
    '/style.css',
    '/mobile.css',
    '/css/admin.css',
    '/js/firebase-config.js',
    '/js/app-version.js',
    '/js/auth.js',
    '/js/session.js',
    '/js/course.js',
    '/js/stats.js',
    '/js/admin.js',
    '/js/geo-utils.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) return caches.delete(cacheName);
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        caches.open(CACHE_NAME).then(cache => {
            return cache.match(event.request).then(response => {
                const fetchPromise = fetch(event.request).then(networkResponse => {
                    try{
                        if (networkResponse && networkResponse.status === 200) {
                            cache.put(event.request, networkResponse.clone());
                        }
                    }catch(e){}
                    return networkResponse;
                }).catch(() => response);

                return response || fetchPromise;
            });
        })
    );
});
