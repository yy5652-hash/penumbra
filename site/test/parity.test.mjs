import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {forecast,quantileAt,predictTree,calibrate,weatherFeatures,MODELS} from '../forecast.js';
const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
const model=await read('../model/weather.json'), shifts=await read('../data/shifts.json');
const close=(a,b,label)=>{ if(b===null) assert.ok(Number.isNaN(a),label); else assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=1e-4,`${label}: ${a} vs ${b}`); };
for (const file of (await readdir(new URL('fixtures/',import.meta.url))).sort()) {
  test(`Python parity: ${file}`,async()=>{
    const f=await read(`fixtures/${file}`), horizon=f.horizon??1;
    const m=horizon===1?model:await read(`../model/weather_h${horizon}.json`);
    const rows=forecast(f.open_meteo,f.lat,f.lon,m,f.shifts??shifts,horizon);
    assert.deepEqual(rows.map(r=>r.time),f.times);
    rows.forEach((r,i)=>{
      for(const n of m.features) close(r[n],f.features[n][i],`${file} ${i} ${n}`);
      for(const q of ['p10','p50','p90']) close(r.raw[q],f.raw[q][i],`${file} ${i} raw ${q}`);
      close(r.p10,f.p10[i],`${file} ${i} calibrated low`); close(r.p90,f.p90[i],`${file} ${i} calibrated high`);
    });
  });
}
test('Tree missing rules, threshold equality and single-leaf roots',()=>{
  const t={r:0,f:[0],t:[0],a:[-1],b:[-2],d:[0],m:[2],v:[.1,.9]};
  assert.equal(predictTree(t,[NaN]),.9); assert.equal(predictTree({...t,d:[1]},[NaN]),.1);
  assert.equal(predictTree({...t,m:[0]},[NaN]),.1); assert.equal(predictTree(t,[0]),.1);
  assert.equal(predictTree({...t,m:[1]},[0]),.9); assert.equal(predictTree({...t,r:-2},[]),.9);
});
test('Calibration bin boundaries and quantile interpolation',()=>{
  const s={lo:[0,.01,.02,.03,.04,.05],hi:[0,.01,.02,.03,.04,.05]};
  close(calibrate(0,.02,.05,15,s).p90,.06,'bin boundary');
  close(quantileAt(.1,.5,.9,.3),.3,'interpolated quantile');
  close(quantileAt(.1,.5,.9,.7),.7,'upper quantile');
  assert.equal(quantileAt(.1,.5,.9,.1),.1); assert.throws(()=>quantileAt(0,.5,1,0));
});
test('Missing models are ignored; an entirely absent ensemble stays NaN',async()=>{
  const f=await read('fixtures/brussels.json'), h=structuredClone(f.open_meteo);
  for(const m of MODELS) for(const key of Object.keys(h.hourly)) if(key.endsWith(m)) h.hourly[key].fill(null);
  const rows=weatherFeatures(h,f.lat,f.lon); assert.ok(rows.length);
  for(const r of rows) for(const key of ['k_mean','k_std','cloud_mean','temp','direct_frac']) assert.ok(Number.isNaN(r[key]),key);
  assert.deepEqual(weatherFeatures({hourly:{time:[]}},50,4),[]);
});
