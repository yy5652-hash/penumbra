// Playwright 1.64.1: https://playwright.dev/docs/api/class-clock#clock-set-fixed-time
// Recorded weather keeps Part 4 checks repeatable, offline and independent of today's date.
// Run locally via tools/resume-round3.py --orientation-only; do not launch in the Codex sandbox.
import {localBrowser} from './browser-local.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {forecast,adjustOrientation} from '../site/forecast.js';
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const fixtures=await Promise.all([1,2,3].map(h=>read(`site/test/fixtures/cambridge${h===1?'':`_h${h}`}.json`)));
const models=await Promise.all([1,2,3].map(h=>read(`site/model/weather_h${h}.json`)));
const close=(a,b)=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<1e-10,`${a} vs ${b}`);
const number=v=>v.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});
const run=await localBrowser(),{base,browser}=run;
try {
  const context=await browser.newContext({locale:'en-GB',timezoneId:'Europe/London',viewport:{width:1600,height:1000},colorScheme:'light',reducedMotion:'reduce'});
  const errors=[],weatherRequests=[];
  context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  await context.route('https://previous-runs-api.open-meteo.com/**',async route=>{
    const url=new URL(route.request().url());
    const offset=Number(url.searchParams.get('hourly')?.match(/previous_day(\d)/)?.[1]);
    assert.ok([2,3,4].includes(offset),'Only the recorded weather requests are expected');
    weatherRequests.push(url.href);
    await route.fulfill({json:fixtures[offset-2].open_meteo,headers:{'access-control-allow-origin':'*'}});
  });
  const open=async(hash,viewport)=>{
    const p=await context.newPage();
    await p.clock.setFixedTime(new Date('2026-11-05T12:00Z'));
    if(viewport)await p.setViewportSize(viewport);
    await p.goto(`${base}/#${hash}`);
    await p.waitForFunction(()=>/Ready|unavailable|No daylight/.test(document.getElementById('forecast-status').textContent),null,{timeout:30000});
    assert.match(await p.locator('#forecast-status').innerText(),/^Ready/);
    return p;
  };
  const hash=new URLSearchParams({lat:'52.2',lon:'.12',capacity:'5',unit:'kW',risk:'90',name:'Cambridge, United Kingdom',tz:'Europe/London',horizon:'1'});
  const page=await open(hash);
  const download=async(p,id)=>{
    const [file]=await Promise.all([p.waitForEvent('download'),p.click(`#${id}`)]);
    const chunks=[];for await(const chunk of await file.createReadStream())chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  };
  const exported=async(p=page)=>JSON.parse(await download(p,'json'));
  const assertRows=(result,h,tilt,azimuth)=>{
    const f=fixtures[h-1],raw=forecast(f.open_meteo,f.lat,f.lon,models[h-1],f.shifts,h);
    for(const row of raw)if(!(row.cs_hour>20))Object.assign(row,{p10:0,p50:0,p90:0});
    const expected=new Map(adjustOrientation(raw,tilt,azimuth).map(r=>[r.time,r]));
    assert.equal(result.rows.length,96);
    assert.equal(result.horizon,h);
    assert.equal(result.geometry.tilt,tilt);assert.equal(result.geometry.azimuth,azimuth);
    assert.equal(result.geometry.adjusted,tilt!==35||azimuth!==180);
    for(const r of result.rows) {
      const e=expected.get(r.time);
      for(const q of ['p10','p50','p90'])close(r[q],(e?.[q]??0)*5);
      close(r.commit,r.p10);
      assert.ok(r.p10>=0&&r.p10<=r.p50&&r.p50<=r.p90);
    }
  };
  const setTilt=async value=>{
    await page.locator('#tilt').fill(value);
    await page.locator('#tilt').dispatchEvent('change');
  };
  assert.equal(await page.locator('#tilt').inputValue(),'35');
  assert.equal(await page.locator('#azimuth').inputValue(),'180');
  assert.match(await page.locator('#geometry-help').innerText(),/geometric adjustment/);
  const defaultRows=(await exported()).rows;
  assertRows(await exported(),1,35,180);
  await page.locator('.plant-geometry summary').click();
  const requestsBefore=weatherRequests.length;
  await setTilt('60');await page.selectOption('#azimuth','90');
  const adjusted=await exported();assertRows(adjusted,1,60,90);
  assert.ok(adjusted.rows.some((r,i)=>Math.abs(r.p50-defaultRows[i].p50)>1e-6));
  assert.match(await page.locator('#geometry-note').innerText(),/Geometric adjustment.*60°.*East/);
  for(const [q,id] of [['p10','low'],['p50','mid'],['p90','high']]) {
    const sum=adjusted.rows.reduce((s,r)=>s+r[q]*.25,0);
    assert.equal(await page.locator(`#total-${id}`).innerText(),`${number(sum)} kWh`);
  }
  assert.ok(await page.locator('#forecast-chart canvas').count()>0);
  const hourly=page.locator('#hourly-table tbody tr');assert.equal(await hourly.count(),24);
  for(let hour=0;hour<24;hour++) {
    const group=adjusted.rows.slice(hour*4,hour*4+4),cells=await hourly.nth(hour).locator('td').allTextContents();
    assert.deepEqual(cells,['p10','p50','p90','commit'].map(q=>`${number(group.reduce((s,r)=>s+r[q],0)/4)} kW`));
  }
  const csv=(await download(page,'csv')).trim().split(/\r?\n/);
  assert.ok(csv[0].endsWith('tilt_degrees,azimuth_degrees,geometric_adjustment'));
  csv.slice(1).forEach((line,i)=>{
    const values=line.split(',');
    for(const [q,j] of [['p10',2],['p50',3],['p90',4],['commit',5]])close(Number(values[j]),adjusted.rows[i][q]);
    assert.deepEqual(values.slice(-3),['60','90','true']);
  });
  const shared=page.url();
  assert.equal(new URL(shared).hash.includes('tilt=60'),true);
  assert.equal(new URL(shared).hash.includes('azimuth=90'),true);
  assert.equal(weatherRequests.length,requestsBefore,'Geometry changes must reuse the fleet forecast');
  console.log('PASS browser geometry: default parity, per-row adjustment, totals, chart, hourly table, CSV and JSON');

  await page.selectOption('#azimuth','180');await setTilt('35');
  assert.deepEqual((await exported()).rows,defaultRows,'Returning to default must undo adjustment exactly');
  for(const value of ['-1','91']) {
    await setTilt(value);
    assert.equal(await page.locator('#tilt').evaluate(e=>e.checkValidity()),false);
    await page.click('#run');
    assert.equal(weatherRequests.length,requestsBefore,'Invalid tilt must block forecasting');
  }
  await setTilt('');assert.equal(await page.locator('#tilt').evaluate(e=>e.checkValidity()),true);
  assert.deepEqual((await exported()).rows,defaultRows,'Blank optional tilt defaults to 35°');
  for(const tilt of ['0','90']){await setTilt(tilt);assertRows(await exported(),1,Number(tilt),180);}
  console.log('PASS browser geometry: defaults restored, optional blank, 0°/90° limits and invalid input');

  await setTilt('60');await page.selectOption('#azimuth','90');
  for(const h of [2,3]) {
    await page.selectOption('#horizon',String(h));
    await page.waitForFunction(h=>document.getElementById('result-date').textContent.startsWith(`D+${h} ·`)&&!document.getElementById('forecast-result').hidden,h);
    assertRows(await exported(),h,60,90);
  }
  const mobile=await open(new URL(page.url()).hash.slice(1),{width:390,height:844});
  assert.equal(await mobile.locator('#tilt').inputValue(),'60');
  assert.equal(await mobile.locator('#azimuth').inputValue(),'90');
  assert.equal(await mobile.locator('#horizon').inputValue(),'3');
  assert.ok(await mobile.locator('.plant-geometry').evaluate(e=>e.open));
  assertRows(await exported(mobile),3,60,90);
  assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const invalid=new URLSearchParams(hash);invalid.set('tilt','100');invalid.set('azimuth','oops');
  const legacy=await open(invalid);assertRows(await exported(legacy),1,35,180);
  console.log('PASS browser geometry: all horizons, shared settings, invalid hash fallback and 390 px layout');
  assert.deepEqual(errors,[]);await context.close();
} finally {await run.close();}
