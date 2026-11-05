// Actual browser captures. Never substitute a mock for an unavailable forecast.
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {localBrowser} from './browser-local.mjs';
const root='docs/gallery';await mkdir(root,{recursive:true});
const run=await localBrowser();
try {
  const context=await run.browser.newContext({locale:'en-GB',timezoneId:'Europe/London',viewport:{width:1600,height:1000},deviceScaleFactor:1,colorScheme:'light',reducedMotion:'reduce'});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const hash=new URLSearchParams({lat:'52.2',lon:'.12',capacity:'5',unit:'kW',risk:'90',name:'Cambridge, United Kingdom',tz:'Europe/London',horizon:'1'});
  await page.goto(`${run.base}/#${hash}`);
  const ready=async()=>{await page.waitForFunction(()=>/Ready|unavailable|No daylight/.test(document.getElementById('forecast-status').textContent),null,{timeout:180000});assert.match(await page.locator('#forecast-status').innerText(),/^Ready/);};
  await ready();
  const manifestPath=`${root}/manifest.json`;
  let manifest={};try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));}catch{}
  const capture=async(name,selector)=>{
    await page.locator(selector).evaluate(e=>window.scrollTo(0,e.getBoundingClientRect().top+window.scrollY-24));
    await page.evaluate(()=>document.fonts.ready);
    const fingerprint=createHash('sha256').update(await page.content()).digest('hex');
    // A reboot can reuse finished images only when their source content is identical.
    if(manifest[name]?.source===fingerprint) {
      const bytes=await readFile(`${root}/${name}`).catch(()=>null);
      if(bytes&&createHash('sha256').update(bytes).digest('hex')===manifest[name].sha256){console.log('RESUME',name);return;}
    }
    const bytes=await page.screenshot({fullPage:false,animations:'disabled'});
    assert.equal(bytes.readUInt32BE(16),1600);assert.equal(bytes.readUInt32BE(20),1000);
    await writeFile(`${root}/${name}.tmp`,bytes);await rename(`${root}/${name}.tmp`,`${root}/${name}`);
    manifest[name]={width:1600,height:1000,locale:'en-GB',source:fingerprint,sha256:createHash('sha256').update(bytes).digest('hex'),capturedAt:new Date().toISOString(),page:page.url().replace(run.base,'<local>')};
    await writeFile(manifestPath+'.tmp',JSON.stringify(manifest,null,2)+'\n');await rename(manifestPath+'.tmp',manifestPath);
    console.log('CAPTURED',name);
  };
  await capture('01-cambridge-forecast.png','#forecast');
  await page.selectOption('#horizon','3');await ready();await capture('02-horizon-choice.png','#forecast');
  await page.waitForFunction(()=>document.getElementById('chain-status').textContent.startsWith('Chain verified'));
  await capture('03-ledger.png','#ledger');
  await page.waitForSelector('#evidence-content table');await capture('04-evidence.png','#evidence');
  await page.goto(run.base+'/deck.html');await capture('05-deck.png','body');
  assert.deepEqual(errors,[]);await context.close();
  console.log('PASS gallery: five 1600x1000 English PNGs');
} finally {await run.close();}
