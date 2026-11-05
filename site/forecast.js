/** Browser/Node parity with src/features.py and src/export_site.py. No DOM. */
export const MODELS = ['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless', 'meteofrance_seamless'];
const STEP = 900000, HOUR = 3600000, RAD = Math.PI / 180;
const numeric = x => x == null ? NaN : Number(x);
const timestamp = s => Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(s) ? s : `${s}Z`);
export function solarPosition(ms, lat, lon) {
  const t = new Date(ms), doy = Math.floor((ms - Date.UTC(t.getUTCFullYear(), 0, 0)) / 86400000);
  const hour = t.getUTCHours() + t.getUTCMinutes() / 60;
  const g = 2 * Math.PI / 365 * (doy - 1 + (hour - 12) / 24);
  const eq = 229.18 * (.000075 + .001868 * Math.cos(g) - .032077 * Math.sin(g) - .014615 * Math.cos(2*g) - .040849 * Math.sin(2*g));
  const decl = .006918 - .399912*Math.cos(g) + .070257*Math.sin(g) - .006758*Math.cos(2*g) + .000907*Math.sin(2*g) - .002697*Math.cos(3*g) + .00148*Math.sin(3*g);
  const ha = ((hour*60 + eq + 4*lon)/4 - 180)*RAD, phi = lat*RAD;
  const elevation = Math.asin(Math.max(-1, Math.min(1, Math.sin(phi)*Math.sin(decl) + Math.cos(phi)*Math.cos(decl)*Math.cos(ha))))/RAD;
  const azimuth = (Math.atan2(-Math.sin(ha), Math.tan(decl)*Math.cos(phi) - Math.sin(phi)*Math.cos(ha))/RAD + 360)%360;
  const s = Math.max(0, Math.sin(elevation*RAD));
  return {elevation, azimuth, clear_sky: s > .01 ? 1098*s*Math.exp(-.057/s) : 0, doy_sin: Math.sin(2*Math.PI*doy/365.25), doy_cos: Math.cos(2*Math.PI*doy/365.25)};
}
function stats(values) {
  const v = values.filter(x => !Number.isNaN(x));
  if (!v.length) return {mean: NaN, std: NaN, min: NaN, max: NaN};
  const mean = v.reduce((a,b) => a+b, 0)/v.length;
  return {mean, std: Math.sqrt(v.reduce((a,b) => a+(b-mean)**2,0)/v.length), min: Math.min(...v), max: Math.max(...v)};
}
// pandas Series.interpolate(limit=4): fill the first four missing slots forward,
// interpolating toward the next observation, or holding the last at the end.
function interpolate(values) {
  const out = values.slice();
  let previous = -1;
  for (let i=0; i<values.length; i++) {
    if (Number.isNaN(values[i])) continue;
    if (previous >= 0) for (let j=previous+1; j<Math.min(i, previous+5); j++) out[j] = values[previous] + (values[i]-values[previous])*(j-previous)/(i-previous);
    previous = i;
  }
  if (previous >= 0) for (let j=previous+1; j<Math.min(values.length, previous+5); j++) out[j] = values[previous];
  return out;
}
export function weatherFeatures(response, lat, lon, horizon=1) {
  if (![1,2,3].includes(horizon)) throw new RangeError('Horizon must be 1, 2 or 3.');
  const h = response.hourly;
  if (!h?.time?.length) return [];
  const order = h.time.map((s,i) => [timestamp(s),i]).sort((a,b) => a[0]-b[0]);
  if (order.some(([t]) => !Number.isFinite(t))) throw new Error('Invalid weather timestamps.');
  const lookup = new Map(order), rows = [], csHours = new Map();
  for (let t=order[0][0]-HOUR; t<=order.at(-1)[0]; t+=STEP) {
    const row = {time: new Date(t).toISOString().slice(0,16)+'Z', ms: t, ...solarPosition(t,lat,lon)};
    rows.push(row);
    const label = Math.floor(t/HOUR)*HOUR+HOUR;
    const group = csHours.get(label) ?? [];
    group.push(row.clear_sky); csHours.set(label,group);
  }
  for (const [t,v] of csHours) csHours.set(t,v.reduce((a,b)=>a+b,0)/v.length);
  const clouds = [], temps = [], directs = [], ks = [];
  for (const m of MODELS) {
    const read = (key,t) => numeric(h[`${key}_previous_day${horizon+1}_${m}`]?.[lookup.get(t)]);
    clouds.push(interpolate(rows.map(r=>read('cloud_cover',r.ms))));
    temps.push(interpolate(rows.map(r=>read('temperature_2m',r.ms))));
    const km=[], dm=[];
    for (const r of rows) {
      const label=Math.floor(r.ms/HOUR)*HOUR+HOUR, ghi=read('shortwave_radiation',label), direct=read('direct_radiation',label), cs=csHours.get(label);
      const k=cs>20 ? Math.max(0,Math.min(1.5,ghi/cs)) : NaN;
      r.cs_hour=cs;
      r[`k_${m}`]=k; r[`ghi_${m}`]=k*r.clear_sky;
      km.push(k); dm.push(ghi>20 ? direct/ghi : NaN);
    }
    ks.push(km); directs.push(dm);
  }
  rows.forEach((r,i)=>{
    const k=stats(ks.map(v=>v[i])), c=stats(clouds.map(v=>v[i]));
    Object.assign(r,{k_mean:k.mean,k_std:k.std,k_min:k.min,k_max:k.max,ghi_mean:k.mean*r.clear_sky,cloud_mean:c.mean,cloud_std:c.std,temp:stats(temps.map(v=>v[i])).mean,direct_frac:stats(directs.map(v=>v[i])).mean});
  });
  return rows.filter(r=>r.elevation>0);
}
export function predictTree(tree, values) {
  let n=tree.r;
  while (n>=0) {
    let x=numeric(values[tree.f[n]]);
    const missing=tree.m[n];
    if ((missing===2 && Number.isNaN(x)) || (missing===1 && (Number.isNaN(x) || Math.abs(x)<=1e-35))) n=tree.d[n] ? tree.a[n] : tree.b[n];
    else { if (Number.isNaN(x)) x=0; n=x<=tree.t[n] ? tree.a[n] : tree.b[n]; }
  }
  return tree.v[-n-1];
}
export function calibrate(p10,p50,p90,elevation,shifts) {
  const width=p90-p10, bin=(elevation>15 ? 3 : 0)+(width>=.05 ? 1 : 0)+(width>=.15 ? 1 : 0);
  return {p10:Math.min(p50,Math.max(0,p10-shifts.lo[bin])),p50,p90:Math.max(p50,p90+shifts.hi[bin])};
}
export function forecast(response,lat,lon,model,shifts,horizon=model.horizon??1) {
  if (model.horizon && model.horizon!==horizon) throw new RangeError('Model and requested horizon differ.');
  return weatherFeatures(response,lat,lon,horizon).map(r=>{
    const values=model.features.map(n=>r[n]);
    const raw=[10,50,90].map(q=>Math.max(0,model.quantiles[q].trees.reduce((s,t)=>s+predictTree(t,values),0))).sort((a,b)=>a-b);
    return {...r,raw:{p10:raw[0],p50:raw[1],p90:raw[2]},...calibrate(...raw,r.elevation,shifts)};
  });
}
export function quantileAt(p10,p50,p90,q) {
  if (q<.1-1e-12 || q>.9+1e-12 || !Number.isFinite(q)) throw new RangeError('Quantile must be between 0.1 and 0.9.');
  return q<=.5 ? p10+(p50-p10)*(q-.1)/.4 : p50+(p90-p50)*(q-.5)/.4;
}
/** Hash the original UTF-8 bytes, never a re-serialized JSON object. */
export async function verifyChain(files) {
  // Files come in issue order. The first has no predecessor; every later file must point at a file issued before it,
  // so changing, removing or reordering any file breaks a link.
  const seen=new Set(); let previous=null;
  for (let i=0; i<files.length; i++) {
    const {date,text}=files[i];
    try {
      const doc=JSON.parse(text);
      const linked=i===0 ? doc.prev_sha256===null : seen.has(doc.prev_sha256);
      if (doc.target_date!==date || !linked) return {ok:false,count:i,brokenDate:date};
      const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
      previous=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
      seen.add(previous);
    } catch { return {ok:false,count:i,brokenDate:date}; }
  }
  return {ok:true,count:files.length,head:previous};
}
