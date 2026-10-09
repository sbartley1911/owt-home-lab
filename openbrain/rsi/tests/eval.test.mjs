import { test } from 'node:test';
import assert from 'node:assert/strict';
import {digest,score,runSuite} from '../eval.mjs';
const id='10000000-0000-4000-8000-000000000001';
const suite={version:'fixture-v1',cases:[{id:'case',query:'fixture',count:3,expected_ids:[id]}]};
const evidence=response=>({suite_sha256:digest(suite),cases:[{id:'case',executed_at:'2026-09-25T00:00:00Z',response}]});
const hit={id,request_id:'request',outcome:'results',telemetry:'recorded'};
test('exact expected IDs determine rank; incidental matches and metadata do not count',()=>{
  const report=score(suite,evidence([{...hit,id:'other'},hit]));
  assert.equal(report.hit_rate,1); assert.equal(report.mean_reciprocal_rank,0.5);
  assert.equal(score(suite,evidence([{request_id:'r',outcome:'empty'}])).misses,1);
  assert.equal(score(suite,evidence([{...hit,id:'other'}])).misses,1);
});
test('errors, malformed envelopes and failed transport never become retrieval misses',()=>{
  for(const response of [[],[{outcome:'error',request_id:'r'}],{isError:true},[{}],[{...hit,request_id:null}],
    [{...hit,outcome:'empty'}],[hit,{request_id:'r',outcome:'empty'}]]) {
    const result=score(suite,evidence(response));
    assert.equal(result.errors,1); assert.equal(result.misses,0); assert.equal(result.hit_rate,0);
  }
  assert.equal(score(suite,evidence([{...hit,telemetry:'failed'}])).hits,1);
});
test('suite mismatch and incomplete evidence fail closed',()=>{
  assert.throws(()=>score({...suite,version:'v2'},evidence([hit])),/different suite/);
  assert.throws(()=>score(suite,{suite_sha256:digest(suite),cases:[]}),/Incomplete/);
});
test('live adapter passes filters, serializes calls and captures transport failures safely',async()=>{
  const s={...suite,cases:[{...suite.cases[0],source:'consume'}]};
  const run=await runSuite(s,async args=>{assert.deepEqual(args,{query:'fixture',count:3,source:'consume'});return {content:[{type:'text',text:JSON.stringify([hit])}]};});
  assert.equal(score(s,run).hits,1);
  const failed=await runSuite(s,async()=>{throw Error('potential sensitive error');});
  assert.equal(score(s,failed).errors,1);assert.ok(!JSON.stringify(failed).includes('sensitive'));
});
