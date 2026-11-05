import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {weatherFeatures,forecast,MODELS} from '../forecast.js';
const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
test('Every horizon ships its own model, calibration and three real-weather parity fixtures',async()=>{
  const shifts=await read('../data/shifts.json'), original=await read('../model/weather.json');
  for(const h of [1,2,3]) {
    const model=await read(`../model/weather_h${h}.json`);
    assert.deepEqual(model.features,original.features);
    if(h===1)assert.deepEqual(model,original);
    else assert.equal(model.horizon,h);
    const sh=h===1?shifts:shifts[`h${h}`];
    assert.equal(sh.lo.length,6);assert.equal(sh.hi.length,6);
    for(const place of ['brussels','cambridge','lisbon']) {
      const f=await read(`fixtures/${place}${h===1?'':`_h${h}`}.json`);
      assert.equal(f.horizon??1,h);
      for(const m of MODELS)assert.ok(`shortwave_radiation_previous_day${h+1}_${m}` in f.open_meteo.hourly);
      assert.ok(f.times.length>0);
      assert.ok(f.raw.p50.some(Number.isFinite));
    }
  }
});
test('Features select the chosen previous-run offset and reject invalid horizons',async()=>{
  const fixture=await read('fixtures/brussels.json'), response=structuredClone(fixture.open_meteo);
  for(const h of [1,2,3])for(const m of MODELS)for(const variable of ['shortwave_radiation','direct_radiation','cloud_cover','temperature_2m']) {
    response.hourly[`${variable}_previous_day${h+1}_${m}`]=response.hourly.time.map(()=>h*10);
  }
  for(const h of [1,2,3]) {
    const rows=weatherFeatures(response,fixture.lat,fixture.lon,h);
    assert.ok(rows.some(r=>r.temp===h*10));
    assert.ok(rows.every(r=>Number.isNaN(r.temp)||Math.abs(r.temp-h*10)<1e-10));
  }
  assert.throws(()=>weatherFeatures(response,50,4,4),RangeError);
  assert.throws(()=>forecast(response,50,4,{horizon:2},fixture.shifts,3),RangeError);
});
