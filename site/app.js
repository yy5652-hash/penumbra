import uPlot from './vendor/uPlot.esm.js';
import {forecast,quantileAt,verifyChain,MODELS} from './forecast.js';
const $=id=>document.getElementById(id);
const WEATHER='https://previous-runs-api.open-meteo.com/v1/forecast';
const GEOCODE='https://geocoding-api.open-meteo.com/v1/search';
let location={name:'Brussels, Belgium',latitude:50.85,longitude:4.37,timezone:'Europe/Brussels'};
let modelPromise, current, weatherCache, forecastPlot, ledgerPlot, runId=0, searchId=0;
const fmt=(v,d=2)=>Number.isFinite(v) ? v.toLocaleString('en-GB',{minimumFractionDigits:d,maximumFractionDigits:d}) : '—';
const percent=v=>Number.isFinite(v) ? `${fmt(v*100,1)}%` : '—';
const localDate=(t,tz)=>{
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(t));
  const get=k=>p.find(x=>x.type===k).value; return `${get('year')}-${get('month')}-${get('day')}`;
};
const addDay=(date,n)=>new Date(Date.parse(date+'T12:00Z')+n*86400000).toISOString().slice(0,10);
const clock=(ms,tz)=>new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(ms));
const offsetClock=(ms,tz)=>new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).format(new Date(ms));
async function getJSON(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(14000)});
  if(!response.ok) throw new Error(`Request failed (${response.status}).`);
  const body=await response.json(); if(body.error) throw new Error(body.reason || 'Weather data unavailable.'); return body;
}
function model() {
  if(!modelPromise) {
    $('forecast-status').textContent='Loading the 3 MB model and calibration. Your browser caches the model for later visits…';
    modelPromise=Promise.all([getJSON('model/weather.json'),getJSON('data/shifts.json')]).catch(e=>{modelPromise=null;throw e;});
  }
  return modelPromise;
}
function setHash() {
  const p=new URLSearchParams({lat:location.latitude,lon:location.longitude,capacity:$('capacity').value,unit:$('unit').value,risk:$('risk').value,name:location.name});
  if(location.timezone) p.set('tz',location.timezone);
  history.replaceState(null,'',`#${p}`);
}
function restoreHash() {
  if(!window.location.hash.includes('=')) return false;
  try {
    const p=new URLSearchParams(window.location.hash.slice(1));
    const lat=Number(p.get('lat')),lon=Number(p.get('lon')),cap=Number(p.get('capacity')),risk=Number(p.get('risk'));
    if(!p.has('lat')||!p.has('lon')||!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lon)||Math.abs(lon)>180||!(cap>=.001&&cap<=1e9)||!(risk>=50&&risk<=90)) return false;
    const timezone=p.get('tz'); if(timezone) new Intl.DateTimeFormat('en',{timeZone:timezone});
    location={latitude:lat,longitude:lon,name:(p.get('name')||'Selected coordinates').slice(0,150),timezone};
    $('latitude').value=lat; $('longitude').value=lon; $('capacity').value=cap; $('unit').value=p.get('unit')==='MW'?'MW':'kW'; $('risk').value=risk;
    return true;
  } catch { return false; }
}
function adoptPlace(place) {
  location=place; $('latitude').value=place.latitude; $('longitude').value=place.longitude;
  $('location-name').textContent=place.name; $('search-results').replaceChildren(); runForecast();
}
$('search-form').addEventListener('submit',async e=>{
  e.preventDefault(); const id=++searchId;
  const box=$('search-results'); box.textContent='Searching…';
  try {
    const url=new URL(GEOCODE); url.search=new URLSearchParams({name:$('place').value.trim(),count:5,language:'en',format:'json'});
    const data=await getJSON(url); if(id!==searchId)return; box.replaceChildren();
    if(!data.results?.length) {box.textContent='No places found. Try a nearby town or enter coordinates.'; return;}
    for(const r of data.results) {
      const b=document.createElement('button'); b.type='button';
      const name=[r.name,r.admin1,r.country].filter(Boolean).join(','); b.textContent=name;
      b.addEventListener('click',()=>adoptPlace({name,latitude:r.latitude,longitude:r.longitude,timezone:r.timezone})); box.append(b);
    }
  } catch {if(id===searchId)box.textContent='Place search failed. Press Search to retry, or enter coordinates.';}
});
$('locate').addEventListener('click',()=>{
  const b=$('locate');
  if(!navigator.geolocation) {$('search-results').textContent='Location is unavailable in this browser. Enter coordinates instead.';return;}
  b.disabled=true; b.textContent='Finding your location…';
  navigator.geolocation.getCurrentPosition(p=>{
    b.disabled=false; b.textContent='Use my location';
    adoptPlace({name:'Your location',latitude:p.coords.latitude,longitude:p.coords.longitude,timezone:null});
  },()=>{b.disabled=false;b.textContent='Use my location';$('search-results').textContent='Location access was unavailable or declined. Search for a place or enter coordinates.';},{timeout:10000,maximumAge:300000});
});
for(const name of ['latitude','longitude']) $(name).addEventListener('input',()=>{
  location={name:'Selected coordinates',latitude:Number($('latitude').value),longitude:Number($('longitude').value),timezone:null};
  $('location-name').textContent=location.name;
  runId++; current=null; $('forecast-result').hidden=true; $('retry').hidden=true; $('run').disabled=false;
  $('forecast-status').textContent='Coordinates changed. Select Forecast tomorrow to update.';
});
$('forecast-form').addEventListener('submit',e=>{e.preventDefault();runForecast();});
$('retry').addEventListener('click',()=>runForecast());
async function runForecast() {
  if(!$('forecast-form').reportValidity())return;
  const id=++runId; current=null;
  const place={...location,latitude:Number($('latitude').value),longitude:Number($('longitude').value)};
  $('run').disabled=true; $('retry').hidden=true; $('forecast-result').hidden=true;
  $('result-title').textContent=place.name; $('location-name').textContent=place.name;
  $('region-notice').hidden=place.latitude>=35&&place.latitude<=60&&place.longitude>=-15&&place.longitude<=30;
  $('forecast-status').textContent='Loading weather from four models…';
  try {
    const assets=model();
    // Resolve the actual site's timezone before choosing tomorrow. The feature
    // request below still uses UTC, exactly as the parity fixtures do.
    const weatherJob=(async()=>{
      let tz=place.timezone;
      if(!tz) {
        const meta=new URL(WEATHER); meta.search=new URLSearchParams({latitude:place.latitude,longitude:place.longitude,timezone:'auto'});
        tz=(await getJSON(meta)).timezone;
        if(!tz)throw new Error('Could not resolve the location timezone.');
      }
      const tomorrow=addDay(localDate(Date.now(),tz),1);
      const key=`${place.latitude},${place.longitude},${tomorrow}`;
      if(weatherCache?.key===key)return {...weatherCache,tz,tomorrow};
      const url=new URL(WEATHER); url.search=new URLSearchParams({latitude:place.latitude,longitude:place.longitude,start_date:addDay(tomorrow,-1),end_date:addDay(tomorrow,1),hourly:['shortwave_radiation','direct_radiation','cloud_cover','temperature_2m'].map(v=>v+'_previous_day2').join(','),models:MODELS.join(','),timezone:'UTC'});
      const response=await getJSON(url); return {key,response,tz,tomorrow};
    })();
    const [[m,shifts],w]=await Promise.all([assets,weatherJob]);
    if(id!==runId)return;
    weatherCache=w; location={...place,timezone:w.tz};
    const rows=forecast(w.response,place.latitude,place.longitude,m,shifts).filter(r=>localDate(r.ms,w.tz)===w.tomorrow);
    // At dawn and dusk the clear-sky mean is 20 W/m2 or less: training excluded those rows, so they count as zero output.
    for(const r of rows) if(!(r.cs_hour>20)) Object.assign(r,{p10:0,p50:0,p90:0});
    const lit=rows.filter(r=>r.cs_hour>20);
    const valid=lit.filter(r=>Number.isFinite(r.k_mean));
    if(!valid.length) {$('forecast-status').textContent='No daylight weather data available for tomorrow at this location. Try another location or retry later.'; $('retry').hidden=false;return;}
    // A partially missing daylight ensemble must not silently become zero energy.
    if(valid.length!==lit.length)throw new Error('Weather data is incomplete for some daylight intervals. Please retry later.');
    current={rows,timezone:w.tz,date:w.tomorrow,location:{...location},modelMonth:m.month,calibrationThrough:shifts.through};
    $('forecast-result').hidden=false;
    $('result-date').textContent=`${w.tomorrow} · ${w.tz} · 15-minute intervals`;
    $('model-version').textContent=`Weather only · ${m.month}`;
    $('forecast-status').textContent=`Ready · four weather models · calibration through ${shifts.through}`;
    updateResult(); setHash();
  } catch(e) {
    if(id!==runId)return;
    $('forecast-status').textContent=`Forecast unavailable. ${e.name==='TimeoutError'?'The network request timed out.':e.message} Check your connection and try again.`;
    $('retry').hidden=false;
  } finally {if(id===runId)$('run').disabled=false;}
}
function completeDay() {
  const map=new Map(current.rows.map(r=>[r.ms,r]));
  // Search UTC dates on either side to include 23/25-hour local days.
  const start=Date.parse(current.date+'T00:00Z')-86400000, end=start+3*86400000, rows=[];
  for(let ms=start;ms<end;ms+=900000) if(localDate(ms,current.timezone)===current.date) rows.push(map.get(ms)??{ms,time:new Date(ms).toISOString().slice(0,16)+'Z',p10:0,p50:0,p90:0});
  return rows;
}
function chart(target,data,series,bands,tz,unit) {
  const css=getComputedStyle(document.documentElement), ink=css.getPropertyValue('--muted').trim(), grid=css.getPropertyValue('--line').trim();
  const powerValue=(_u,v)=>v==null?'—':`${fmt(v)} ${unit}`;
  return new uPlot({width:Math.max(240,target.clientWidth),height:260,legend:{show:false},cursor:{drag:{x:false,y:false}},select:{show:false},scales:{y:{range:(_u,min,max)=>[0,Math.max(.01,max*1.1)]}},series:[{label:'Time',value:(_u,v)=>v==null?'—':offsetClock(v*1000,tz)},...series.map(s=>({...s,points:{show:false},value:powerValue}))],bands,axes:[{stroke:ink,grid:{show:false},size:40,space:65,font:'11px system-ui',values:(_u,ticks)=>ticks.map(t=>clock(t*1000,tz))},{stroke:ink,grid:{stroke:grid,width:1},size:48,font:'10px system-ui',values:(_u,ticks)=>ticks.map(v=>unit==='%'?`${fmt(v,0)}%`:fmt(v,1))}]},data,target);
}
function updateResult() {
  if(!current)return;
  const capacity=Number($('capacity').value), unit=$('unit').value, level=Number($('risk').value)/100;
  const rows=completeDay().map(r=>({...r,p10:r.p10*capacity,p50:r.p50*capacity,p90:r.p90*capacity,commit:quantileAt(r.p10,r.p50,r.p90,1-level)*capacity}));
  const energy=key=>rows.reduce((s,r)=>s+r[key]*.25,0);
  const eu=unit==='MW'?'MWh':'kWh';
  $('total-low').textContent=`${fmt(energy('p10'))} ${eu}`; $('total-mid').textContent=`${fmt(energy('p50'))} ${eu}`; $('total-high').textContent=`${fmt(energy('p90'))} ${eu}`;
  $('risk-value').textContent=`${fmt(level*100,0)}%`;
  const peak=Math.max(...rows.map(r=>r.commit));
  $('commitment').textContent=`At ${fmt(level*100,0)}%: ${fmt(energy('commit'))} ${eu} to commit across the day, with a peak commitment of ${fmt(peak)} ${unit}.`;
  $('forecast-summary').textContent=`${current.location.name}, ${current.date}: central energy estimate ${fmt(energy('p50'))} ${eu}; summed P10–P90 estimates ${fmt(energy('p10'))}–${fmt(energy('p90'))} ${eu}. Dashed line: ${fmt(level*100,0)}% commitment. All times in ${current.timezone}. Overnight power is zero.`;
  const css=getComputedStyle(document.documentElement), accent=css.getPropertyValue('--accent').trim(), band=css.getPropertyValue('--band').trim();
  forecastPlot?.destroy(); $('forecast-chart').replaceChildren();
  forecastPlot=chart($('forecast-chart'),[rows.map(r=>r.ms/1000),rows.map(r=>r.p90),rows.map(r=>r.p10),rows.map(r=>r.p50),rows.map(r=>r.commit)],[{label:'P90',stroke:accent,width:0},{label:'P10',stroke:accent,width:0},{label:'P50',stroke:accent,width:2},{label:'Commit',stroke:accent,width:1.5,dash:[5,4]}],[{series:[1,2],fill:band}],current.timezone,unit);
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
}
$('risk').addEventListener('input',()=>{updateResult();if(current)setHash();});
for(const id of ['capacity','unit'])$(id).addEventListener('change',()=>{if(current&&$('forecast-form').checkValidity()){updateResult();setHash();}});
function download(text,type,extension) {
  const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=`penumbra-${current.date}.${extension}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('csv').addEventListener('click',()=>{
  if(!current)return;
  const lines=[`time_utc,time_local,p10_${current.unit},p50_${current.unit},p90_${current.unit},commit_${current.unit},confidence`];
  for(const r of current.exportRows)lines.push([r.time,`"${current.date} ${offsetClock(r.ms,current.timezone)}"`,r.p10,r.p50,r.p90,r.commit,current.level].join(','));
  download(lines.join('\r\n'),'text/csv;charset=utf-8','csv');
});
$('json').addEventListener('click',()=>{if(current)download(JSON.stringify({location:current.location,date:current.date,timezone:current.timezone,capacity:current.capacity,powerUnit:current.unit,confidence:current.level,modelMonth:current.modelMonth,calibrationThrough:current.calibrationThrough,note:'Daily sums of interval quantiles are not calibrated daily quantiles. Tilt and orientation are not modelled.',rows:current.exportRows.map(({time,p10,p50,p90,commit})=>({time,p10,p50,p90,commit}))},null,2),'application/json','json');});
$('share').addEventListener('click',async()=>{
  setHash();try{await navigator.clipboard.writeText(window.location.href);$('share-status').textContent='Share link copied. It includes the location, capacity and confidence setting.';}
  catch{$('share-status').textContent='Copy this share link:';const input=document.createElement('input');input.readOnly=true;input.value=window.location.href;input.setAttribute('aria-label','Share link');$('share-status').append(input);input.select();}
});
const scoreMetrics=['pinball','mae','cover','width'];
function cells(tr,values) {for(const v of values){const td=document.createElement('td');td.textContent=v;tr.append(td);}return tr;}
async function loadLedger() {
  $('ledger-status').textContent='Loading ledger and checking original file hashes…';$('ledger-retry').hidden=true;
  try {
    const [index,scores]=await Promise.all([getJSON('ledger/index.json'),getJSON('ledger/scores.json')]);
    const files=await Promise.all(index.days.map(async date=>{
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Invalid ledger date.');
      const res=await fetch(`ledger/${date}.json`,{signal:AbortSignal.timeout(14000)}); if(!res.ok)throw new Error('A ledger file is unavailable.');
      return {date,text:await res.text()};
    }));
    const chain=await verifyChain(files);
    $('chain-status').textContent=chain.ok?`Chain verified: ${chain.count} files`:`Chain broken: ${chain.brokenDate}`;
    const docs=files.map(f=>JSON.parse(f.text));
    const body=$('ledger-table').tBodies[0];body.replaceChildren();
    for(const doc of [...docs].reverse()) {
      const score=scores.days.find(s=>s.date===doc.target_date);
      for(const [name,key] of [['Elia','elia'],['Penumbra grid','grid']]) {
        const tr=document.createElement('tr'), values=[`${doc.target_date} / ${doc.issued_at}`,doc.mode,name];
        for(const metric of scoreMetrics) values.push(score?.[key]?metric==='pinball'?fmt(score[key][metric],4):percent(score[key][metric]):'Pending');
        body.append(cells(tr,values));
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
  }catch{parent.textContent='Published results could not be loaded.';$('evidence-retry').hidden=false;}
}
$('evidence-retry').addEventListener('click',loadEvidence);
new ResizeObserver(()=>{
  for(const [plot,id] of [[forecastPlot,'forecast-chart'],[ledgerPlot,'ledger-chart']])if(plot&&$(id).clientWidth)plot.setSize({width:Math.max(240,$(id).clientWidth),height:260});
}).observe($('main'));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(current)updateResult();loadLedger();});
window.addEventListener('hashchange',()=>{if(restoreHash())runForecast();});
restoreHash();loadLedger();loadEvidence();
// Defer the large model until the forecast is requested, after the first paint.
requestAnimationFrame(()=>setTimeout(runForecast,0));
