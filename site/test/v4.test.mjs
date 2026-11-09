import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultArray,bestHours,loadWindow,completeDay,convertUnits,setupSummary,encodeSite,decodeSite,expiringCache,ledgerModelVersion,savedForecastLabel,absoluteDate} from '../site-state.js';
const ms=Date.parse('2026-11-12T00:00Z');
const rows=Array.from({length:96},(_,i)=>({ms:ms+i*900000,p10:i>=44&&i<52?.8:.1,p50:i>=44&&i<52?1.2:.4}));
const site={name:'Roof',latitude:50,longitude:4,timezone:'UTC',arrays:[defaultArray(),{...defaultArray(),azimuth:90}],unit:'kW',acLimit:.25,risk:90,horizon:2};
test('Selected-day windows use remaining Today intervals and disappear after the day',()=>{
  assert.equal(bestHours(completeDay(rows,'2026-11-12','UTC',ms+12*3600000)).start>=ms+12*3600000,true);
  assert.equal(bestHours(completeDay(rows,'2026-11-12','UTC',ms+24*3600000)),null);
  const next=rows.map(r=>({...r,ms:r.ms+86400000}));
  assert.equal(bestHours(next).start-bestHours(rows).start,86400000);
  assert.equal(absoluteDate('2026-11-12'),'Thu 12 Nov');
});
test('Load ranks by low energy, reports capped low/expected shares, with exact duration',()=>{
  const result=loadWindow(rows,2,2);
  assert.equal(result.start,ms+11*3600000);assert.equal(result.hours,2);assert.equal(result.need,4);
  assert.ok(Math.abs(result.energy-1.6)<1e-12);assert.ok(Math.abs(result.expectedEnergy-2.4)<1e-12);
  assert.ok(Math.abs(result.lowShare-.4)<1e-12);assert.ok(Math.abs(result.expectedShare-.6)<1e-12);
  assert.equal(loadWindow(rows,.1,2).lowShare,1);assert.equal(loadWindow(rows,.1,2).expectedShare,1);
  assert.equal(loadWindow(rows.map(r=>({...r,p10:0})),2,2).lowShare,0);
  for(const duration of [.5,6,1.1])assert.ok(Math.abs(loadWindow(rows,2,duration).end-loadWindow(rows,2,duration).start-duration*3600000)<.001);
  for(const duration of [0,.49,6.01,NaN])assert.equal(loadWindow(rows,2,duration),null);
  for(const power of [0,-1,NaN])assert.equal(loadWindow(rows,power,2),null);
  assert.equal(loadWindow(rows.filter((_,i)=>i%2),2,.5),null);
  const highExpected=rows.map((r,i)=>({...r,p50:i<8?100:r.p50}));
  assert.equal(loadWindow(highExpected,2,2).start,result.start,'P50 does not determine the ranking');
});
test('Unit conversion preserves physical capacities, AC clipping and both share formats',()=>{
  const mw=convertUnits(site,'MW');assert.deepEqual(mw.arrays.map(a=>a.capacity),[.005,.005]);assert.equal(mw.acLimit,.00025);
  assert.deepEqual(convertUnits(mw,'kW'),site);assert.deepEqual(decodeSite(encodeSite(mw)),mw);
  const tiny={...site,arrays:[{...defaultArray(),capacity:.001}],acLimit:null};
  assert.deepEqual(decodeSite(encodeSite(convertUnits(tiny,'MW'))),convertUnits(tiny,'MW'));
  assert.equal(decodeSite('#lat=50&lon=4&capacity=0.005&unit=MW').arrays[0].capacity,.005);
});
test('Live setup summary describes defaults, arrays, arbitrary bearings, AC and units',()=>{
  assert.equal(setupSummary({...site,arrays:[defaultArray()],acLimit:null},true),'Example setup · 5 kW · S');
  assert.equal(setupSummary(site),'10 kW · 2 arrays · S + E · AC limit 0.25 kW');
  assert.equal(setupSummary(convertUnits(site,'MW')),'0.01 MW · 2 arrays · S + E · AC limit 0.00025 MW');
  assert.match(setupSummary({...site,arrays:[{...defaultArray(),azimuth:123.5}]}),/123.5°/);
});
test('Weather cache deduplicates, expires at 30 minutes, forces refresh and retries errors',async()=>{
  let now=0,calls=0;const cache=expiringCache(30*60000,()=>now),load=async()=>++calls;
  const first=cache.get('a',load);assert.equal(cache.get('a',load),first);assert.equal((await first).value,1);
  now=30*60000-1;assert.equal((await cache.get('a',load)).value,1);
  now++;assert.equal((await cache.get('a',load)).value,2);
  cache.clear();assert.equal((await cache.get('a',load)).value,3);
  await assert.rejects(cache.get('bad',async()=>{throw Error('offline');}));assert.equal((await cache.get('bad',load)).value,4);
  let reject;const stale=cache.get('pending',()=>new Promise((_,r)=>{reject=r;}));await Promise.resolve();
  cache.clear();const fresh=cache.get('pending',load);reject(Error('old request'));await assert.rejects(stale);
  assert.equal((await fresh).value,5);assert.equal((await cache.get('pending',load)).value,5);
});
test('Ledger versions prefer explicit metadata, otherwise use the documented target-date boundary',()=>{
  assert.equal(ledgerModelVersion({target_date:'2026-11-07'}),'v1');assert.equal(ledgerModelVersion({target_date:'2026-11-08'}),'v2');
  assert.equal(ledgerModelVersion({target_date:'2026-11-09',model:'v3'}),'v3');
});
test('Saved labels distinguish forecast date from fetch date in the site timezone',()=>{
  const day={date:'2026-11-10',timezone:'Europe/Brussels'};
  assert.equal(savedForecastLabel(day,'2026-11-08T17:02Z',Date.parse('2026-11-09T10:00Z')),'Saved forecast for Tue 10 Nov · fetched 18:02 yesterday');
  assert.equal(savedForecastLabel(day,'2026-11-09T12:42Z',Date.parse('2026-11-09T15:00Z')),'Saved forecast for Tue 10 Nov · fetched 13:42');
  assert.equal(savedForecastLabel(day,'2026-11-07T17:02Z',Date.parse('2026-11-09T10:00Z')),'Saved forecast for Tue 10 Nov · fetched 18:02 on Sat 7 Nov');
});
