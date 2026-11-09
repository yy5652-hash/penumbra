import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../sw.js',import.meta.url),'utf8');
function worker() {
  const scope='http://localhost/penumbra/',handlers={},stores=new Map(),state={online:true,quota:false,claimed:false};
  const address=r=>new URL(typeof r==='string'?r:(r.url??r.href),scope).href;
  const caches={
    async open(name){
      if(!stores.has(name))stores.set(name,new Map());const store=stores.get(name);
      return {
        async addAll(urls){for(const url of urls)store.set(address(url),new Response(`shell:${url}`));},
        async put(request,response){if(state.quota)throw Error('QuotaExceeded');store.set(address(request),response.clone());},
        async match(request){return store.get(address(request))?.clone();},
        async keys(){return [...store.keys()].map(url=>({url}));},
        async delete(request){return store.delete(address(request));}
      };
    },
    async keys(){return [...stores.keys()];},async delete(name){return stores.delete(name);}
  };
  const self={location:new URL(scope),registration:{scope},clients:{async claim(){state.claimed=true;}},async skipWaiting(){},addEventListener:(name,fn)=>{handlers[name]=fn;}};
  vm.runInNewContext(source,{self,caches,URL,Headers,Response,fetch:async()=>{if(!state.online)throw Error('Offline');return new Response('fresh weather');}});
  return {state,stores,caches,async send(name,request){
    const pending=[];let response;
    handlers[name]({request,waitUntil:p=>pending.push(p),respondWith:p=>{response=p;}});
    const result=response?await response:undefined;await Promise.all(pending);return result;
  }};
}
test('Service worker precaches relative shell/model, claims scope and preserves saved forecast cache',async()=>{
  const w=worker();await w.caches.open('penumbra-shell-old');await w.caches.open('penumbra-saved-v3');await w.send('install');await w.send('activate');
  assert.equal(w.state.claimed,true);assert.equal(w.stores.has('penumbra-shell-old'),false);assert.equal(w.stores.has('penumbra-saved-v3'),true);
  const keys=[...w.stores.get('penumbra-shell-v4-1').keys()];assert.ok(keys.every(k=>k.startsWith('http://localhost/penumbra/')));assert.ok(keys.includes('http://localhost/penumbra/model/weather_h1.json'));
  w.state.online=false;
  const saved=await w.send('fetch',{method:'GET',url:'http://localhost/penumbra/?installed=1',mode:'navigate'});
  assert.equal(await saved.text(),'shell:index.html');
});
test('Service worker caches weather and marks offline fallback; map tiles stay uncached',async()=>{
  const w=worker(),request={method:'GET',url:'https://api.open-meteo.com/v1/forecast?tilt=40',mode:'cors'};
  assert.equal(await (await w.send('fetch',request)).text(),'fresh weather');w.state.online=false;
  const offline=await w.send('fetch',request);assert.equal(offline.headers.get('X-Penumbra-Offline'),'true');assert.equal(await offline.text(),'fresh weather');
  assert.equal(await w.send('fetch',{method:'GET',url:'https://tile.openstreetmap.org/1/1/1.png'}),undefined);
});
test('Cache quota failure does not break online forecasting',async()=>{
  const w=worker();w.state.quota=true;
  assert.equal(await (await w.send('fetch',{method:'GET',url:'https://previous-runs-api.open-meteo.com/v1/forecast',mode:'cors'})).text(),'fresh weather');
});
