import uPlot from './vendor/uPlot.esm.js';
import {forecast,quantileAt,verifyChain,MODELS,solarPosition} from './forecast.js';
import {defaultArray,localDate,addDay,modelHorizon,meteoAzimuth,geometryKey,isReference,combineArrays,needsGTIFallback,completeDay,sunHasSet,bestHours,encodeSite,decodeSite,siteStore,recentScores,scoreMeans,powerTick} from './site-state.js';
const $=id=>document.getElementById(id);
const WEATHER='https://previous-runs-api.open-meteo.com/v1/forecast';
const GTI='https://api.open-meteo.com/v1/forecast';
const GEOCODE='https://geocoding-api.open-meteo.com/v1/search';
let location={name:'Brussels, Belgium',latitude:50.85,longitude:4.37,timezone:'Europe/Brussels'};
const modelPromises=new Map(),weatherPromises=new Map(),gtiPromises=new Map();
let current,forecastPlot,ledgerPlot,runId=0,searchId=0,selectedSiteId=null,map,pin,hasRequestedForecast=false;
let dayForecasts=new Map();
let exampleSite=true,installPrompt;
const store=siteStore();let savedSites=store.read();
const fmt=(v,d=2)=>Number.isFinite(v)?v.toLocaleString('en-GB',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const percent=v=>Number.isFinite(v)?`${fmt(v*100,1)}%`:'—';
const clock=(ms,tz)=>new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(ms));
const offsetClock=(ms,tz)=>new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).format(new Date(ms));
const dayLabel=h=>['Today','Tomorrow','In 2 days','In 3 days'][h];
async function getJSON(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(14000)});
  if(response.headers.get('X-Penumbra-Offline'))throw Error('Offline weather response.');
  if(!response.ok)throw new Error(`Request failed (${response.status}).`);
  const body=await response.json();if(body.error)throw new Error(body.reason||'Weather data unavailable.');return body;
}
function model(horizon) {
  if(!modelPromises.has(horizon))modelPromises.set(horizon,Promise.all([getJSON(`model/weather_h${horizon}.json`),getJSON('data/shifts.json')]).then(([m,s])=>{
    const shifts=horizon===1?s:s[`h${horizon}`];if(!shifts)throw Error('Calibration unavailable.');return [m,shifts];
  }).catch(e=>{modelPromises.delete(horizon);throw e;}));
  return modelPromises.get(horizon);
}
function readArrays() {
  return [...$('arrays').children].map(el=>({name:el.querySelector('[data-field=name]').value,capacity:Number(el.querySelector('[data-field=capacity]').value),tilt:Number(el.querySelector('[data-field=tilt]').value),azimuth:Number(el.querySelector('[data-field=azimuth]').value)}));
}
function config() {
  return {...location,latitude:Number($('latitude').value),longitude:Number($('longitude').value),arrays:readArrays(),unit:$('unit').value,acLimit:$('ac-limit').value===''?null:Number($('ac-limit').value),risk:Number($('risk').value),horizon:Number($('horizon').value)};
}
const directions=[[0,'North'],[45,'North-east'],[90,'East'],[135,'South-east'],[180,'South'],[225,'South-west'],[270,'West'],[315,'North-west']];
function renderArrays(arrays) {
  $('arrays').replaceChildren();
  arrays.forEach((array,i)=>{
    const el=document.createElement('fieldset');el.className='array';
    const legend=document.createElement('legend');legend.className='sr-only';legend.textContent=`Array ${i+1}`;el.append(legend);
    for(const [key,label,min,max] of [['name','Name'],['capacity','Capacity',.001,1e9],['tilt','Tilt · degrees',0,90],['azimuth','Direction · degrees from north',0,360]]) {
      const id=i===0?({name:'array-name',capacity:'capacity',tilt:'tilt',azimuth:'azimuth'}[key]):`array-${i}-${key}`;
      const field=document.createElement('div');field.className=`array-field field-${key}`;
      const l=document.createElement('label');l.htmlFor=id;l.textContent=key==='tilt'?'Tilt °':key==='azimuth'?'Direction':label;field.append(l);
      const input=document.createElement('input');input.id=id;input.dataset.field=key;input.type=key==='name'?'text':'number';input.value=array[key];input.required=true;
      if(key==='azimuth') {
        const controls=document.createElement('div');controls.className='direction-controls';
        const select=document.createElement('select');select.setAttribute('aria-label',`Array ${i+1} compass direction`);select.dataset.compass='';
        select.id=`${id}-compass`;l.htmlFor=select.id;input.setAttribute('aria-label',`Array ${i+1} direction in degrees from north`);
        for(const [value,text] of [...directions,['custom','Custom…']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}
        select.value=directions.some(([v])=>v===array.azimuth)?String(array.azimuth):'custom';input.hidden=select.value!=='custom';
        controls.append(select,input);field.append(controls);
        select.addEventListener('change',()=>{input.hidden=select.value!=='custom';if(!input.hidden)input.focus();else{input.value=select.value;panelsChanged();}});
      }
      if(key==='name')input.maxLength=80;else{input.min=min;input.max=max;input.step='any';}
      input.addEventListener('change',panelsChanged);
      if(key!=='azimuth')field.append(input);el.append(field);
    }
    const b=document.createElement('button');b.type='button';b.className='text-button remove-array';b.textContent='×';b.setAttribute('aria-label',`Remove array ${i+1}`);b.disabled=arrays.length===1;b.addEventListener('click',()=>{const a=readArrays();a.splice(i,1);renderArrays(a);panelsChanged();});el.append(b);
    $('arrays').append(el);
  });
  $('add-array').disabled=arrays.length>=3;
}
function panelsChanged(){
  syncSaveButton();
  if(!hasRequestedForecast)return;
  if($('forecast-form').checkValidity())runForecast();
  else{runId++;current=null;$('forecast-result').hidden=true;$('run').disabled=false;$('forecast-status').textContent='Check the panel settings, then select Forecast.';}
}
$('add-array').addEventListener('click',()=>{const arrays=readArrays();if(arrays.length>=3)return;arrays.push({...defaultArray(),name:`Array ${arrays.length+1}`});renderArrays(arrays);panelsChanged();});
for(const id of ['unit','ac-limit'])$(id).addEventListener('change',panelsChanged);
function setHash(){history.replaceState(null,'',`#${encodeSite(config())}`);}
function applyConfig(site) {
  exampleSite=false;$('example-label').hidden=true;
  location={name:site.name,latitude:site.latitude,longitude:site.longitude,timezone:site.timezone};
  $('latitude').value=site.latitude;$('longitude').value=site.longitude;$('unit').value=site.unit;$('risk').value=site.risk;$('horizon').value=site.horizon;$('ac-limit').value=site.acLimit??'';
  renderArrays(site.arrays);$('location-name').textContent=site.name;movePin();
}
function restoreHash(){const site=decodeSite(window.location.hash);if(!site)return false;selectedSiteId=savedSites.find(s=>s.hash===encodeSite(site))?.id??null;applyConfig(site);return true;}
function movePin(){if(map&&Number.isFinite(location.latitude)&&Number.isFinite(location.longitude)){pin.setLatLng([location.latitude,location.longitude]);map.panTo(pin.getLatLng());}}
function adoptPlace(place){
  exampleSite=false;$('example-label').hidden=true;$('save-status').textContent='';
  selectedSiteId=null;location=place;$('latitude').value=place.latitude;$('longitude').value=place.longitude;$('location-name').textContent=place.name;$('search-results').replaceChildren();movePin();runForecast();
  if(window.matchMedia('(max-width:650px)').matches)document.querySelector('.output').scrollIntoView({behavior:'smooth',block:'start'});
}
$('search-form').addEventListener('submit',async e=>{
  e.preventDefault();const id=++searchId,box=$('search-results');box.textContent='Searching…';
  try {
    const url=new URL(GEOCODE);url.search=new URLSearchParams({name:$('place').value.trim(),count:5,language:'en',format:'json'});
    const data=await getJSON(url);if(id!==searchId)return;box.replaceChildren();
    if(!data.results?.length){box.textContent='No places found. Try a nearby town.';return;}
    for(const r of data.results){const b=document.createElement('button');b.type='button';const name=[r.name,r.admin1,r.country].filter(Boolean).join(', ');b.textContent=name;b.addEventListener('click',()=>adoptPlace({name,latitude:r.latitude,longitude:r.longitude,timezone:r.timezone}));box.append(b);}
  }catch{if(id===searchId)box.textContent='Search unavailable. Try the map or coordinates.';}
});
const examples={Brussels:[50.85,4.37,'Europe/Brussels'],Cambridge:[52.2,.12,'Europe/London'],Munich:[48.14,11.58,'Europe/Berlin'],Madrid:[40.42,-3.7,'Europe/Madrid']};
for(const b of document.querySelectorAll('[data-place]'))b.addEventListener('click',()=>{const [latitude,longitude,timezone]=examples[b.dataset.place];adoptPlace({name:b.dataset.place,latitude,longitude,timezone});});
$('locate').addEventListener('click',()=>{
  const b=$('locate');if(!navigator.geolocation){$('search-results').textContent='Location unavailable. Enter coordinates.';return;}
  b.disabled=true;b.textContent='Finding your location…';
  navigator.geolocation.getCurrentPosition(p=>{b.disabled=false;b.textContent='Use my location';adoptPlace({name:'Your location',latitude:p.coords.latitude,longitude:p.coords.longitude,timezone:null});},()=>{b.disabled=false;b.textContent='Use my location';$('search-results').textContent='Location unavailable or declined. Search or enter coordinates.';},{timeout:10000,maximumAge:300000});
});
for(const name of ['latitude','longitude'])$(name).addEventListener('input',()=>{
  exampleSite=false;$('example-label').hidden=true;
  location={name:'Selected coordinates',latitude:Number($('latitude').value),longitude:Number($('longitude').value),timezone:null};selectedSiteId=null;
  $('location-name').textContent=location.name;if($('latitude').validity.valid&&$('longitude').validity.valid)movePin();
  runId++;current=null;$('forecast-result').hidden=true;$('retry').hidden=true;$('run').disabled=false;$('forecast-status').textContent='Select Forecast to update.';
  syncSaveButton();
});
$('map-picker').addEventListener('toggle',async()=>{
  if(!$('map-picker').open)return;if(map){map.invalidateSize();return;}
  if($('map-picker').dataset.loading)return;$('map-picker').dataset.loading='true';
  try {
    await Promise.all([
      new Promise((resolve,reject)=>{const css=document.createElement('link');css.rel='stylesheet';css.href='vendor/leaflet/leaflet.css';css.onload=resolve;css.onerror=reject;document.head.append(css);}),
      new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='vendor/leaflet/leaflet.js';script.onload=resolve;script.onerror=reject;document.head.append(script);})
    ]);
    const L=window.L;map=L.map('map').setView([location.latitude,location.longitude],7);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).on('tileerror',()=>{$('map-status').textContent='Map tiles unavailable. Pin and coordinates still work.';}).addTo(map);
    const icon=L.divIcon({className:'map-pin',html:'<img src="vendor/leaflet/images/marker-icon.png" width="25" height="41" alt="">',iconSize:[44,44],iconAnchor:[22,44]});
    pin=L.marker([location.latitude,location.longitude],{icon,draggable:true,alt:'Selected location',title:'Selected location'}).addTo(map);
    const choose=ll=>adoptPlace({name:'Selected coordinates',latitude:Math.max(-90,Math.min(90,ll.lat)),longitude:((ll.lng+180)%360+360)%360-180,timezone:null});
    map.on('click',e=>choose(e.latlng));pin.on('dragend',()=>choose(pin.getLatLng()));
  }catch{$('map-status').textContent='Map unavailable. Search, GPS and coordinates still work.';delete $('map-picker').dataset.loading;}
});
$('forecast-form').addEventListener('submit',e=>{e.preventDefault();runForecast();});
$('retry').addEventListener('click',()=>runForecast());$('horizon').addEventListener('change',()=>runForecast());
async function fetchDay(place,horizon) {
  let tz=place.timezone;
  if(!tz){const meta=new URL(WEATHER);meta.search=new URLSearchParams({latitude:place.latitude,longitude:place.longitude,timezone:'auto'});tz=(await getJSON(meta)).timezone;if(!tz)throw Error('Location timezone unavailable.');}
  const date=addDay(localDate(Date.now(),tz),horizon),h=modelHorizon(horizon),key=`${place.latitude},${place.longitude},${date},${h}`;
  if(!weatherPromises.has(key))weatherPromises.set(key,(async()=>{
    const url=new URL(WEATHER);url.search=new URLSearchParams({latitude:place.latitude,longitude:place.longitude,start_date:addDay(date,-1),end_date:addDay(date,1),hourly:['shortwave_radiation','direct_radiation','cloud_cover','temperature_2m'].map(v=>v+`_previous_day${h+1}`).join(','),models:MODELS.join(','),timezone:'UTC'});
    const [[m,shifts],response]=await Promise.all([model(h),getJSON(url)]);
    const rows=forecast(response,place.latitude,place.longitude,m,shifts,h).filter(r=>localDate(r.ms,tz)===date);
    for(const r of rows)if(!(r.cs_hour>20))Object.assign(r,{p10:0,p50:0,p90:0});
    const lit=rows.filter(r=>r.cs_hour>20);
    if(lit.some(r=>!Number.isFinite(r.k_mean)))throw Error('Weather incomplete for some daylight intervals.');
    // Polar nights legitimately have zero output; missing daytime data does not.
    if(!rows.length&&completeDay([],date,tz).some(r=>solarPosition(r.ms,place.latitude,place.longitude).elevation>0))throw Error('No daylight forecast available for this date.');
    return {horizon,rows,timezone:tz,date,location:{...place,timezone:tz},modelMonth:m.month,calibrationThrough:shifts.through};
  })().catch(e=>{weatherPromises.delete(key);throw e;}));
  return {...structuredClone(await weatherPromises.get(key)),horizon,location:{...place,timezone:tz}};
}
async function fetchGTI(site) {
  const geometries=site.arrays.filter(a=>!isReference(a));if(!geometries.length)return {gti:null,fallback:false};
  const start=localDate(Date.now(),site.timezone),end=addDay(start,4);
  const request=async array=>{
    const key=`${site.latitude},${site.longitude},${start},${geometryKey(array)}`;
    if(!gtiPromises.has(key))gtiPromises.set(key,(async()=>{
      const url=new URL(GTI);url.search=new URLSearchParams({latitude:site.latitude,longitude:site.longitude,start_date:addDay(start,-1),end_date:end,hourly:'global_tilted_irradiance',tilt:array.tilt,azimuth:meteoAzimuth(array.azimuth),timezone:'UTC'});
      const response=await getJSON(url);
      if(!response.hourly?.global_tilted_irradiance?.some(Number.isFinite))throw Error('GTI unavailable.');return response;
    })().catch(e=>{gtiPromises.delete(key);throw e;}));return gtiPromises.get(key);
  };
  try {
    const [reference,...tilted]=await Promise.all([request(defaultArray()),...geometries.map(request)]);
    return {gti:Object.fromEntries([['reference',reference],...geometries.map((a,i)=>[geometryKey(a),tilted[i]])]),fallback:false};
  }catch{return {gti:null,fallback:true};}
}
let snapshotWriting=Promise.resolve();
function saveSnapshot() {
  if(!current||!navigator.onLine)return;
  const snapshot={savedAt:new Date().toISOString(),site:config(),current,days:[...dayForecasts]};
  snapshotWriting=snapshotWriting.catch(()=>{}).then(async()=>{try{const c=await caches.open('penumbra-saved-v3');await c.put(new URL('saved-forecast.json',document.baseURI),new Response(JSON.stringify(snapshot),{headers:{'Content-Type':'application/json'}}));}catch{/* Forecast still works without storage. */}});
}
async function readSnapshot(){try{const response=await (await caches.open('penumbra-saved-v3')).match(new URL('saved-forecast.json',document.baseURI));return response?await response.json():null;}catch{return null;}}
function showSaved(snapshot) {
  hasRequestedForecast=true;
  applyConfig(snapshot.site);current=snapshot.current;dayForecasts=new Map(snapshot.days);$('forecast-result').hidden=false;
  for(const day of [current,...dayForecasts.values()])if(day.horizon===0)day.remainingFrom=Date.parse(snapshot.savedAt);
  $('result-title').textContent=current.location.name;$('result-date').textContent=`${dayLabel(current.horizon)} · ${current.date} · ${current.timezone}`;
  $('forecast-status').textContent='Saved forecast · offline';$('offline-note').hidden=false;$('offline-note').textContent=`Offline · saved at ${new Date(snapshot.savedAt).toLocaleString('en-GB')} · forecast date ${current.date}.`;
  $('model-version').textContent=`Weather only · D+${modelHorizon(current.horizon)} · ${current.modelMonth}`;
  $('region-notice').hidden=location.latitude>=35&&location.latitude<=60&&location.longitude>=-15&&location.longitude<=30;
  updateResult();
}
async function runForecast() {
  if(!$('forecast-form').checkValidity()){$('array-settings').open=true;$('forecast-form').reportValidity();return;}
  hasRequestedForecast=true;
  $('example-label').hidden=!exampleSite;syncSaveButton();
  const id=++runId,site=config();current=null;dayForecasts=new Map();
  $('run').disabled=true;$('retry').hidden=true;$('forecast-result').hidden=true;$('result-title').textContent=site.name;$('location-name').textContent=site.name;
  $('region-notice').hidden=site.latitude>=35&&site.latitude<=60&&site.longitude>=-15&&site.longitude<=30;
  $('forecast-status').textContent='Loading your solar forecast…';$('offline-note').hidden=true;
  try {
    if(!navigator.onLine){const snapshot=await readSnapshot();if(snapshot&&encodeSite(snapshot.site)===encodeSite(site)){if(id===runId)showSaved(snapshot);return;}throw Error('This site or day is not saved for offline use.');}
    const day=await fetchDay(site,site.horizon);if(id!==runId)return;
    location={...day.location};site.timezone=day.timezone;
    const geometry=await fetchGTI(site);if(id!==runId)return;
    current={...day,...geometry};dayForecasts.set(day.horizon,current);
    $('forecast-result').hidden=false;$('result-date').textContent=`${dayLabel(site.horizon)} · ${day.date} · ${day.timezone} · 15-minute intervals`;
    $('model-version').textContent=`Weather only · D+${modelHorizon(site.horizon)} · ${day.modelMonth}`;
    $('forecast-status').textContent=`Ready · calibration through ${day.calibrationThrough}`;
    updateResult();setHash();saveSnapshot();
    // Populate tomorrow's best-hours window first, then the remaining day cards.
    for(const h of [1,0,2,3].filter(h=>h!==site.horizon)) {
      try {const next=await fetchDay(site,h);if(id!==runId)return;dayForecasts.set(h,{...next,...geometry});}
      catch{if(id!==runId)return;dayForecasts.set(h,{error:true});}
      updateDayCards();updateBestHours();saveSnapshot();
    }
  }catch(e){if(id!==runId)return;const snapshot=await readSnapshot();if(id!==runId)return;if(snapshot&&encodeSite(snapshot.site)===encodeSite(config())){showSaved(snapshot);return;}$('forecast-status').textContent=`Forecast unavailable. ${e.name==='TimeoutError'?'Request timed out.':e.message}`;$('retry').hidden=false;}
  finally{if(id===runId)$('run').disabled=false;}
}
function outputRows(day,site=config()) {
  return combineArrays(completeDay(day.rows,day.date,day.timezone,day.horizon===0?(day.remainingFrom??Date.now()):-Infinity),site.arrays,site.acLimit,day.gti).map(r=>({...r,commit:quantileAt(r.p10,r.p50,r.p90,1-site.risk/100)}));
}
function updateDayCards() {
  $('day-totals').replaceChildren();const eu=$('unit').value==='MW'?'MWh':'kWh';
  for(const h of [0,1,2,3]) {
    const b=document.createElement('button');b.type='button';b.className='secondary day-card';b.setAttribute('aria-pressed',String(h===Number($('horizon').value)));
    const title=document.createElement('strong');title.textContent=dayLabel(h);b.append(title);const text=document.createElement('span'),day=dayForecasts.get(h);
    if(day&&!day.error){const rows=outputRows(day),sum=k=>rows.reduce((s,r)=>s+r[k]*.25,0);const sunset=sunHasSet(day);text.textContent=sunset?'Sun has set':`${fmt(sum('p50'))} ${eu}`;b.setAttribute('aria-label',sunset?`${dayLabel(h)} · Sun has set`:`${dayLabel(h)} · P50 ${text.textContent} · P10–P90 ${fmt(sum('p10'))}–${fmt(sum('p90'))} ${eu}`);b.append(text);}
    else{text.textContent=day?.error?'Unavailable':'Loading…';b.append(text);}
    b.addEventListener('click',()=>{if(current&&h===current.horizon)return;$('horizon').value=h;runForecast();});$('day-totals').append(b);
  }
}
function updateBestHours() {
  const day=dayForecasts.get(1),eu=$('unit').value==='MW'?'MWh':'kWh';
  const best=day&&!day.error?bestHours(outputRows(day)):null;
  if(current)current.bestHours=best?{...best,date:day.date,timezone:day.timezone,energyUnit:eu}:null;
  $('csv').disabled=!day;$('json').disabled=!day;
  $('best-hours').textContent=!day?'Finding your most reliable window…':day.error?'Tomorrow’s forecast is unavailable.':best?`Most reliable hours to run the washing machine or charge the car: ${clock(best.start,day.timezone)}–${clock(best.end,day.timezone)}, at least ${fmt(best.energy)} ${eu} (P10).`:'No positive P10 window available tomorrow.';
}
function chart(target,data,series,bands,tz,unit) {
  const css=getComputedStyle(document.documentElement), ink=css.getPropertyValue('--muted').trim(), grid=css.getPropertyValue('--line').trim();
  const powerValue=(_u,v)=>v==null?'—':`${fmt(v)} ${unit}`;
  return new uPlot({width:Math.max(240,target.clientWidth),height:260,legend:{show:false},cursor:{drag:{x:false,y:false}},select:{show:false},scales:{y:{range:(_u,min,max)=>[0,Math.max(.01,max*1.1)]}},series:[{label:'Time',value:(_u,v)=>v==null?'—':offsetClock(v*1000,tz)},...series.map(s=>({...s,points:{show:false},value:powerValue}))],bands,axes:[{stroke:ink,grid:{show:false},size:40,space:65,font:'11px system-ui',values:(_u,ticks)=>ticks.map(t=>clock(t*1000,tz))},{stroke:ink,grid:{stroke:grid,width:1},size:68,font:'10px system-ui',values:(_u,ticks)=>ticks.map(v=>unit==='%'?`${fmt(v,0)}%`:powerTick(v,unit))}]},data,target);
}
function updateResult() {
  if(!current||!$('forecast-form').checkValidity())return;
  const site=config(),capacity=site.arrays.reduce((s,a)=>s+a.capacity,0),unit=site.unit,level=site.risk/100;
  const adjusted=site.arrays.some(a=>!isReference(a));
  const rows=outputRows(current,site),sunset=sunHasSet(current);
  $('sunset-message').hidden=!sunset;
  for(const el of document.querySelectorAll('.daylight-only'))el.hidden=sunset;
  current.geometryFallback=current.fallback||needsGTIFallback(current.rows,site.arrays,current.gti);
  $('geometry-note').textContent=current.geometryFallback?'GTI unavailable · using the clear-sky orientation estimate.':adjusted?'Panel directions adjusted with forecast irradiance.':'35° south · fleet forecast unchanged.';
  if(site.acLimit!==null)$('geometry-note').textContent+=` Site AC limit: ${fmt(site.acLimit)} ${unit}.`;
  const energy=key=>rows.reduce((s,r)=>s+r[key]*.25,0);
  const eu=unit==='MW'?'MWh':'kWh';
  $('total-low').textContent=`${fmt(energy('p10'))} ${eu}`; $('total-mid').textContent=`${fmt(energy('p50'))} ${eu}`; $('total-high').textContent=`${fmt(energy('p90'))} ${eu}`;
  $('risk-value').textContent=`${fmt(level*100,0)}%`;
  const peak=Math.max(0,...rows.map(r=>r.commit));
  $('commitment').textContent=`At ${fmt(level*100,0)}%: ${fmt(energy('commit'))} ${eu} to commit across the day, with a peak commitment of ${fmt(peak)} ${unit}.`;
  $('forecast-summary').textContent=`${current.location.name}, ${current.date}: central energy estimate ${fmt(energy('p50'))} ${eu}; summed P10–P90 estimates ${fmt(energy('p10'))}–${fmt(energy('p90'))} ${eu}. Dashed line: ${fmt(level*100,0)}% commitment. All times in ${current.timezone}. Overnight power is zero.`;
  const css=getComputedStyle(document.documentElement), accent=css.getPropertyValue('--accent').trim(), band=css.getPropertyValue('--band').trim();
  forecastPlot?.destroy(); $('forecast-chart').replaceChildren();
  forecastPlot=null;
  if(!sunset)forecastPlot=chart($('forecast-chart'),[rows.map(r=>r.ms/1000),rows.map(r=>r.p90),rows.map(r=>r.p10),rows.map(r=>r.p50),rows.map(r=>r.commit)],[{label:'P90',stroke:accent,width:0},{label:'P10',stroke:accent,width:0},{label:'P50',stroke:accent,width:2},{label:'Commit',stroke:accent,width:1.5,dash:[5,4]}],[{series:[1,2],fill:band}],current.timezone,unit);
  const hours=new Map();
  for(const r of rows) {
    const key=offsetClock(r.ms,current.timezone).replace(/:\d{2}/,':00');
    if(!hours.has(key))hours.set(key,[]); hours.get(key).push(r);
  }
  const body=$('hourly-table').tBodies[0]; body.replaceChildren();
  for(const [hour,group] of hours) {
    const tr=document.createElement('tr');
    const values=[hour,...['p10','p50','p90','commit'].map(k=>`${fmt(group.reduce((s,r)=>s+r[k],0)/group.length)} ${unit}`)];
    values.forEach((value,i)=>{const td=document.createElement(i===0?'th':'td');if(i===0)td.scope='row';td.textContent=value;tr.append(td);}); body.append(tr);
  }
  current.exportRows=rows; current.capacity=capacity;current.unit=unit;current.level=level;
  current.arrays=site.arrays;current.acLimit=site.acLimit;
  updateDayCards();updateBestHours();
  syncSaveButton();
}
$('risk').addEventListener('input',()=>{updateResult();if(current){setHash();saveSnapshot();}});
function download(text,type,extension) {
  const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=`penumbra-${current.date}.${extension}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('csv').addEventListener('click',()=>{
  if(!current||!$('forecast-form').reportValidity())return;
  updateResult();
  const best=current.bestHours;
  const lines=[`time_utc,time_local,p10_${current.unit},p50_${current.unit},p90_${current.unit},commit_${current.unit},confidence,arrays_json,ac_limit_${current.unit},best_hours_date,best_hours_start_utc,best_hours_end_utc,best_hours_p10_energy_${best?.energyUnit??(current.unit==='MW'?'MWh':'kWh')}`];
  const arraysCSV=`"${JSON.stringify(current.arrays).replaceAll('"','""')}"`;
  for(const r of current.exportRows)lines.push([r.time,`"${current.date} ${offsetClock(r.ms,current.timezone)}"`,r.p10,r.p50,r.p90,r.commit,current.level,arraysCSV,current.acLimit??'',best?.date??'',best?new Date(best.start).toISOString():'',best?new Date(best.end).toISOString():'',best?.energy??''].join(','));
  download(lines.join('\r\n'),'text/csv;charset=utf-8','csv');
});
$('json').addEventListener('click',()=>{
  if(!current||!$('forecast-form').reportValidity())return;
  updateResult();
  download(JSON.stringify({location:current.location,date:current.date,horizon:current.horizon,modelHorizon:modelHorizon(current.horizon),timezone:current.timezone,capacity:current.capacity,powerUnit:current.unit,confidence:current.level,modelMonth:current.modelMonth,calibrationThrough:current.calibrationThrough,arrays:current.arrays,acLimit:current.acLimit,bestHours:current.bestHours,orientationMethod:current.geometryFallback?'clear-sky fallback':current.arrays.every(isReference)?'identity / 35° south':'Open-Meteo GTI / 35° south',note:'Daily sums of interval quantiles are not calibrated daily quantiles. Adjusted bands have no site-specific calibration.',rows:current.exportRows.map(({time,p10,p50,p90,commit})=>({time,p10,p50,p90,commit}))},null,2),'application/json','json');
});
$('share').addEventListener('click',async()=>{
  if(!$('forecast-form').reportValidity())return;
  setHash();try{await navigator.clipboard.writeText(window.location.href);$('share-status').textContent='Share link copied. It includes your location, arrays, AC limit, day and confidence.';}
  catch{$('share-status').textContent='Copy this share link:';const input=document.createElement('input');input.readOnly=true;input.value=window.location.href;input.setAttribute('aria-label','Share link');$('share-status').append(input);input.select();}
});
function previewCard(parent,preview,unit) {
  parent.replaceChildren();
  const text=document.createElement('p');text.className='fine';
  text.textContent=preview?`${preview.date} · Tomorrow P50 ${fmt(preview.p50)} ${unit==='MW'?'MWh':'kWh'} · P10 floor ${fmt(preview.p10)}`:'Loading tomorrow’s forecast…';parent.append(text);
  if(!preview)return;
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 180 40');svg.setAttribute('aria-label','Tomorrow P50 power');svg.setAttribute('role','img');
  const line=document.createElementNS(svg.namespaceURI,'polyline'),max=Math.max(.001,...preview.values);
  line.setAttribute('points',preview.values.map((v,i)=>`${i*180/Math.max(1,preview.values.length-1)},${39-v/max*37}`).join(' '));svg.append(line);parent.append(svg);
}
function syncSaveButton() {
  const saved=savedSites.find(s=>s.id===selectedSiteId);let same=false;
  try{same=Boolean(saved&&saved.hash===encodeSite(config()));}catch{/* Incomplete panel edits are not saved. */}
  $('save-site').textContent=same?'★ Saved':'☆ Save';$('save-site').setAttribute('aria-pressed',String(Boolean(same)));
}
function openSavedSite(saved) {
  selectedSiteId=saved.id;applyConfig(decodeSite(saved.hash));
  savedSites=[...savedSites.filter(s=>s.id!==saved.id),saved];store.write(savedSites);
  $('save-status').textContent='';renderSites();runForecast();
}
function renderSites() {
  $('my-sites').hidden=!savedSites.length;$('site-cards').replaceChildren();
  for(const saved of [...savedSites].reverse()) {
    const site=decodeSite(saved.hash);if(!site)continue;
    const card=document.createElement('article');card.className='site-card';
    const heading=document.createElement('div');heading.className='site-card-heading';
    const open=document.createElement('button');open.type='button';open.className='text-button site-open';open.textContent=saved.name||site.name;
    open.addEventListener('click',()=>openSavedSite(saved));heading.append(open);card.append(heading);
    const preview=document.createElement('div');card.append(preview);previewCard(preview,saved.preview,site.unit);
    const menu=document.createElement('details');menu.className='site-menu';const toggle=document.createElement('summary');toggle.textContent='⋯';toggle.setAttribute('aria-label',`Actions for ${saved.name||site.name}`);menu.append(toggle);heading.append(menu);
    const actions=document.createElement('div');actions.className='site-menu-actions';menu.append(actions);
    const renameButton=document.createElement('button');renameButton.className='text-button';renameButton.type='button';renameButton.textContent='Rename';
    const editor=document.createElement('form');editor.className='site-rename';editor.hidden=true;
    const rename=document.createElement('input');rename.value=saved.name||site.name;rename.maxLength=80;rename.required=true;rename.setAttribute('aria-label','Site name');
    const finish=document.createElement('button');finish.type='submit';finish.className='text-button';finish.textContent='Save';
    const cancel=document.createElement('button');cancel.type='button';cancel.className='text-button';cancel.textContent='Cancel';
    const cancelRename=()=>{editor.hidden=true;open.hidden=false;toggle.focus();};
    cancel.addEventListener('click',cancelRename);editor.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();cancelRename();}});editor.append(rename,finish,cancel);card.append(editor);
    renameButton.addEventListener('click',()=>{menu.open=false;open.hidden=true;rename.value=saved.name||site.name;editor.hidden=false;rename.focus();rename.select();});
    editor.addEventListener('submit',e=>{
      e.preventDefault();const name=rename.value.trim();if(!name)return;
      const hash=encodeSite({...site,name}),next=savedSites.map(s=>s.id===saved.id?{...s,name,hash}:s);
      if(store.write(next)){
        savedSites=next;if(selectedSiteId===saved.id){location.name=name;if(current)current.location.name=name;$('result-title').textContent=name;$('location-name').textContent=name;if(current){updateResult();setHash();saveSnapshot();}else runForecast();}
        renderSites();syncSaveButton();[...$('site-cards').querySelectorAll('[data-site-id]')].find(b=>b.dataset.siteId===saved.id)?.focus();
      }else $('sites-status').textContent='Storage unavailable. Rename was not saved.';
    });
    const remove=document.createElement('button');remove.className='text-button';remove.type='button';remove.textContent='Delete';
    remove.addEventListener('click',()=>{const next=savedSites.filter(s=>s.id!==saved.id);if(store.write(next)){savedSites=next;if(selectedSiteId===saved.id)selectedSiteId=null;renderSites();syncSaveButton();$('save-site').focus();}else $('sites-status').textContent='Storage unavailable. Site was not deleted.';});actions.append(renameButton,remove);open.dataset.siteId=saved.id;$('site-cards').append(card);
    if(navigator.onLine)(async()=>{
      try {
        const day=await fetchDay(site,1),geometry=await fetchGTI({...site,timezone:day.timezone}),rows=outputRows({...day,...geometry},site);
        const data={date:day.date,p50:rows.reduce((s,r)=>s+r.p50*.25,0),p10:rows.reduce((s,r)=>s+r.p10*.25,0),values:rows.map(r=>r.p50)};
        if(!card.isConnected)return;previewCard(preview,data,site.unit);saved.preview=data;store.write(savedSites);
      }catch{if(!saved.preview)preview.textContent='Tomorrow unavailable. Open to retry.';}
    })();
  }
}
$('save-site').addEventListener('click',()=>{
  if(!current||!$('forecast-form').reportValidity())return;
  const name=location.name,id=selectedSiteId||crypto.randomUUID();
  const site={id,name,hash:encodeSite(config())},next=[...savedSites.filter(s=>s.id!==id),site];
  if(store.write(next)){selectedSiteId=id;savedSites=next;exampleSite=false;$('example-label').hidden=true;renderSites();syncSaveButton();$('save-status').textContent='Site saved on this device.';}
  else $('save-status').textContent='Storage unavailable or full. Use a share link to keep this site.';
});
function renderScoreCard(index,scores) {
  const days=recentScores(index,scores),parent=$('score-content');parent.replaceChildren();
  const mean=scoreMeans(days);
  $('score-status').textContent=days.length?`Last ${days.length} live days · Penumbra pinball ${fmt(mean.grid.pinball,4)} vs Elia ${fmt(mean.elia.pinball,4)} · band coverage ${percent(mean.grid.cover)} vs ${percent(mean.elia.cover)}`:'No live scored days yet.';
  if(!days.length)return;
  const strip=document.createElement('div');strip.className='score-strip';strip.setAttribute('role','list');strip.setAttribute('aria-label','Last seven live scored days · pinball comparison, lower is better');
  for(const day of [...days].reverse()){
    const dot=document.createElement('span');dot.className=`score-dot ${day.grid.pinball<=day.elia.pinball?'ahead':'behind'}`;dot.setAttribute('role','listitem');
    dot.title=`${day.date} · Penumbra ${fmt(day.grid.pinball,4)} vs Elia ${fmt(day.elia.pinball,4)} · coverage ${percent(day.grid.cover)} vs ${percent(day.elia.cover)}`;dot.setAttribute('aria-label',dot.title);strip.append(dot);
  }
  parent.append(strip);
}
const scoreMetrics=['pinball','mae','cover','width'];
function cells(tr,values) {for(const v of values){const td=document.createElement('td');td.textContent=v;tr.append(td);}return tr;}
async function loadLedger() {
  $('ledger-status').textContent='Loading ledger and checking original file hashes…';$('ledger-retry').hidden=true;
  try {
    const [index,scores]=await Promise.all([getJSON('ledger/index.json'),getJSON('ledger/scores.json')]);
    renderScoreCard(index,scores);
    const files=await Promise.all(index.days.map(async date=>{
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Invalid ledger date.');
      const res=await fetch(`ledger/${date}.json`,{signal:AbortSignal.timeout(14000)}); if(!res.ok)throw new Error('A ledger file is unavailable.');
      return {date,text:await res.text()};
    }));
    const chain=await verifyChain(files);
    $('chain-status').textContent=chain.ok?`Chain verified: ${chain.count} files`:`Chain broken: ${chain.brokenDate}`;
    const docs=files.map(f=>JSON.parse(f.text));
    const body=$('ledger-table').tBodies[0],archiveBody=$('ledger-archive-table').tBodies[0];body.replaceChildren();archiveBody.replaceChildren();
    $('ledger-archive-table').tHead.replaceChildren(...[...$('ledger-table').tHead.children].map(row=>row.cloneNode(true)));
    $('ledger-archive').hidden=docs.length*2<=8;
    $('ledger-archive').querySelector('summary').textContent=`All ${docs.length} published files`;
    let rowCount=0;
    for(const doc of [...docs].sort((a,b)=>b.target_date.localeCompare(a.target_date)||String(b.issued_at).localeCompare(String(a.issued_at)))) {
      const score=scores.days.find(s=>s.date===doc.target_date);
      for(const [name,key] of [['Elia','elia'],['Penumbra grid','grid']]) {
        const tr=document.createElement('tr'), values=[`${doc.target_date} / ${doc.issued_at}`,doc.mode,name];
        for(const metric of scoreMetrics) values.push(score?.[key]?metric==='pinball'?fmt(score[key][metric],4):percent(score[key][metric]):'Pending');
        (rowCount++<8?body:archiveBody).append(cells(tr,values));
      }
    }
    const totals=$('ledger-totals');totals.replaceChildren();
    for(const mode of ['live','backfill']) {
      const group=scores.days.filter(s=>s.mode===mode), count=docs.filter(d=>d.mode===mode).length;
      const card=document.createElement('div'), h=document.createElement('h3');h.textContent=`${mode==='live'?'Live':'Backfill'} · ${group.length} scored / ${count} published days`;card.append(h);
      if(!group.length){const p=document.createElement('p');p.textContent='No scored days yet. No combined live + backfill total is reported.';card.append(p);}
      else {
        const p=document.createElement('p');p.textContent='Totals weighted by scored daylight quarter-hours.';card.append(p);
        const scroller=document.createElement('div');scroller.className='table-scroll';
        const t=document.createElement('table');const head=document.createElement('thead'), hr=document.createElement('tr');
        for(const name of ['Model','Pinball','MAE','Cover','Width']){const th=document.createElement('th');th.scope='col';th.textContent=name;hr.append(th);}head.append(hr);t.append(head);
        const tb=document.createElement('tbody');
        for(const [name,key] of [['Elia','elia'],['Penumbra','grid']]) {
          const valid=group.filter(g=>g[key]), n=valid.reduce((s,g)=>s+g.rows,0);
          const values=[name,...scoreMetrics.map(metric=>{const mean=valid.reduce((s,g)=>s+g[key][metric]*g.rows,0)/n;return metric==='pinball'?fmt(mean,4):percent(mean);})];tb.append(cells(document.createElement('tr'),values));
        }
        t.append(tb);scroller.append(t);card.append(scroller);
      }
      totals.append(card);
    }
    const latest=[...docs].reverse().find(d=>d.rows.some(r=>r.region==='Belgium'));
    if(latest) {
      const rows=latest.rows.filter(r=>r.region==='Belgium').sort((a,b)=>a.datetime.localeCompare(b.datetime));
      $('ledger-date').textContent=`${latest.target_date} · ${latest.mode} · issued ${latest.issued_at} · Europe/Brussels`;
      const css=getComputedStyle(document.documentElement), accent=css.getPropertyValue('--accent').trim(), band=css.getPropertyValue('--band').trim(), comparison=css.getPropertyValue('--compare').trim();
      ledgerPlot?.destroy();$('ledger-chart').replaceChildren();
      ledgerPlot=chart($('ledger-chart'),[rows.map(r=>Date.parse(r.datetime)/1000),...['grid_p90','grid_p10','grid_p50','tso_p90','tso_p10','tso_p50'].map(k=>rows.map(r=>r[k]*100))],[{label:'Penumbra P90',stroke:accent,width:0},{label:'Penumbra P10',stroke:accent,width:0},{label:'Penumbra P50',stroke:accent,width:2},{label:'Elia P90',stroke:comparison,width:1,dash:[3,4]},{label:'Elia P10',stroke:comparison,width:1,dash:[3,4]},{label:'Elia P50',stroke:comparison,width:1.5,dash:[6,4]}],[{series:[1,2],fill:band},{series:[4,5],fill:'rgba(128,128,128,.06)'}],'Europe/Brussels','%');
      const peak=key=>Math.max(...rows.map(r=>r[key]));
      $('ledger-summary').textContent=`${latest.target_date}, Belgium (${latest.mode}): peak Penumbra median ${percent(peak('grid_p50'))}; peak Elia median ${percent(peak('tso_p50'))} of capacity. Shaded ranges show P10–P90. Full daily scores follow below.`;
    }else $('ledger-summary').textContent='No Belgian forecast has been published yet.';
    $('ledger-status').textContent=`${docs.length} published files · scores updated ${scores.updated_at}${chain.ok?'':'. Caution: the chain check failed; inspect source files before relying on this ledger.'}`;
  } catch {
    if(!$('score-content').children.length)$('score-status').textContent='Scores unavailable. Retry in the ledger below.';
    $('ledger-status').textContent='Ledger unavailable. Could not load or verify its files.'; $('ledger-retry').hidden=false;$('chain-status').textContent='Chain not verified';
  }
}
$('ledger-retry').addEventListener('click',loadLedger);
function evidenceTable(parent,title,data,caption) {
  const block=document.createElement('div');block.className='evidence-block';
  const h=document.createElement('h3');h.textContent=title;block.append(h);
  const scroll=document.createElement('div');scroll.className='table-scroll';
  const table=document.createElement('table'), cap=document.createElement('caption');cap.textContent=caption;table.append(cap);
  const thead=document.createElement('thead'),tr=document.createElement('tr');
  for(const value of data.headers){const th=document.createElement('th');th.scope='col';th.textContent=value;tr.append(th);}thead.append(tr);table.append(thead);
  const body=document.createElement('tbody');for(const row of data.rows)body.append(cells(document.createElement('tr'),row.map(v=>v||'—')));table.append(body);scroll.append(table);block.append(scroll);parent.append(block);
}
async function loadEvidence() {
  const parent=$('evidence-content');$('evidence-retry').hidden=true;
  try {
    const r=await getJSON('data/results.json');parent.replaceChildren();
    evidenceTable(parent,'359 days. Frozen v2 results.',r.test,'2025-11..2026-10 · daylight quarter-hours · share of monitored capacity');
    const note=document.createElement('p');note.className='notice';note.textContent='The tool above uses Penumbra weather only. Penumbra grid additionally uses Elia forecasts and trailing errors; its results do not describe arbitrary-site forecasts.';parent.append(note);
    const ci=document.createElement('div');ci.className='evidence-block';const h=document.createElement('h3');h.textContent='Paired confidence intervals';ci.append(h);
    const desc=document.createElement('p');desc.textContent=r.paired.method+'. Negative differences favour Penumbra.';ci.append(desc);
    for(const key of ['Belgium','Provinces']){const p=document.createElement('p');p.className='ci';p.textContent=`${key}: ${r.paired[key]}`;ci.append(p);}parent.append(ci);
    evidenceTable(parent,'Portability: Belgium → Great Britain',r.portability,'2025-11..2026-10 · no GB data in training or calibration');
    for(const text of [r.portability_note,r.quartz]){const p=document.createElement('p');p.className='notice';p.textContent=text;parent.append(p);}
    const causality=document.createElement('div');causality.className='evidence-block';const ch=document.createElement('h3');ch.textContent='How causality was kept';const cp=document.createElement('p');cp.textContent=r.causality+' The public ledger identifies retrospective backfills explicitly.';causality.append(ch,cp);parent.append(causality);
    evidenceTable(parent,'Operator value: Belgium',r.operator,'11.76 GW monitored · v2 test days');
    const horizons=await getJSON('data/horizons.json');
    evidenceTable(parent,'Accuracy by horizon',horizons,horizons.note);
    const figure=document.createElement('img');figure.src='img/horizons.png';figure.alt='Weather-only pinball loss and band width by horizon. Elia is a D+1 reference only.';figure.style.width='100%';figure.style.height='auto';parent.append(figure);
  }catch{parent.textContent='Published results could not be loaded.';$('evidence-retry').hidden=false;}
}
$('evidence-retry').addEventListener('click',loadEvidence);
new ResizeObserver(()=>{
  for(const [plot,id] of [[forecastPlot,'forecast-chart'],[ledgerPlot,'ledger-chart']])if(plot&&$(id).clientWidth)plot.setSize({width:Math.max(240,$(id).clientWidth),height:260});
}).observe($('main'));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(current)updateResult();loadLedger();});
window.addEventListener('hashchange',()=>{if(restoreHash())runForecast();});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('install-help').hidden=true;$('install-app').setAttribute('aria-expanded','false');});
window.addEventListener('appinstalled',()=>{installPrompt=null;$('install-help').hidden=true;$('install-app').setAttribute('aria-expanded','false');});
$('install-app').addEventListener('click',async()=>{
  if(installPrompt){const prompt=installPrompt;installPrompt=null;try{await prompt.prompt();}catch{$('install-help').hidden=false;}}
  else $('install-help').hidden=!$('install-help').hidden;
  $('install-app').setAttribute('aria-expanded',String(!$('install-help').hidden));
});
const phoneLayout=window.matchMedia('(max-width:650px)'),output=document.querySelector('.output');
function arrangeForecast(){
  if(phoneLayout.matches)$('site-controls').before(output);
  else document.querySelector('.instrument').append(output);
}
phoneLayout.addEventListener('change',arrangeForecast);arrangeForecast();
renderArrays([defaultArray()]);
const hasSharedSite=restoreHash();
loadLedger();loadEvidence();renderSites();
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js',{scope:'./'}).catch(()=>{});
$('map-picker').open=window.matchMedia('(min-width:900px)').matches;
if(hasSharedSite)requestAnimationFrame(()=>runForecast());
else if(savedSites.length)openSavedSite(savedSites.at(-1));
else if(!navigator.onLine)readSnapshot().then(snapshot=>{if(snapshot)showSaved(snapshot);else runForecast();});
else requestAnimationFrame(()=>runForecast());
