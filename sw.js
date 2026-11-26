/* Gesundheit 2.9: App-Dateien und das verschlüsselte Datenpaket offline verfügbar halten.
   Skript und Styles tragen die Version im Namen (?v=), damit nie Teile verschiedener Versionen zusammen laufen. */
const VERSION = '2.9';
const CACHE = 'gesundheit-v' + VERSION.replace('.', '-');
const ASSETS = ['app.css', 'coach.js', 'app.js'].map(f => f + '?v=' + VERSION);
const FILES = ['index.html', ...ASSETS, 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'data.enc.json'];
const root = new URL('./', self.location.href);
self.addEventListener('install', e => e.waitUntil((async () => {
  const c = await caches.open(CACHE);
  await Promise.all(FILES.map(f => c.add(new Request(new URL(f, root), { cache: 'reload' })).catch(() => {})));
  await self.skipWaiting();
})()));
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('gesundheit-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return;
  let name = url.pathname.slice(root.pathname.length) + url.search;
  if (req.mode === 'navigate') name = 'index.html';
  if (!FILES.includes(name)) return;
  const key = new URL(name, root).href;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Versionierte Dateien ändern sich nie: zuerst aus dem Speicher.
    if (ASSETS.includes(name)) {
      const hit = await cache.match(key);
      if (hit) return hit;
    }
    const net = fetch(key, { cache: 'no-store' }).then(async r => { if (r.ok) await cache.put(key, r.clone()); return r; });
    e.waitUntil(net.catch(() => {}));
    try { const r = await Promise.race([net, new Promise(res => setTimeout(() => res(null), 3000))]); if (r && r.ok) return r; } catch {}
    const hit = await cache.match(key);
    if (hit) return hit;
    try { return await net; } catch {}
    return new Response('Offline noch nicht verfügbar', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
