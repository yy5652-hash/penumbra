// Playwright 1.64.1; https://playwright.dev/docs/api/class-browsercontext
// node tools/check-v3.mjs [--shots-dir /tmp/penumbra-v3-shots]
// Default screenshots are the requested data/v3-shots/. No live API calls.
import {chromium} from 'playwright';
import {expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {recentScores,scoreMeans} from '../site/site-state.js';
const root=resolve('site'),flag=process.argv.indexOf('--shots-dir');
const shots=resolve(flag<0?'data/v3-shots':process.argv[flag+1]);
const fixtures=resolve(root,'test/fixtures'),read=async p=>JSON.parse(await readFile(p,'utf8'));
const weather=await Promise.all(['brussels.json','brussels_h2.json','brussels_h3.json'].map(f=>read(join(fixtures,f))));
const ledgerIndex=await read(join(root,'ledger/index.json'));
const liveDays=recentScores(ledgerIndex,await read(join(root,'ledger/scores.json'))),liveMean=scoreMeans(liveDays);
const gti=Object.fromEntries(await Promise.all(['gti','gti-east','gti-west','geocode'].map(async n=>[n,(await read(join(fixtures,'v3',`${n}.json`))).response])));
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'};
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(!url.pathname.startsWith('/penumbra/')){res.writeHead(404);res.end();return;}
  const file=resolve(root,'.'+decodeURIComponent(url.pathname.slice('/penumbra'.length)).replace(/\/$/,'/index.html'));
  if(!file.startsWith(root+'/')){res.writeHead(403);res.end();return;}
  try{const bytes=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/penumbra/`,temp=await mkdtemp(join(tmpdir(),'penumbra-v3-'));
let browser;
try {
  await mkdir(shots,{recursive:true});browser=await chromium.launch({headless:true});
  for(const width of [375,1440]) {
    const context=await browser.newContext({viewport:{width,height:1000},locale:'en-GB',timezoneId:'Europe/Brussels',colorScheme:'light',reducedMotion:'reduce',serviceWorkers:'allow'});
    const errors=[],requests=[];
    await context.route('https://**/*',async route=>{
      const url=new URL(route.request().url());requests.push(url);
      if(url.hostname==='previous-runs-api.open-meteo.com') {
        if(!url.searchParams.has('hourly'))return route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:{timezone:'Europe/Brussels'}});
        const h=Number(url.searchParams.get('hourly').match(/previous_day(\d)/)[1])-1;
        return route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:weather[h-1].open_meteo});
      }
      if(url.hostname==='api.open-meteo.com')return route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:gti[Number(url.searchParams.get('azimuth'))<0?'gti-east':Number(url.searchParams.get('azimuth'))>0?'gti-west':'gti']});
      if(url.hostname==='geocoding-api.open-meteo.com')return route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:gti.geocode});
      return route.abort(); // Tile failure is intentional; map and forecast must work.
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    // Fixtures span 5–9 November. Freeze the app clock; no synthetic weather shifts.
    await page.clock.setFixedTime(new Date('2026-11-05T06:10:00Z'));
    const layout=async()=>{
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width}px horizontal overflow`);
      const small=await page.locator('.masthead a,.masthead button,.instrument button,.instrument input,.instrument select,.instrument summary,#my-sites button,#my-sites summary').evaluateAll(elements=>elements.filter(el=>el.getClientRects().length&&!el.closest('.sr-only')).filter(el=>{const r=el.getBoundingClientRect();return r.width<43.9||r.height<43.9;}).map(el=>el.id||el.getAttribute('aria-label')||el.textContent));
      assert.deepEqual(small,[],`${width}px targets must be at least 44 × 44`);
    };
    const forecastOrder=async(viewportWidth)=>{
      const selectors=viewportWidth<=650?['h1','#search-form','#locate','.examples','.output','#map-picker','#forecast-form']:['#search-form','#locate','.examples','#map-picker','#forecast-form'];
      const boxes=await Promise.all(selectors.map(selector=>page.locator(selector).boundingBox()));
      for(let i=1;i<boxes.length;i++)assert.ok(boxes[i].y>=boxes[i-1].y+boxes[i-1].height-1,`${viewportWidth}px order: ${selectors[i-1]} before ${selectors[i]}`);
      const place=await page.locator('#search-form').boundingBox(),output=await page.locator('.output').boundingBox();
      if(viewportWidth>650)assert.ok(output.x>=place.x+place.width,'Desktop forecast stays beside the controls');
      await page.locator('.examples button').last().focus();await page.keyboard.press('Tab');
      await expect(viewportWidth<=650?page.locator('#save-site'):page.locator('#map-picker summary')).toBeFocused();
    };
    const shot=async(name,selector='.forecast-section')=>{await layout();await page.locator(selector).screenshot({path:join(shots,`${width}-${name}.png`),animations:'disabled'});};
    const ready=async()=>{
      await expect(page.locator('#forecast-status')).toHaveText(/^Ready/,{timeout:60000});
      await expect(page.locator('#run')).toBeEnabled({timeout:60000});
      await expect(page.locator('#forecast-result')).toBeVisible();
      await expect(page.locator('#day-totals')).not.toContainText('Loading');
    };
    const change=async(selector,value)=>{await page.locator(selector).fill(value);await page.locator(selector).blur();await ready();};
    const exported=async button=>{
      const [download]=await Promise.all([page.waitForEvent('download'),page.locator(button).click()]);
      const path=join(temp,`${width}-${button.slice(1)}`);await download.saveAs(path);return readFile(path,'utf8');
    };
    await page.goto(base);await ready();await expect(page.locator('#example-label')).toHaveText('Example · Brussels');
    await expect(page.locator('#my-sites')).toBeHidden();await expect(page.locator('#azimuth')).toBeHidden();
    assert.equal(await page.locator('#map-picker').evaluate(el=>el.open),width>=900);
    await expect(page.locator('h1')).toHaveText('Plan your day around reliable solar power.');
    await expect(page.locator('.intro')).toHaveText('Calibrated P10–P90 solar forecasts for any roof, up to three days ahead. Free, no account.');
    assert.deepEqual(await page.locator('.masthead nav a,.masthead nav button').allTextContents(),['Forecast','Track record','Method','Install app']);
    await page.locator('#install-app').click();await expect(page.locator('#install-help')).toContainText('Add to Home Screen');
    await page.locator('#install-app').click();await expect(page.locator('#install-help')).toBeHidden();
    // Exercise the available native PWA prompt without installing on the test machine.
    await page.evaluate(()=>{window.installCalls=0;const event=new Event('beforeinstallprompt',{cancelable:true});event.prompt=async()=>{window.installCalls++;};window.dispatchEvent(event);});
    await page.locator('#install-app').click();assert.equal(await page.evaluate(()=>window.installCalls),1);
    await forecastOrder(width);
    // Check both sides of the phone breakpoint, including DOM/keyboard order after resizing.
    if(width===375){for(const viewportWidth of [650,651,375]){await page.setViewportSize({width:viewportWidth,height:1000});await forecastOrder(viewportWidth);await layout();}}
    await expect(page.locator('#pricing>div').first()).toHaveText('04 / ACCESSFree today.The forecast tool, CSV and JSON exports, and the public ledger.');
    await expect(page.locator('#pricing h3')).toHaveText('Pro · planned:');
    await expect(page.locator('#pricing>div').last().locator('p')).toHaveText("daily email of your sites' forecasts, an API, alerts when tomorrow drops below your P10 commitment.");
    await expect(page.locator('#pricing a')).toHaveText('Tell us what you need →');
    await expect(page.locator('#pricing a')).toHaveAttribute('href','https://github.com/yy5652-hash/penumbra/issues');
    await expect(page.locator('#pricing')).not.toContainText(/not available|no checkout/i);
    await expect(page.locator('#ledger-table tbody tr')).toHaveCount(Math.min(8,ledgerIndex.days.length*2));
    const archive=page.locator('#ledger-archive');
    await expect(archive.locator('summary')).toHaveText(`All ${ledgerIndex.days.length} published files`);
    assert.equal(await archive.evaluate(el=>el.open),false);
    await expect(page.locator('#ledger-archive-table')).toBeHidden();
    await archive.locator('summary').click();await expect(page.locator('#ledger-archive-table')).toBeVisible();
    const ledgerRows=await page.locator('#ledger-table tbody tr,#ledger-archive-table tbody tr').allTextContents();
    assert.equal(ledgerRows.length,ledgerIndex.days.length*2);assert.equal(new Set(ledgerRows).size,ledgerRows.length);
    const dates=ledgerRows.map(row=>row.slice(0,10));assert.deepEqual(dates,[...dates].sort().reverse());
    await archive.locator('summary').click();
    await shot('first-run');
    // Step 1: search a place. Step 2: select it. Forecast needs no panel setup.
    await page.locator('#place').fill('Brussels');await page.locator('#search-form button').click();
    await page.locator('#search-results button').first().click();await ready();
    assert.equal(await page.locator('#capacity').inputValue(),'5');assert.equal(await page.locator('#tilt').inputValue(),'35');assert.equal(await page.locator('#azimuth').inputValue(),'180');
    await expect(page.locator('#example-label')).toBeHidden();await expect(page.locator('#best-hours')).toContainText('at least');
    await expect(page.locator('#score-card table')).toHaveCount(0);await expect(page.locator('.score-dot')).toHaveCount(liveDays.length);
    const decimal=(v,d)=>v.toLocaleString('en-GB',{minimumFractionDigits:d,maximumFractionDigits:d});
    await expect(page.locator('#score-status')).toHaveText(liveMean?`Last ${liveDays.length} live days · Penumbra pinball ${decimal(liveMean.grid.pinball,4)} vs Elia ${decimal(liveMean.elia.pinball,4)} · band coverage ${decimal(liveMean.grid.cover*100,1)}% vs ${decimal(liveMean.elia.cover*100,1)}%`:'No live scored days yet.');
    assert.ok(await page.evaluate(()=>!!(document.querySelector('.instrument').compareDocumentPosition(document.querySelector('#score-card'))&Node.DOCUMENT_POSITION_FOLLOWING)));
    const initial=JSON.parse(await exported('#json'));await shot('forecast');await shot('ledger','#ledger');await shot('evidence','#evidence');
    if(width<900)await page.locator('#map-picker summary').click();await expect(page.locator('#map .leaflet-marker-icon')).toBeVisible();
    await expect(page.locator('#map-status')).toContainText('Map tiles unavailable');assert.equal((await page.locator('#map').boundingBox()).height,220);
    await page.locator('#map').click({position:{x:85,y:90}});await ready();
    assert.notEqual(Number(await page.locator('#latitude').inputValue()),50.85);await shot('map');
    await page.locator('[data-place=Brussels]').click();await ready();
    // Coordinates, example, search and map must keep the pin in sync.
    await expect(page.locator('#map .leaflet-marker-icon')).toHaveCount(1);
    await expect(page.locator('#array-settings')).toHaveAttribute('open');
    for(let n=2;n<=3;n++){await page.locator('#add-array').click();await ready();assert.equal(await page.locator('#arrays>fieldset').count(),n);}
    await expect(page.locator('#add-array')).toBeDisabled();
    const arrayLayout=await page.locator('#arrays>fieldset').first().evaluate(el=>[...el.querySelectorAll('.array-field')].map(field=>field.getBoundingClientRect().top));
    assert.equal(new Set(arrayLayout).size,width>=900?1:2,'Array fields use one desktop row or two phone rows');
    await expect(page.getByRole('button',{name:'Remove array 3',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Remove array 3',exact:true}).click();await ready();await expect(page.locator('#arrays>fieldset')).toHaveCount(2);
    await page.locator('#add-array').click();await ready();
    const triple=JSON.parse(await exported('#json'));
    for(let i=0;i<triple.rows.length;i++)assert.ok(Math.abs(triple.rows[i].p50-initial.rows[i].p50*3)<1e-12);
    await change('#array-1-tilt','40');await page.getByLabel('Array 2 compass direction').selectOption('90');await ready();
    await change('#array-2-tilt','40');await page.getByLabel('Array 3 compass direction').selectOption('custom');
    await expect(page.locator('#array-2-azimuth')).toBeVisible();await change('#array-2-azimuth','253.5');await shot('custom-direction');
    await page.getByLabel('Array 3 compass direction').selectOption('270');await ready();await expect(page.locator('#array-2-azimuth')).toBeHidden();
    assert.ok(requests.some(u=>u.hostname==='api.open-meteo.com'&&u.searchParams.get('azimuth')==='-90'));
    await expect(page.locator('#ac-limit')).toBeHidden();await page.locator('#advanced-settings summary').click();await change('#ac-limit','0.25');
    const clipped=JSON.parse(await exported('#json'));assert.equal(clipped.arrays.length,3);assert.equal(clipped.acLimit,.25);assert.ok(clipped.rows.every(r=>r.p10<=r.p50&&r.p50<=r.p90&&r.p90<=.25));assert.ok(clipped.rows.some(r=>r.p90===.25));assert.ok(clipped.bestHours.energy>0);
    assert.match(await exported('#csv'),/best_hours_start_utc/);await shot('arrays');
    const shared=page.url();
    await page.locator('#day-totals button').nth(0).click();await ready();await expect(page.locator('#result-date')).toContainText('Today');await expect(page.locator('#day-totals button').nth(0)).toHaveAttribute('aria-pressed','true');
    const today=JSON.parse(await exported('#json'));assert.equal(today.modelHorizon,1);assert.ok(today.rows.every(r=>Date.parse(r.time)>=Date.parse('2026-11-05T06:10Z')));await shot('today');
    await page.locator('#day-totals button').nth(3).click();await ready();await expect(page.locator('#result-date')).toContainText('2026-11-08');assert.ok(JSON.parse(await exported('#json')).bestHours);await shot('three-days');
    await page.locator('#save-site').click();await expect(page.locator('#save-status')).toContainText('saved');await expect(page.locator('#save-site')).toHaveText('★ Saved');
    await page.goto(base);await ready();await expect(page.locator('#my-sites')).toBeVisible();await expect(page.locator('#example-label')).toBeHidden();await expect(page.locator('#save-site')).toHaveAttribute('aria-pressed','true');
    assert.equal(await page.locator('#arrays>fieldset').count(),3);assert.equal(await page.locator('#horizon').inputValue(),'3');await expect(page.locator('#site-cards svg')).toBeVisible();await shot('sites','#my-sites');
    await expect(page.locator('#site-cards input')).toBeHidden();await page.locator('.site-menu summary').click();await page.getByRole('button',{name:'Rename',exact:true}).click();
    await page.getByRole('textbox',{name:'Site name',exact:true}).fill('Renamed roof');await shot('rename','#my-sites');
    await page.locator('.site-rename button[type=submit]').click();await expect(page.locator('.site-open')).toHaveText('Renamed roof');await expect(page.locator('#result-title')).toHaveText('Renamed roof');
    // A new place can be saved separately; opening the first card changes MRU order.
    await page.locator('[data-place=Cambridge]').click();await ready();await expect(page.locator('#save-site')).toHaveText('☆ Save');await page.locator('#save-site').click();
    await expect(page.locator('.site-card')).toHaveCount(2);await page.goto(base);await ready();await expect(page.locator('#result-title')).toHaveText('Cambridge');
    await page.getByRole('button',{name:'Renamed roof',exact:true}).click();await ready();await page.goto(base);await ready();await expect(page.locator('#result-title')).toHaveText('Renamed roof');await shot('sites','#my-sites');
    await page.locator('.site-card').filter({has:page.getByRole('button',{name:'Cambridge',exact:true})}).locator('summary').click();
    await page.getByRole('button',{name:'Delete',exact:true}).click();await expect(page.locator('.site-card')).toHaveCount(1);
    // New share restores all arrays and clipping. Old format is exercised below.
    await page.goto(shared);await ready();assert.equal(await page.locator('#arrays>fieldset').count(),3);assert.equal(await page.locator('#ac-limit').inputValue(),'0.25');
    await expect(page.locator('#result-title')).toHaveText('Brussels'); // A share takes precedence over MRU.
    // An evening Today card is a useful state, not a misleading zero-energy chart.
    await page.clock.setFixedTime(new Date('2026-11-05T22:10Z'));
    await page.locator('#run').click();await ready();
    const todayCard=page.locator('#day-totals button').nth(0),tomorrowCard=page.locator('#day-totals button').nth(1);
    await expect(todayCard).toHaveText('TodaySun has set');await expect(todayCard).toHaveAttribute('aria-label','Today · Sun has set');
    await todayCard.click();await ready();await expect(page.locator('#sunset-message')).toContainText('Sun has set');
    await expect(page.locator('#forecast-chart')).toBeHidden();await expect(page.locator('.totals')).toBeHidden();await shot('sunset');
    await tomorrowCard.click();await ready();await expect(page.locator('#forecast-chart')).toBeVisible();await expect(page.locator('#sunset-message')).toBeHidden();
    await page.clock.setFixedTime(new Date('2026-11-05T06:10Z'));await page.locator('#run').click();await ready();
    await expect(todayCard).not.toContainText('Sun has set');
    await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});
    await expect.poll(()=>page.evaluate(async()=>{const response=await (await caches.open('penumbra-saved-v3')).match(new URL('saved-forecast.json',document.baseURI));const snapshot=response&&await response.json();return snapshot?.site.horizon===Number(document.getElementById('horizon').value)&&snapshot.savedAt===new Date().toISOString();})).toBe(true);
    const onlineTotal=await page.locator('#total-mid').innerText();
    // Unroute first: fixture fulfillment must not mask a real offline failure.
    await context.unroute('https://**/*');await context.setOffline(true);
    const offlineResponses=[];page.on('response',r=>{if(r.fromServiceWorker())offlineResponses.push(r.url());});
    await page.reload();await expect(page.locator('#offline-note')).toContainText('saved at');await expect(page.locator('#forecast-status')).toContainText('offline');
    assert.equal(await page.locator('#total-mid').innerText(),onlineTotal);assert.ok(offlineResponses.some(u=>u===base||u.startsWith(`${base}#`)));await shot('offline');
    assert.deepEqual(errors,[]);await context.close();
    console.log(`PASS ${width}px: phone/desktop DOM and keyboard order, 650/651px breakpoint, latest 8 ledger rows/archive, planned Pro copy, sunset/next-day chart, automatic example, live-only score mean/strip, nav/install, responsive map/tile failure, compact/custom arrays, GTI, AC clip, day segments, best hours/exports, saved star, inline rename/delete, MRU reopen, shares, SW offline, layout/touch targets`);
  }
  // Real solar geometry at 89°N: all fixture dates are polar night, despite populated weather.
  const polar=await browser.newContext({viewport:{width:375,height:1000},serviceWorkers:'block'});
  await polar.route('https://**/*',route=>{
    const url=new URL(route.request().url());
    if(url.hostname!=='previous-runs-api.open-meteo.com')return route.abort();
    const h=Number(url.searchParams.get('hourly').match(/previous_day(\d)/)[1])-1;
    return route.fulfill({json:weather[h-1].open_meteo});
  });
  const polarPage=await polar.newPage(),polarErrors=[];polarPage.on('pageerror',error=>polarErrors.push(error.message));
  await polarPage.clock.setFixedTime(new Date('2026-11-05T12:00Z'));
  await polarPage.goto(base+'#lat=89&lon=4.37&capacity=5&unit=kW&risk=90&tz=Europe%2FBrussels&horizon=1');
  await expect(polarPage.locator('#run')).toBeEnabled({timeout:60000});
  await expect(polarPage.locator('#forecast-status')).toHaveText(/^Ready/);
  await expect(polarPage.locator('#day-totals button span')).toHaveText(Array(4).fill('Sun has set'));
  for(const h of [0,1]){
    await polarPage.locator('#day-totals button').nth(h).click();
    await expect(polarPage.locator('#run')).toBeEnabled({timeout:60000});
    await expect(polarPage.locator('#day-totals button').nth(h)).toHaveAttribute('aria-pressed','true');
    await expect(polarPage.locator('#sunset-message')).toBeVisible();await expect(polarPage.locator('#forecast-chart')).toBeHidden();
  }
  await polarPage.locator('.forecast-section').screenshot({path:join(shots,'375-polar-night.png')});
  assert.deepEqual(polarErrors,[]);await polar.close();console.log('PASS polar night: Today and Tomorrow show Sun has set without a forecast error');
  // Isolated storage denial and old links, without carrying a saved snapshot.
  const blocked=await browser.newContext({serviceWorkers:'block'});
  await blocked.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError');}}));
  await blocked.route('https://previous-runs-api.open-meteo.com/**',r=>r.fulfill({json:weather[0].open_meteo}));
  const p=await blocked.newPage();await p.clock.setFixedTime(new Date('2026-11-05T06:10Z'));
  await p.goto(base+'#lat=50.85&lon=4.37&capacity=5&unit=kW&risk=90&tz=Europe%2FBrussels&horizon=1');
  await expect(p.locator('#forecast-status')).toHaveText(/^Ready/,{timeout:60000});await p.locator('#save-site').click();await expect(p.locator('#save-status')).toContainText('Storage unavailable');
  assert.equal(await p.locator('#arrays>fieldset').count(),1);await blocked.close();
  console.log(`PASS old shares + blocked localStorage. Screenshots: ${shots}`);
} finally {
  if(browser)await browser.close();await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});
}
