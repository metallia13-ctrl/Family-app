// Service worker: rende l'app installabile e apribile anche con rete debole.
// Prima prova la rete (così gli aggiornamenti arrivano subito), poi la copia salvata.
// Notifiche push (Firebase Cloud Messaging): mostra le notifiche anche ad app chiusa.
try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js', 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js', 'config.js');
  firebase.initializeApp(CFG); firebase.messaging();
} catch (e) { }
const C = 'famiglia-v4';
const FILES = ['./', './index.html', './style.css', './app.js', './config.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x != C).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method != 'GET' || u.origin != location.origin) return; // Firebase e Google non vengono toccati
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
