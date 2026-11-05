import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {localBrowser} from './browser-local.mjs';
const run=await localBrowser();
try {
  const context=await run.browser.newContext({locale:'en-GB',viewport:{width:1600,height:1000},deviceScaleFactor:1});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(run.base+'/deck.html');
  assert.equal(await page.locator('.slide').count(),14);
  assert.equal(await page.locator('.slide:visible').count(),1);
  assert.equal(await page.locator('#slide-counter').innerText(),'1 / 14');
  assert.equal(await page.locator('#previous').isDisabled(),true);
  await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#slide-counter').innerText(),'2 / 14');
  await page.click('#next');assert.equal(await page.locator('#slide-counter').innerText(),'3 / 14');
  await page.keyboard.press('End');assert.equal(await page.locator('#next').isDisabled(),true);
  await page.keyboard.press('Home');assert.equal(await page.locator('#slide-counter').innerText(),'1 / 14');
  // Each shared text box and table cell must fit its specified slide bounds.
  for(let i=1;i<=14;i++) {
    await page.goto(run.base+`/deck.html#slide-${i}`);
    const overflow=await page.locator(`#slide-${i}`).evaluate(slide=>[...slide.querySelectorAll('.text,td')].filter(e=>e.scrollHeight>e.clientHeight+2||e.scrollWidth>e.clientWidth+2).map(e=>e.textContent.slice(0,100)));
    assert.deepEqual(overflow,[],`Slide ${i} text overflow`);
  }
  assert.equal(await page.locator('svg.chart').count(),5);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.click('#previous');assert.equal(await page.locator('#slide-counter').innerText(),'13 / 14');
  await page.emulateMedia({media:'print'});assert.equal(await page.locator('.slide:visible').count(),14);
  await mkdir('.cache/deck',{recursive:true});
  await page.pdf({path:'.cache/deck/print.pdf',preferCSSPageSize:true,printBackground:true});
  assert.deepEqual(errors,[]);
  console.log('PASS deck: 14 slides, keyboard/buttons, text bounds, SVG charts, 390 px, print PDF');
  await context.close();
} finally {await run.close();}
