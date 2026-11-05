// Playwright 1.64.1. API: https://playwright.dev/docs/api/class-browsercontext
// Run against a locally served site after exporting the horizon assets.
import {localBrowser} from './browser-local.mjs';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
const single=process.argv.includes('--h1');
const run=await localBrowser(),{base,browser}=run;
try {
  const context=await browser.newContext({locale:'en-GB',timezoneId:'Europe/London',viewport:{width:1600,height:1000},colorScheme:'light',reducedMotion:'reduce'});
  const page=await context.newPage(), requests=[],errors=[];
  page.on('request',r=>requests.push(r.url()));page.on('pageerror',e=>errors.push(e.message));
  const hash=new URLSearchParams({lat:'52.2',lon:'.12',capacity:'5',unit:'kW',risk:'90',name:'Cambridge, United Kingdom',tz:'Europe/London',horizon:'1'});
  await page.goto(`${base}/#${hash}`);
  const ready=async h=>{
    await page.waitForFunction(()=>/Ready|unavailable|No daylight/.test(document.getElementById('forecast-status').textContent),null,{timeout:180000});
    assert.match(await page.locator('#forecast-status').innerText(),/^Ready/);
    assert.match(await page.locator('#result-date').innerText(),new RegExp(`D\\+${h} ·`));
    assert.ok(await page.locator('#forecast-chart canvas').count()>0);
  };
  await ready(1);
  assert.deepEqual(await page.locator('#horizon option').allTextContents(),['Tomorrow','In 2 days','In 3 days']);
  const hs=single?[1]:[1,2,3];
  for(const h of hs) {
    if(h!==1){await page.selectOption('#horizon',String(h));await ready(h);}
    const fetched=new Set(requests.filter(u=>/\/model\/weather_h\d.json/.test(u)).map(u=>Number(u.match(/weather_h(\d)/)[1])));
    assert.deepEqual([...fetched].sort(),hs.filter(x=>x<=h));
    const weather=requests.filter(u=>u.startsWith('https://previous-runs-api.open-meteo.com/')&&new URL(u).searchParams.has('hourly')).at(-1);
    const params=new URL(weather).searchParams;
    assert.ok(params.get('hourly').split(',').every(v=>v.endsWith(`_previous_day${h+1}`)));
    const target=await page.locator('#result-date').innerText();
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const expected=new Date(Date.parse(today+'T12:00Z')+h*86400000).toISOString().slice(0,10);
    assert.ok(target.includes(expected));
    console.log(`PASS browser D+${h}: date, band, previous-run offset and lazy model loading`);
  }
  if(!single) {
    const [download]=await Promise.all([page.waitForEvent('download'),page.click('#json')]);
    await mkdir('.cache',{recursive:true});await download.saveAs('.cache/horizon-export.json');
    const result=JSON.parse(await readFile('.cache/horizon-export.json','utf8'));
    assert.equal(result.horizon,3);assert.ok(result.rows.length>=92&&result.rows.length<=100);
    assert.ok(result.rows.every(r=>r.p10<=r.p50&&r.p50<=r.p90));
    const shared=page.url(),mobile=await context.newPage();await mobile.setViewportSize({width:390,height:844});
    await mobile.goto(shared);
    await mobile.waitForFunction(()=>document.getElementById('forecast-status').textContent.startsWith('Ready'),null,{timeout:180000});
    assert.equal(await mobile.locator('#horizon').inputValue(),'3');
    assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    console.log('PASS browser D+3: JSON export, share restoration and 390 px layout');
    await mobile.close();
  }
  assert.deepEqual(errors,[]);await context.close();
} finally {await run.close();}
