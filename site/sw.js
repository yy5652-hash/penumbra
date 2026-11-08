// Relative URLs keep the installed app inside its GitHub Pages sub-path.
const SHELL='penumbra-shell-v3-1',RUNTIME='penumbra-runtime-v3-1';
const shell=['./','index.html','app.js','site-state.js','forecast.js','style.css','vendor/uPlot.esm.js','vendor/uPlot.min.css','manifest.webmanifest','icons/moon-192.png','icons/moon-512.png','model/weather_h1.json','data/shifts.json'];
self.addEventListener('install',event=>event.waitUntil((async()=>{
  await (await caches.open(SHELL)).addAll(shell);await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys())if(/^penumbra-(shell|runtime)-/.test(key)&&![SHELL,RUNTIME].includes(key))await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url),own=url.origin===self.location.origin;
  const weather=['https://previous-runs-api.open-meteo.com','https://api.open-meteo.com'].includes(url.origin);
  if(request.method!=='GET'||(!own&&!weather))return;
  event.respondWith((async()=>{
    const cache=await caches.open(RUNTIME);
    try {
      const response=await fetch(request);
      if(response.ok){
        const copy=response.clone();
        // Never turn a successful forecast into a failure because storage is full.
        event.waitUntil((async()=>{
          try {
            await cache.put(request,copy);
            if(weather){const keys=(await cache.keys()).filter(k=>new URL(k.url).origin!==self.location.origin);for(const key of keys.slice(0,-32))await cache.delete(key);}
          }catch{/* Cache is optional. */}
        })());
      }
      return response;
    }catch(error){
      const saved=await cache.match(request)||await (await caches.open(SHELL)).match(request);
      if(saved){
        if(weather){const headers=new Headers(saved.headers);headers.set('X-Penumbra-Offline','true');return new Response(await saved.arrayBuffer(),{status:saved.status,headers});}
        return saved;
      }
      if(request.mode==='navigate')return await (await caches.open(SHELL)).match(new URL('index.html',self.registration.scope));
      throw error;
    }
  })());
});
