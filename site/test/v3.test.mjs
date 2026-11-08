import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {forecast,orientationRatio,solarPosition} from '../forecast.js';
import {defaultArray,combineArrays,arrayRatio,needsGTIFallback,encodeSite,decodeSite,bestHours,siteStore,completeDay,sunHasSet,modelHorizon,meteoAzimuth,recentScores,scoreMeans,powerTick} from '../site-state.js';
const read=async p=>JSON.parse(await readFile(new URL(p,import.meta.url),'utf8'));
const ms=Date.parse('2026-11-06T12:00Z'),row={ms,...solarPosition(ms,50.85,4.37),p10:.1,p50:.2,p90:.3};
const gti=value=>({hourly:{time:['2026-11-06T13:00'],global_tilted_irradiance:[value]}});
const east={name:'East',capacity:2,tilt:40,azimuth:90};
test('Single 35° south array gives exactly the previous numbers for all real-weather horizons',async()=>{
  for(const h of [1,2,3]) {
    const f=await read(`fixtures/brussels${h===1?'':`_h${h}`}.json`),m=await read(`../model/weather_h${h}.json`);
    const rows=forecast(f.open_meteo,f.lat,f.lon,m,f.shifts,h);
    const expected=rows.map(r=>({...r,p10:r.p10*5,p50:r.p50*5,p90:r.p90*5}));
    assert.deepEqual(combineArrays(rows,[defaultArray()]),expected);
  }
});
test('GTI ratio clamps, handles low reference, aligns preceding hours and falls back',()=>{
  assert.equal(meteoAzimuth(90),-90);assert.equal(meteoAzimuth(180),0);assert.equal(meteoAzimuth(270),90);
  for(const delta of [0,15,30,45])assert.equal(arrayRatio({...row,ms:ms+delta*60000},east,{reference:gti(100),'40,90':gti(500)}),3);
  assert.equal(arrayRatio(row,east,{reference:gti(100),'40,90':gti(-10)}),0);
  assert.equal(arrayRatio(row,east,{reference:gti(19),'40,90':gti(500)}),1);
  assert.equal(arrayRatio(row,east,{reference:gti(20),'40,90':gti(40)}),2);
  for(const missing of [null,{reference:gti(null),'40,90':gti(200)},{reference:gti(100),'40,90':gti(null)}])assert.equal(arrayRatio(row,east,missing),Math.min(3,orientationRatio(row,40,90)));
});
test('Sum arrays then clip all three quantiles at the site AC limit',()=>{
  const arrays=[defaultArray(),east,{...east,name:'West',capacity:3,azimuth:270}];
  const bundle={reference:gti(100),'40,90':gti(200),'40,270':gti(50)};
  const [sum]=combineArrays([row],arrays,null,bundle);assert.equal(sum.p50,.2*(5+4+1.5));
  const [clip]=combineArrays([row],arrays,1.5,bundle);assert.equal(clip.p10,1.05);assert.equal(clip.p50,1.5);assert.equal(clip.p90,1.5);
  assert.throws(()=>combineArrays([row],[],null),RangeError);assert.throws(()=>combineArrays([row],arrays,0),RangeError);
});
test('Recorded forecast GTI matches the hourly ratio and flags missing daylight values',async()=>{
  const reference=(await read('fixtures/v3/gti.json')).response,tilted=(await read('fixtures/v3/gti-east.json')).response;
  const bundle={reference,'40,90':tilted};
  const i=reference.hourly.time.indexOf('2026-11-06T13:00');
  const ref=reference.hourly.global_tilted_irradiance[i],target=tilted.hourly.global_tilted_irradiance[i];
  assert.equal(arrayRatio(row,east,bundle),ref<20?1:Math.min(3,Math.max(0,target/ref)));
  assert.equal(needsGTIFallback([row],[east],bundle),false);
  const missing=structuredClone(bundle);missing['40,90'].hourly.global_tilted_irradiance[i]=null;
  assert.equal(needsGTIFallback([row],[east],missing),ref>=20);
  assert.equal(needsGTIFallback([row],[east],null),true);
  assert.equal(needsGTIFallback([row],[defaultArray()],null),false);
});
test('Old and new share formats round trip, preserve arbitrary degrees and reject invalid input',()=>{
  const old=decodeSite('#lat=50.85&lon=4.37&capacity=5&risk=90&unit=kW&tilt=35&azimuth=180&horizon=3');
  assert.deepEqual(old.arrays,[defaultArray()]);assert.equal(old.horizon,3);
  const site={...old,name:'Roof & garden',arrays:[defaultArray(),{...east,azimuth:123.5}],acLimit:6,horizon:0,timezone:'Europe/Brussels'};
  assert.deepEqual(decodeSite(encodeSite(site)),site);
  assert.equal(decodeSite('#lat=91&lon=0&capacity=5'),null);
  assert.equal(decodeSite('#lat=1&lon=0&arrays=%5B%5D'),null);
  assert.equal(decodeSite('#lat=1&lon=0&capacity=5&tz=Invalid'),null);
});
test('Best-hours chooses the highest lower-bound energy in a continuous 2–3 hour window',()=>{
  const rows=Array.from({length:96},(_,i)=>({ms:ms+i*900000,p10:i>=12&&i<24?2:0}));
  assert.deepEqual(bestHours(rows),{start:ms+12*900000,end:ms+24*900000,energy:6,hours:3});
  assert.equal(bestHours(rows.map(r=>({...r,p10:0}))),null);
  assert.equal(bestHours(rows.filter((_,i)=>i%2)),null);
  assert.equal(bestHours(rows.slice(12,20)).hours,2);
});
test('Storage read/write tolerate blocked getters, quota failures and corrupt content',()=>{
  const blocked=siteStore(()=>{throw new Error('SecurityError');});assert.deepEqual(blocked.read(),[]);assert.equal(blocked.write([]),false);
  const corrupt=siteStore(()=>({getItem:()=>'{',setItem:()=>{throw Error('QuotaExceeded');}}));assert.deepEqual(corrupt.read(),[]);assert.equal(corrupt.write([]),false);
  let value;const ok=siteStore(()=>({getItem:()=>value,setItem:(_k,v)=>{value=v;}}));
  const site={id:'a',hash:'lat=1&lon=0&capacity=5'};assert.equal(ok.write([site]),true);assert.deepEqual(ok.read(),[site]);
});
test('Today uses D+1 and excludes elapsed intervals; local DST days retain 23/25 hours',()=>{
  assert.equal(modelHorizon(0),1);
  const today=completeDay([row],'2026-11-06','Europe/Brussels',ms+1);assert.ok(today.every(r=>r.ms>ms));
  assert.equal(completeDay([],'2026-03-29','Europe/Brussels').length,92);
  assert.equal(completeDay([],'2026-10-25','Europe/Brussels').length,100);
});
test('Score card uses at most seven live scored published dates, excluding backfills and pending/invalid days',()=>{
  const days=Array.from({length:10},(_,i)=>`2026-11-${String(i+1).padStart(2,'0')}`);
  const score=date=>({date,mode:'live',rows:36,grid:{pinball:.01,cover:.8},elia:{pinball:.02,cover:.9}});
  const scores={days:days.map(score)};scores.days.push(score('2099-01-01'));
  scores.days[9].mode='backfill';scores.days[8].rows=0;scores.days[7].elia.pinball=null;
  assert.deepEqual(recentScores({days},scores).map(s=>s.date),days.slice(0,7).reverse());
  assert.deepEqual(recentScores({days}, {days:scores.days.map(s=>({...s,mode:'backfill'}))}),[]);
});
test('Live summary is the arithmetic daily mean, independent of daylight row count',()=>{
  assert.equal(scoreMeans([]),null);
  const days=[{rows:20,grid:{pinball:.01,cover:.5},elia:{pinball:.02,cover:.6}},{rows:40,grid:{pinball:.03,cover:.9},elia:{pinball:.04,cover:1}}];
  assert.deepEqual(scoreMeans(days),{grid:{pinball:.02,cover:.7},elia:{pinball:.03,cover:.8}});
});
test('Power axis uses two significant digits and units without duplicate small tick labels',()=>{
  assert.deepEqual([.05,.1,.15,.2,.25].map(v=>powerTick(v,'kW')),['0.05 kW','0.1 kW','0.15 kW','0.2 kW','0.25 kW']);
  assert.equal(powerTick(.001234,'MW'),'0.0012 MW');assert.equal(powerTick(12.34,'kW'),'12 kW');assert.equal(powerTick(0,'kW'),'0 kW');
  assert.equal(powerTick(NaN,'kW'),'—');
});

test('Sunset uses remaining solar geometry, including polar night and saved forecast time',async()=>{
  const fixture=await read('fixtures/brussels.json'),model=await read('../model/weather_h1.json');
  const rows=forecast(fixture.open_meteo,50.85,4.37,model,fixture.shifts).filter(r=>r.time.startsWith('2026-11-06'));
  assert.ok(rows.length>0);
  const today={horizon:0,rows};
  assert.equal(sunHasSet(today,Date.parse('2026-11-06T06:00Z')),false,'Before sunrise still has daylight ahead');
  assert.equal(sunHasSet(today,Date.parse('2026-11-06T12:00Z')),false);
  assert.equal(sunHasSet(today,Date.parse('2026-11-06T22:00Z')),true);
  const zeroEnergy=rows.map(r=>({...r,p10:0,p50:0,p90:0}));
  assert.equal(sunHasSet({...today,rows:zeroEnergy},Date.parse('2026-11-06T12:00Z')),false,'Zero forecast is not sunset');
  assert.equal(sunHasSet({...today,horizon:1},Date.parse('2026-11-07T22:00Z')),false,'Future/full days do not filter by current time');
  assert.equal(sunHasSet({...today,remainingFrom:Date.parse('2026-11-06T12:00Z')},Date.parse('2026-11-06T22:00Z')),false,'Offline keeps the saved remaining-hours cutoff');
  const polarRows=forecast(fixture.open_meteo,89,4.37,model,fixture.shifts);
  assert.equal(polarRows.length,0);assert.equal(sunHasSet({horizon:0,rows:polarRows}),true);assert.equal(sunHasSet({horizon:1,rows:polarRows}),true);
});
