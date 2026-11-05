import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url),{recordContent}=require('../../deck/html.js');
const JSZip=require('../../tools/node_modules/jszip');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('Both delivered decks contain all 14 shared slides, text and native chart data',async()=>{
  const slides=recordContent(),html=await readFile(new URL('../deck.html',import.meta.url),'utf8');
  const zip=await JSZip.loadAsync(await readFile(new URL('../Penumbra_DATANOVA_2026.pptx',import.meta.url)));
  assert.equal(slides.length,14);assert.equal((html.match(/<section class="slide/g)||[]).length,14);
  for(const [i,slide] of slides.entries()) {
    const layoutXML=(await Promise.all(Object.keys(zip.files).filter(n=>/^ppt\/slideLayouts\/slideLayout\d+.xml$/.test(n)).map(n=>zip.file(n).async('string')))).join('');
    const xml=(await zip.file(`ppt/slides/slide${i+1}.xml`).async('string'))+layoutXML;
    for(const object of slide.objects) {
      if(object.type==='text')for(const run of Array.isArray(object.text)?object.text:[{text:object.text}]) {
        for(const line of run.text.split('\n').filter(Boolean))assert.ok(html.includes(esc(line)),`HTML slide ${i+1}: ${line}`);
        for(const line of run.text.split('\n').filter(Boolean))assert.ok(xml.includes(esc(line).replace(/&#39;/g,'&apos;')),`PPTX slide ${i+1}: ${line}`);
      }
    }
  }
  const charts=Object.keys(zip.files).filter(n=>/^ppt\/charts\/chart\d+.xml$/.test(n));
  assert.equal(charts.length,5);assert.equal((html.match(/class="object chart"/g)||[]).length,5);
  const chartXML=(await Promise.all(charts.map(p=>zip.file(p).async('string')))).join('');
  const evidence=JSON.parse(await readFile(new URL('../data/horizons.json',import.meta.url),'utf8'));
  for(const row of evidence.results)for(const value of [row.pinball,row.width*100])assert.ok(chartXML.includes(`<c:v>${value}</c:v>`),`Native horizon value ${value}`);
  assert.ok(html.includes('Print / PDF'));assert.ok(html.includes('Penumbra_DATANOVA_2026.pptx'));
});
test('Deck navigation clamps boundaries, restores links and handles keys and buttons',async()=>{
  const listeners={},elements={};
  const element=()=>({hidden:false,style:{},firstElementChild:{style:{}},addEventListener(k,fn){this[k]=fn;}});
  const slides=Array.from({length:14},element);
  for(const id of ['previous','next','slide-counter','print'])elements[id]=element();
  const main=element();main.clientWidth=390;
  const location={hash:'#slide-9'};
  const context={document:{querySelectorAll:()=>slides,querySelector:()=>main,getElementById:id=>elements[id],addEventListener:(k,f)=>listeners[k]=f},location,history:{replaceState:(_a,_b,h)=>{location.hash=h;}},ResizeObserver:class{observe(){}},window:{addEventListener:(k,f)=>listeners[k]=f,print:()=>{}},console};
  vm.runInNewContext(await readFile(new URL('../deck.js',import.meta.url),'utf8'),context);
  assert.equal(elements['slide-counter'].textContent,'9 / 14');
  const key=k=>listeners.keydown({key:k,preventDefault(){}});
  key('Home');assert.equal(elements.previous.disabled,true);elements.previous.click();assert.equal(elements['slide-counter'].textContent,'1 / 14');
  key('ArrowRight');assert.equal(elements['slide-counter'].textContent,'2 / 14');
  elements.next.click();assert.equal(elements['slide-counter'].textContent,'3 / 14');
  key('End');key('ArrowRight');assert.equal(elements.next.disabled,true);assert.equal(elements['slide-counter'].textContent,'14 / 14');
  assert.equal(slides.filter(s=>!s.hidden).length,1);assert.equal(slides[13].firstElementChild.style.transform,'scale(0.3046875)');
  location.hash='#slide-999';listeners.hashchange();assert.equal(elements['slide-counter'].textContent,'14 / 14');
});
