import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {forecast,adjustOrientation,orientationRatio,solarPosition,quantileAt} from '../forecast.js';
const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} vs ${b}`);
const sun=(time,lat=52.2,lon=.12)=>{const ms=Date.parse(time);return {ms,...solarPosition(ms,lat,lon)};};

test('Default tilt and south orientation leave every horizon and fixture exactly unchanged',async()=>{
  for(const file of await readdir(new URL('fixtures/',import.meta.url))) {
    const f=await read(`fixtures/${file}`),h=f.horizon??1,m=await read(`../model/weather_h${h}.json`);
    const rows=forecast(f.open_meteo,f.lat,f.lon,m,f.shifts,h),before=structuredClone(rows);
    assert.deepEqual(adjustOrientation(rows),before,file);
    assert.deepEqual(adjustOrientation(rows,35,180),before,file);
    assert.ok(rows.every(r=>orientationRatio(r,35,180)===1));
  }
});

test('Isotropic sky and ground terms match an analytic overhead-sun reference',()=>{
  // At high clearness Erbs gives DHI/GHI=.165. Albedo=.2.
  // With sun overhead: POA/GHI = .8175*cos(tilt) + .1825.
  const row={ms:Date.parse('2026-03-20T12:00Z'),elevation:90,azimuth:180,clear_sky:1500};
  const reference=.8175*Math.cos(35*Math.PI/180)+.1825;
  close(orientationRatio(row,0,0),1/reference);
  close(orientationRatio(row,90,180),.1825/reference);
  close(orientationRatio(row,90,0),.1825/reference);
});

test('Compass orientation follows the sun; horizontal panels ignore azimuth',()=>{
  const east=sun('2026-03-20T08:00Z'),west=sun('2026-03-20T16:00Z'),noon=sun('2026-03-20T12:00Z');
  assert.ok(orientationRatio(east,35,90)>orientationRatio(east,35,270));
  assert.ok(orientationRatio(west,35,270)>orientationRatio(west,35,90));
  assert.ok(orientationRatio(noon,35,180)>orientationRatio(noon,35,0));
  close(orientationRatio(noon,0,90),orientationRatio(noon,0,270));
  close(orientationRatio(noon,35,0),orientationRatio(noon,35,360));
  // Clear-sky adjustment is independent of the weather ensemble.
  assert.equal(orientationRatio({...east,ghi_mean:0,direct_frac:0,k_mean:0},35,90),orientationRatio(east,35,90));
});

test('Each quarter-hour scales all calibrated quantiles together without changing raw predictions',()=>{
  const original=['08:00','12:00','16:00'].map(t=>({...sun(`2026-03-20T${t}Z`),p10:.1,p50:.3,p90:.6,raw:{p10:.08,p50:.3,p90:.5}}));
  const before=structuredClone(original),adjusted=adjustOrientation(original,60,90);
  assert.deepEqual(original,before);
  const ratios=original.map(r=>orientationRatio(r,60,90));
  assert.ok(new Set(ratios).size===3);
  adjusted.forEach((r,i)=>{
    for(const q of ['p10','p50','p90'])close(r[q],before[i][q]*ratios[i]);
    close(quantileAt(r.p10,r.p50,r.p90,.3),quantileAt(.1,.3,.6,.3)*ratios[i]);
    assert.ok(r.p10>=0&&r.p10<=r.p50&&r.p50<=r.p90);
    assert.deepEqual(r.raw,before[i].raw);
  });
  assert.deepEqual(adjustOrientation(original,35,180),before);
});

test('Night, twilight and extreme tilts stay finite across seasons and hemispheres',()=>{
  const night={ms:Date.parse('2026-06-21T00:00Z'),elevation:-1,azimuth:0,clear_sky:0,p10:0,p50:0,p90:0};
  assert.equal(orientationRatio(night,90,0),0);
  assert.deepEqual(adjustOrientation([night],90,0),[night]);
  for(const lat of [-80,-35,0,52.2,80])for(const month of ['03','06','12'])for(let hour=0;hour<24;hour++) {
    const row=sun(`2026-${month}-21T${String(hour).padStart(2,'0')}:00Z`,lat);
    for(const tilt of [0,35,90])for(const azimuth of [0,90,180,270]) {
      const ratio=orientationRatio(row,tilt,azimuth);
      assert.ok(Number.isFinite(ratio)&&ratio>=0);
    }
  }
});

test('Geometry rejects nonnumeric and out-of-range inputs, even for empty forecasts',()=>{
  for(const [tilt,azimuth] of [[-1,180],[91,180],[NaN,180],[Infinity,180],['35',180],[35,-1],[35,361],[35,NaN],[35,null]]) {
    assert.throws(()=>adjustOrientation([],tilt,azimuth),RangeError);
    assert.throws(()=>orientationRatio({},tilt,azimuth),RangeError);
  }
});
