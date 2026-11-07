// Piano Trainer service worker: works offline and receives files shared from other apps.
const CACHE = 'pt-v1';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'listener.js', 'vendor.js',
  'model/model.json', 'model/group1-shard1of1.bin', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'pt-share').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // "Share → Piano Trainer" from another app
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith((async () => {
      const fd = await e.request.formData();
      const c = await caches.open('pt-share');
      const f = fd.get('audio');
      if (f && f.size) await c.put('shared-file', new Response(f, { headers: { 'x-name': encodeURIComponent(f.name || 'Shared song') } }));
      else await c.put('shared-text', new Response(String(fd.get('text') || fd.get('url') || fd.get('title') || '')));
      return Response.redirect('./?share=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || /\/(api|songs|tmp)\//.test(url.pathname)) return;
  // network first (always up to date when online), cache when offline
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
