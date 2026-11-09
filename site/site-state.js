import {orientationRatio} from './forecast.js';

export const defaultArray=()=>({name:'Main roof',capacity:5,tilt:35,azimuth:180});
export const localDate=(ms,tz)=>{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms));
  const get=k=>parts.find(p=>p.type===k).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};
export const addDay=(date,n)=>new Date(Date.parse(date+'T12:00Z')+n*86400000).toISOString().slice(0,10);
export const modelHorizon=h=>h===0?1:h;
export const meteoAzimuth=azimuth=>azimuth-180;
export const geometryKey=a=>`${a.tilt},${a.azimuth}`;
export const isReference=a=>a.tilt===35&&a.azimuth===180;
export function validateArrays(arrays) {
  if(!Array.isArray(arrays)||arrays.length<1||arrays.length>3)throw new RangeError('Choose one to three arrays.');
  return arrays.map((a,i)=>{
    const {capacity,tilt,azimuth}=a;
    if(![capacity,tilt,azimuth].every(Number.isFinite)||capacity<=0||capacity>1e9||tilt<0||tilt>90||azimuth<0||azimuth>360)throw new RangeError('Invalid array settings.');
    return {name:String(a.name||`Array ${i+1}`).slice(0,80),capacity,tilt,azimuth};
  });
}
function irradiance(response,ms) {
  const hourly=response?.hourly;
  if(!hourly?.time)return NaN;
  // Open-Meteo hourly radiation is the mean of the preceding hour. The four
  // quarter-hours at :00, :15, :30 and :45 therefore use the following label.
  const label=new Date(Math.floor(ms/3600000)*3600000+3600000).toISOString().slice(0,16);
  const i=hourly.time.findIndex(t=>t.replace(/Z$/,'')===label),v=hourly.global_tilted_irradiance?.[i];
  return v==null?NaN:Number(v);
}
export function arrayRatio(row,array,gti) {
  if(isReference(array))return 1;
  const reference=irradiance(gti?.reference,row.ms), tilted=irradiance(gti?.[geometryKey(array)],row.ms);
  if(Number.isFinite(reference)&&reference<20)return 1;
  if(Number.isFinite(reference)&&Number.isFinite(tilted)&&reference>0)return Math.max(0,Math.min(3,tilted/reference));
  return Math.max(0,Math.min(3,orientationRatio(row,array.tilt,array.azimuth)));
}
export function needsGTIFallback(rows,arrays,gti) {
  return arrays.filter(a=>!isReference(a)).some(a=>rows.some(row=>{
    if(!(row.p90>0))return false;
    const reference=irradiance(gti?.reference,row.ms);
    return !Number.isFinite(reference)||(reference>=20&&!Number.isFinite(irradiance(gti?.[geometryKey(a)],row.ms)));
  }));
}
export function combineArrays(rows,arrays,acLimit=null,gti=null) {
  validateArrays(arrays);
  if(acLimit!==null&&(!Number.isFinite(acLimit)||acLimit<=0))throw new RangeError('AC limit must be positive.');
  return rows.map(row=>{
    // Preserve the old multiplication exactly for the default single array.
    const scale=arrays.length===1&&isReference(arrays[0])?arrays[0].capacity:arrays.reduce((s,a)=>s+a.capacity*arrayRatio(row,a,gti),0);
    const clip=v=>acLimit===null?v:Math.min(acLimit,v);
    return {...row,p10:clip(row.p10*scale),p50:clip(row.p50*scale),p90:clip(row.p90*scale)};
  });
}
export function completeDay(rows,date,timezone,now=-Infinity) {
  const map=new Map(rows.map(r=>[r.ms,r])),out=[],start=Date.parse(date+'T00:00Z')-86400000;
  for(let ms=start;ms<start+3*86400000;ms+=900000)if(ms>=now&&localDate(ms,timezone)===date)out.push(map.get(ms)??{ms,time:new Date(ms).toISOString().slice(0,16)+'Z',p10:0,p50:0,p90:0});
  return out;
}
/** A loaded day has no sunlight left, independently of predicted energy. */
export function sunHasSet(day,now=Date.now()) {
  const from=day.horizon===0?(day.remainingFrom??now):-Infinity;
  return !day.rows.some(r=>r.ms>=from&&r.elevation>0);
}
export function bestHours(rows,duration=null) {
  if(duration!==null&&(!Number.isFinite(duration)||duration<.5||duration>6))return null;
  let best=null;
  const sorted=[...rows].sort((a,b)=>a.ms-b.ms);
  const lengths=duration===null?[8,9,10,11,12]:[Math.ceil(duration*4)];
  for(const steps of lengths)for(let i=0;i+steps<=sorted.length;i++) {
    const group=sorted.slice(i,i+steps);
    if(group.some((r,j)=>r.ms!==group[0].ms+j*900000||!Number.isFinite(r.p10)))continue;
    // A fractional final interval uses only the requested fraction of its energy.
    const energy=group.reduce((s,r,j)=>s+r.p10*Math.min(.25,duration===null ? .25 : duration-j*.25),0);
    if((duration!==null||energy>0)&&(!best||energy>best.energy+1e-12))best={start:group[0].ms,end:group[0].ms+(duration??steps/4)*3600000,energy,hours:duration??steps/4};
  }
  return best;
}
export function loadWindow(rows,power,duration) {
  if(!Number.isFinite(power)||power<=0)return null;
  const best=bestHours(rows,duration);if(!best)return null;
  const need=power*duration,expectedEnergy=rows.filter(r=>r.ms>=best.start&&r.ms<best.end).reduce((s,r)=>s+r.p50*Math.min(.25,(best.end-r.ms)/3600000),0);
  return {...best,need,expectedEnergy,lowShare:Math.min(1,best.energy/need),expectedShare:Math.min(1,expectedEnergy/need)};
}
export const absoluteDate=date=>new Intl.DateTimeFormat('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(date+'T12:00Z'));
export function savedForecastLabel(day,fetchedAt,now=Date.now()) {
  const ms=Date.parse(fetchedAt),date=localDate(ms,day.timezone),today=localDate(now,day.timezone);
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:day.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(ms);
  const when=date===today?'':date===addDay(today,-1)?' yesterday':` on ${absoluteDate(date)}`;
  return `Saved forecast for ${absoluteDate(day.date)} · fetched ${time}${when}`;
}
export function convertUnits(site,unit) {
  const factor=site.unit===unit?1:unit==='MW' ? .001 : 1000;
  const convert=v=>Number((v*factor).toPrecision(15));
  return {...site,unit,arrays:site.arrays.map(a=>({...a,capacity:convert(a.capacity)})),acLimit:site.acLimit==null?null:convert(site.acLimit)};
}
export function setupSummary(site,example=false) {
  const number=v=>v.toLocaleString('en-GB',{maximumSignificantDigits:10});
  const compass=['N','NE','E','SE','S','SW','W','NW'];
  const bearings=[...new Set(site.arrays.map(a=>a.azimuth%45===0?compass[Math.round(a.azimuth/45)%8]:`${number(a.azimuth)}°`))];
  return [example?'Example setup':null,`${number(site.arrays.reduce((s,a)=>s+a.capacity,0))} ${site.unit}`,site.arrays.length>1?`${site.arrays.length} arrays`:null,bearings.join(' + '),site.acLimit==null?null:`AC limit ${number(site.acLimit)} ${site.unit}`].filter(Boolean).join(' · ');
}
export const ledgerModelVersion=doc=>doc.model??doc.model_version??(doc.target_date>='2026-11-08'?'v2':'v1');
/** Deduplicate pending requests; successful weather expires 30 minutes after fetch. */
export function expiringCache(ttl=30*60000,now=()=>Date.now()) {
  const entries=new Map();
  return {
    clear(){entries.clear();},
    get(key,load){
      let entry=entries.get(key);
      if(!entry||(entry.fetchedAt!==null&&(now()-entry.fetchedAt>=ttl||now()<entry.fetchedAt))) {
        entry={fetchedAt:null};entries.set(key,entry);
        entry.promise=Promise.resolve().then(load).then(value=>{entry.fetchedAt=now();return {value,fetchedAt:new Date(entry.fetchedAt).toISOString()};}).catch(error=>{if(entries.get(key)===entry)entries.delete(key);throw error;});
      }
      return entry.promise;
    }
  };
}
export function encodeSite(site) {
  const a=validateArrays(site.arrays),p=new URLSearchParams({lat:site.latitude,lon:site.longitude,name:site.name,unit:site.unit,risk:site.risk,horizon:site.horizon,arrays:JSON.stringify(a)});
  // Include the first array for consumers of the previous format.
  for(const k of ['capacity','tilt','azimuth'])p.set(k,a[0][k]);
  if(site.timezone)p.set('tz',site.timezone);
  if(site.acLimit!=null)p.set('ac',site.acLimit);
  return p.toString();
}
export function decodeSite(hash) {
  try {
    const p=new URLSearchParams(hash.replace(/^#/,''));
    const latitude=Number(p.get('lat')),longitude=Number(p.get('lon')),risk=Number(p.get('risk')??90),horizon=Number(p.get('horizon')??1);
    if(!p.has('lat')||!p.has('lon')||!Number.isFinite(latitude)||Math.abs(latitude)>90||!Number.isFinite(longitude)||Math.abs(longitude)>180||!Number.isFinite(risk)||risk<50||risk>90)return null;
    const timezone=p.get('tz')||null;if(timezone)new Intl.DateTimeFormat('en',{timeZone:timezone});
    const legacy=(key,fallback,max)=>p.has(key)&&p.get(key).trim()!==''&&Number.isFinite(Number(p.get(key)))&&Number(p.get(key))>=0&&Number(p.get(key))<=max?Number(p.get(key)):fallback;
    const arrays=validateArrays(p.has('arrays')?JSON.parse(p.get('arrays')):[{name:'Main roof',capacity:Number(p.get('capacity')),tilt:legacy('tilt',35,90),azimuth:legacy('azimuth',180,360)}]);
    const acLimit=p.has('ac')?Number(p.get('ac')):null;
    if(acLimit!==null&&(!Number.isFinite(acLimit)||acLimit<=0))return null;
    return {latitude,longitude,name:(p.get('name')||'Selected coordinates').slice(0,150),timezone,arrays,acLimit,unit:p.get('unit')==='MW'?'MW':'kW',risk,horizon:[0,1,2,3].includes(horizon)?horizon:1};
  }catch{return null;}
}
// A supplier catches browsers where even the localStorage property getter fails.
export function siteStore(storage=()=>globalThis.localStorage) {
  return {
    read(){try{const value=JSON.parse(storage().getItem('penumbra-sites')||'[]');return Array.isArray(value)?value.filter(s=>typeof s.id==='string'&&decodeSite(s.hash)):[];}catch{return [];}},
    write(sites){try{storage().setItem('penumbra-sites',JSON.stringify(sites));return true;}catch{return false;}}
  };
}
export function recentScores(index,scores) {
  const dates=new Set(index.days);
  return scores.days.filter(s=>dates.has(s.date)&&s.mode==='live'&&s.rows>0&&['grid','elia'].every(k=>Number.isFinite(s[k]?.pinball)&&Number.isFinite(s[k]?.cover))).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,7);
}
export function scoreMeans(days) {
  if(!days.length)return null;
  return Object.fromEntries(['grid','elia'].map(model=>[model,Object.fromEntries(['pinball','cover'].map(metric=>[metric,days.reduce((sum,day)=>sum+day[model][metric],0)/days.length]))]));
}
export const powerTick=(value,unit)=>Number.isFinite(value)?`${value.toLocaleString('en-GB',{maximumSignificantDigits:2})} ${unit}`:'—';
