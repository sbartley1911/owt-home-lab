import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

const db = new PGlite({extensions:{vector}});
const root = new URL('../',import.meta.url);
const ids = ['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003'];
const embedding = '[' + [1,...Array(1535).fill(0)].join(',') + ']';
const actor = 'mcp:openbrain';
const query = async (sql,args=[]) => (await db.query(sql,args)).rows;
const result = async (sql,args=[]) => (await query(sql,args))[0].retrieval;
const count = async table => Number((await query('select count(*) as n from rsi.'+table))[0].n);

before(async () => {
  await db.exec(`CREATE EXTENSION vector;
    CREATE ROLE openbrain_mcp_ro; CREATE ROLE openbrain_mcp_rw; CREATE ROLE outsider;
    CREATE TABLE public.brain_entries(id uuid PRIMARY KEY,content text,source text,source_ref text,
      captured_at timestamptz,embedding vector(1536),metadata jsonb,people text[],topics text[],
      entry_type text,status text,superseded_by uuid,supersession_reason text,provenance text,
      content_search tsvector GENERATED ALWAYS AS (to_tsvector('english',content)) STORED);
    GRANT SELECT ON public.brain_entries TO openbrain_mcp_ro,openbrain_mcp_rw;`);
  for (let n=0;n<3;n++) await query(`INSERT INTO public.brain_entries
    (id,content,source,source_ref,captured_at,embedding,status,provenance)
    VALUES ($1,$2,$3,$4,$5,$6::vector,$7,'internal')`,
    [ids[n],['Postgres firewall current','a separate current document','Postgres obsolete note'][n],
      n===1?'policy':'reference','fixture-'+n,'2026-09-0'+(n+1)+'T00:00:00Z',embedding,n===2?'superseded':'active']);
  await db.exec(fs.readFileSync(new URL('tests/fixtures/baseline-search.sql',root),'utf8'));
  await db.exec(fs.readFileSync(new URL('../db/migrations/0006_retrieval_feedback.sql',root),'utf8'));
});
after(async()=>db.close());

test('hybrid results, order, rounding and filters equal the uninstrumented live SQL',async()=>{
  for (const [name,source,k] of [['normal',null,8],['filtered','policy',1],['empty','absent',8]]) {
    const baseline = await query(`select id,content,source,source_ref,captured_at,
      round(similarity::numeric,4) as similarity,rrf_score
      from public.hybrid_brain_entries($1::vector,$2,$3,$4)`,[embedding,'Postgres',k,source]);
    const logged = await result('select rsi.search($1,$2,$3,$4::vector,$5,$6) as retrieval',
      [name,actor,'Postgres',embedding,k,source]);
    // Normalize driver-specific timestamptz/numeric representations only.
    const normalize = rows => rows.map(r=>({...r,captured_at:new Date(r.captured_at).toISOString(),similarity:Number(r.similarity)}));
    assert.deepEqual(normalize(logged.results),normalize(baseline));
    assert.equal(logged.telemetry,'recorded');
    assert.equal(logged.outcome,name==='empty'?'empty':'results');
    const hits = await query('select entry_id,rank from rsi.retrieval_results where request_id=$1 order by rank',[name]);
    assert.deepEqual(hits.map(h=>h.entry_id),baseline.map(h=>h.id));
  }
});

test('recent/history and exact-ID reads are logged, including invalid or absent IDs',async()=>{
  const recent = await result("select rsi.recent('recent',$1,10,false) as retrieval",[actor]);
  assert.deepEqual(recent.results.map(r=>r.id),[ids[1],ids[0]]);
  const history = await result("select rsi.recent('history',$1,10,true) as retrieval",[actor]);
  assert.equal(history.results.length,3);
  const exact = await result("select rsi.entry('exact',$1,$2) as retrieval",[actor,ids[2]]);
  assert.equal(exact.results[0].status,'superseded');
  const missing = await result("select rsi.entry('missing',$1,'not-a-uuid') as retrieval",[actor]);
  assert.equal(missing.outcome,'empty');
});

test('retries are idempotent and conflicting reuse is visible',async()=>{
  const first = await result("select rsi.entry('retry',$1,$2) as retrieval",[actor,ids[0]]);
  const n = await count('retrieval_requests');
  assert.deepEqual(await result("select rsi.entry('retry',$1,$2) as retrieval",[actor,ids[0]]),first);
  assert.equal(await count('retrieval_requests'),n);
  const conflict = await result("select rsi.entry('retry',$1,$2) as retrieval",[actor,ids[1]]);
  assert.equal(conflict.telemetry,'failed');
  assert.equal(conflict.telemetry_error_code,'22023');
  assert.equal(conflict.results[0].id,ids[1]);
});

test('feedback validates caller and rating, preserves revisions and deduplicates retries',async()=>{
  const fid='20000000-0000-4000-8000-000000000001';
  const sql='select rsi.record_feedback($1,$2,$3,$4,$5,$6)';
  const args=[fid,'normal',actor,'not_useful','Expected current firewall documentation',ids[0]];
  await query(sql,args); await query(sql,args);
  assert.equal(await count('retrieval_feedback'),1);
  await assert.rejects(query(sql,[fid,'normal',actor,'useful',null,null]),/reused/);
  await assert.rejects(query(sql,['20000000-0000-4000-8000-000000000002','normal','mcp:openbrain-openai','useful',null,null]),/caller mismatch/);
  await assert.rejects(query(sql,['20000000-0000-4000-8000-000000000002','missing-id',actor,'useful',null,null]),/Unknown request/);
  await assert.rejects(query(sql,['20000000-0000-4000-8000-000000000002','normal',actor,'good',null,null]),/check constraint/);
});

test('read-only caller can log and give feedback but cannot mutate corpus or log tables',async()=>{
  await db.exec('SET ROLE openbrain_mcp_ro');
  try {
    const r=await result("select rsi.entry('ro',$1,$2) as retrieval",[actor,ids[0]]);
    assert.equal(r.telemetry,'recorded');
    await query("select rsi.record_feedback('20000000-0000-4000-8000-000000000003','ro',$1,'useful')",[actor]);
    await assert.rejects(query("UPDATE public.brain_entries SET content='changed'"),/permission denied/);
    await assert.rejects(query('DELETE FROM rsi.retrieval_requests'),/permission denied/);
  } finally {await db.exec('RESET ROLE');}
  await db.exec('SET ROLE outsider');
  try {await assert.rejects(query("select rsi.entry('unauthorized','x','x')"),/permission denied/);}
  finally {await db.exec('RESET ROLE');}
});

test('search and embedding failures are distinct from empty responses',async()=>{
  const badVector='[1,0]';
  const failed=await result("select rsi.search('search-error',$1,'Postgres',$2::vector,8,null) as retrieval",[actor,badVector]);
  assert.equal(failed.outcome,'error'); assert.equal(failed.telemetry,'recorded');
  assert.ok(failed.error_code); assert.deepEqual(failed.results,[]);
  const embed=await result("select rsi.finish_retrieval('embedding-error',$1,'semantic_search','{\"query\":\"Postgres\"}','[]','embedding_failed') as retrieval",[actor]);
  assert.equal(embed.outcome,'error'); assert.equal(embed.error_code,'embedding_failed');
});

test('telemetry failure preserves retrieval and emits a warning without partial rows',async()=>{
  await db.exec(`CREATE FUNCTION rsi.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated write failure'; END $$;
    CREATE TRIGGER test_fail BEFORE INSERT ON rsi.retrieval_results FOR EACH ROW EXECUTE FUNCTION rsi.test_fail();`);
  try {
    const r=await result("select rsi.entry('write-fail',$1,$2) as retrieval",[actor,ids[0]]);
    assert.equal(r.telemetry,'failed'); assert.equal(r.results[0].id,ids[0]); assert.ok(r.warning);
    assert.equal((await query("select * from rsi.retrieval_requests where request_id='write-fail'")).length,0);
  } finally {await db.exec('DROP TRIGGER test_fail ON rsi.retrieval_results; DROP FUNCTION rsi.test_fail();');}
});

test('N-day report separates negative, empty, error and unreviewed with feedback coverage',async()=>{
  const sql=fs.readFileSync(new URL('failures.sql',root),'utf8').replaceAll(":'days'",'7');
  const rows=await query(sql);
  assert.equal(rows.find(r=>r.request_id==='normal').category,'not_useful');
  assert.equal(rows.find(r=>r.request_id==='empty').category,'empty_results');
  assert.equal(rows.find(r=>r.request_id==='search-error').category,'retrieval_error');
  assert.equal(rows.find(r=>r.request_id==='recent').category,'unreviewed');
  assert.ok(Number(rows[0].reviewed_requests)<Number(rows[0].total_requests));
});

test('generated direct-tool SQL preserves top-level rows and returns empty metadata',async()=>{
  const mcp=JSON.parse(fs.readFileSync(new URL('../n8n/openbrain-mcp.json',root),'utf8'));
  const recent=mcp.nodes.find(n=>n.name==='recent_entries');
  const rows=await query(recent.parameters.query,[10,false,actor]);
  assert.equal(rows[0].id,ids[1]); assert.equal(rows[0].content,'a separate current document');
  assert.equal(rows[0].telemetry,'recorded'); assert.ok(rows[0].request_id);
  const exact=mcp.nodes.find(n=>n.name==='get_entry_by_id');
  const empty=await query(exact.parameters.query,['missing',actor]);
  assert.equal(empty.length,1); assert.equal(empty[0].content,null); assert.equal(empty[0].outcome,'empty');
});

test('measure warm search overhead on the synthetic fixture',async t=>{
  const baseline=[],logged=[];
  for(let i=0;i<20;i++){
    let start=performance.now();
    await query('select * from public.hybrid_brain_entries($1::vector,$2,8,null)',[embedding,'Postgres']);
    baseline.push(performance.now()-start);
    start=performance.now();
    const r=await result('select rsi.search($1,$2,$3,$4::vector,8,null) as retrieval',
      ['timing-'+i,actor,'Postgres',embedding]);
    assert.equal(r.telemetry,'recorded');
    logged.push(performance.now()-start);
  }
  const median=xs=>xs.sort((a,b)=>a-b)[Math.floor(xs.length/2)].toFixed(2);
  t.diagnostic(`Synthetic PGlite fixture only, 20 warm calls: baseline median ${median(baseline)} ms; logged median ${median(logged)} ms. Production latency still requires measurement.`);
});
