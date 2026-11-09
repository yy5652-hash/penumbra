import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {quantileAt} from '../forecast.js';
import {defaultArray,addDay,modelHorizon,completeDay,combineArrays,bestHours,loadWindow,absoluteDate,encodeSite} from '../site-state.js';
const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
// Run the actual controller functions without a browser; Playwright covers DOM/layout.
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const controller=section('async function runForecast(','function outputRows(')+section('function outputRows(','function updateDayCards(')+section('function updateBestHours()',"for(const id of ['load-power'");
const fixed=Date.parse('2026-11-10T12:10Z'),tick=()=>new Promise(resolve=>setImmediate(resolve));
function day(horizon){
  const date=addDay('2026-11-10',horizon),start=Date.parse(date+'T00:00Z');
  return {horizon,date,timezone:'UTC',location:{name:'Roof'},modelMonth:'2026-11',calibrationThrough:'2026-11-08',fetchedAt:'2026-11-10T12:00Z',rows:Array.from({length:96},(_,i)=>({ms:start+i*900000,time:new Date(start+i*900000).toISOString(),p10:i>=44&&i<56?.16:0,p50:i>=44&&i<56?.24:0,p90:i>=44&&i<56?.4:0}))};
}
function app(fetchDay,horizon=2){
  const elements=new Map(),el=id=>{
    if(!elements.has(id))elements.set(id,{value:'',hidden:false,disabled:false,textContent:'',checkValidity:()=>true,reportValidity:()=>true});
    return elements.get(id);
  };
  el('unit').value='kW';el('load-duration').value='2';
  const site={name:'Roof',latitude:50,longitude:4,timezone:'UTC',arrays:[defaultArray()],unit:'kW',risk:90,acLimit:null,horizon};
  const state=vm.createContext({$:el,site,current:null,dayForecasts:new Map(),runId:0,exampleSite:false,hasRequestedForecast:false,location:{},navigator:{onLine:true},
    Date:class extends Date{static now(){return fixed;}},Intl,Map,Promise,Number,Math,
    config:()=>structuredClone(site),syncSaveButton(){},updateSetupSummary(){},fetchDay,fetchGTI:async()=>({gti:null,fallback:false}),
    readSnapshot:async()=>null,showSaved(){throw Error('Unexpected fallback');},setHash(){},saveSnapshot(){},updateDayCards(){},
    weatherCache:{clears:0,clear(){this.clears++;}},gtiCache:{clears:0,clear(){this.clears++;}},
    modelHorizon,completeDay,combineArrays,bestHours,loadWindow,absoluteDate,quantileAt,encodeSite,
    dayLabel:h=>['Today','Tomorrow','In 2 days','In 3 days'][h],
    clock:ms=>new Date(ms).toISOString().slice(11,16),fmt:(n,d=2)=>n.toFixed(d),fmtPower:(n,unit)=>n.toFixed(unit==='MW'?5:2)
  });
  vm.runInContext(controller,state);
  state.updateResult=()=>{state.current.unit=site.unit;state.current.exportRows=state.outputRows(state.current);state.updateBestHours();};
  return {state,el,site};
}
test('Selected day renders and enables controls before slow/failed background days finish',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const {state,el}=app(async(_site,h)=>h===0?pending:h===1?Promise.reject(Error('Background failed')):day(h));
  const running=state.runForecast();await tick();
  assert.equal(el('run').disabled,false);assert.equal(el('refresh').disabled,false);assert.equal(el('forecast-result').hidden,false);
  assert.equal(el('forecast-status').textContent,'Weather fetched 12:00 · model calibrated through 8 Nov');
  assert.equal(state.current.bestHours.date,'2026-11-12');assert.equal(el('best-heading').textContent,'Best solar window · Thu 12 Nov');
  assert.equal(el('json').disabled,false);assert.equal(el('csv').disabled,false);assert.equal(state.dayForecasts.get(1).error,true);
  release(day(0));await running;assert.equal(state.current.horizon,2);assert.equal(el('retry').hidden,true);
});
test('A stale background run cannot replace the newly selected day, and Refresh clears both caches',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const {state,site,el}=app(async(_site,h)=>h===0?pending:day(h));
  const old=state.runForecast();await tick();site.horizon=3;const fresh=state.runForecast({refresh:true});await tick();
  assert.equal(state.weatherCache.clears,1);assert.equal(state.gtiCache.clears,1);
  assert.equal(state.current.horizon,3);assert.equal(state.current.bestHours.date,'2026-11-13');
  release(day(0));await Promise.all([old,fresh]);
  assert.equal(state.current.horizon,3);assert.equal(el('best-heading').textContent,'Best solar window · Fri 13 Nov');
});
test('Today uses future intervals, load is optional, and a day with no intervals hides the card',async()=>{
  const {state,el}=app(async(_site,h)=>day(h),0);await state.runForecast();
  assert.ok(state.current.bestHours.start>=fixed);assert.equal(state.current.bestHours.date,'2026-11-10');assert.equal(el('load-result').hidden,true);
  state.current.remainingFrom=Date.parse('2026-11-10T00:00Z');state.updateBestHours();
  assert.ok(state.current.bestHours.start>=fixed,'A saved Today window also excludes intervals elapsed since it was saved');
  el('load-power').value='2';state.updateBestHours();
  assert.match(el('load-result').textContent,/low case covers .* of 4.0 kWh .*expected \(P50\) covers/);
  const text=el('load-result').textContent;
  state.site.unit='MW';state.site.arrays[0].capacity=.005;el('unit').value='MW';state.updateResult();
  assert.equal(el('load-result').textContent,text,'Load kW must not change when site display units change');
  el('load-power').value='';state.updateBestHours();assert.equal(el('load-result').hidden,true);assert.equal(state.current.loadPlan,null);
  state.current.remainingFrom=Date.parse('2026-11-11T00:00Z');state.updateBestHours();assert.equal(el('best-window').hidden,true);assert.equal(state.current.bestHours,null);
});
