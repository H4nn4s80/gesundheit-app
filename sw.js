/* Gesundheit 1.0 · Build 5. Es werden ausschließlich öffentliche App-Dateien und verschlüsselte Daten gecacht. */
const CACHE='gesundheit-v1-0-b5';
const FILES=['index.html','manifest.webmanifest','apple-touch-icon.png','icon-192.png','icon-512.png','data.enc.json'];
const root=new URL('./',self.location.href);
self.addEventListener('install',event=>event.waitUntil((async()=>{let c=await caches.open(CACHE);await c.addAll(FILES.map(f=>new Request(new URL(f,root),{cache:'reload'})));await self.skipWaiting()})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(let k of await caches.keys())if(k.startsWith('gesundheit-')&&k!==CACHE)await caches.delete(k);await self.clients.claim()})()));
self.addEventListener('fetch',event=>{let req=event.request,url=new URL(req.url);if(req.method!=='GET'||url.origin!==root.origin||!url.pathname.startsWith(root.pathname))return;let name=url.pathname.slice(root.pathname.length);if(req.mode==='navigate')name='index.html';if(!FILES.includes(name))return;
 event.respondWith((async()=>{let cache=await caches.open(CACHE),key=new URL(name,root).href;let net=fetch(key,{cache:'no-store'}).then(async r=>{if(r.ok)await cache.put(key,r.clone());return r});event.waitUntil(net.catch(()=>{}));try{let r=await Promise.race([net,new Promise(resolve=>setTimeout(()=>resolve(null),3000))]);if(r&&r.ok)return r}catch{}let hit=await cache.match(key);if(hit)return hit;return new Response('Offline-Datei noch nicht vorhanden',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}})})())});
