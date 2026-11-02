import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {verifyChain} from '../forecast.js';
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
const days=JSON.parse(await read('../ledger/index.json')).days;
const files=await Promise.all(days.map(async date=>({date,text:await read(`../ledger/${date}.json`)})));
test('Published ledger chain verifies original file bytes',async()=>{
  const result=await verifyChain(files); assert.equal(result.ok,true); assert.equal(result.count,files.length);
});
test('Changed file is rejected at the first broken link',async()=>{
  const changed=structuredClone(files); changed[0].text+=' ';
  const result=await verifyChain(changed); assert.equal(result.ok,false); assert.equal(result.brokenDate,files[1].date);
});
test('Reject reordered, missing, malformed and non-genesis sequences',async()=>{
  assert.equal((await verifyChain(files.slice(1))).ok,false);
  assert.equal((await verifyChain([files[1],files[0]])).ok,false);
  assert.equal((await verifyChain([{date:days[0],text:'{'}])).ok,false);
  assert.equal((await verifyChain(files.filter((_,i)=>i!==1))).ok,false);
});
test('Valid synthetic sequence accepts exact bytes; changed predecessor fails',async()=>{
  const first={date:'2026-01-01',text:JSON.stringify({target_date:'2026-01-01',prev_sha256:null})};
  const second={date:'2026-01-02',text:JSON.stringify({target_date:'2026-01-02',prev_sha256:createHash('sha256').update(first.text).digest('hex')})};
  assert.equal((await verifyChain([first,second])).ok,true);
  assert.equal((await verifyChain([{...first,text:first.text+'\n'},second])).ok,false);
});
