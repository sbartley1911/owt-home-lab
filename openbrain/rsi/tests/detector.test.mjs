import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const query=async(sql,args=[]) => (await db.query(sql,args)).rows;
const asOf='2026-09-25T00:00:00Z';
before(async()=>{
  await db.exec(`CREATE ROLE openbrain; CREATE ROLE outsider; CREATE SCHEMA rsi;
    CREATE TABLE rsi.retrieval_requests(request_id text primary key,recorded_at timestamptz,path text,outcome text);
    CREATE TABLE rsi.retrieval_results(request_id text,entry_id uuid);
    CREATE TABLE brain_entries(id uuid primary key,content text,source text,source_ref text,
      captured_at timestamptz,updated_at timestamptz,status text);`);
  await db.exec(fs.readFileSync(new URL('../../db/migrations/0008_rsi_defect_detector.sql',import.meta.url),'utf8'));
  let seq=0;
  for(const [doc,bodies,status,age] of [
    ['pfsense',['heading\n\na','heading\n\nb','heading\n\nc'],'active',20],
    ['good',['normal prose '.repeat(30)],'active',20],
    ['retired',['bad bad bad'],'superseded',20],
    ['fresh',['normal prose '.repeat(30)],'active',1],
    ['garbled',['broken \\uFFFD \\uFFFD \\uFFFD extraction'],'active',20],
    ['recently-updated',['normal prose '.repeat(30)],'active',20]]) {
    for(let n=0;n<bodies.length;n++){
      const id=`10000000-0000-4000-8000-${String(++seq).padStart(12,'0')}`;
      await query(`INSERT INTO brain_entries VALUES($1,$2,'consume',$3,$4::timestamptz-$5::int*interval '1 day',
        $4::timestamptz-$6::int*interval '1 day',$7)`,[id,bodies[n],doc+'#'+n,asOf,age,doc==='recently-updated'?1:age,status]);
    }
  }
});
after(()=>db.close());
test('no logs still permits extraction review, but no not-observed conclusion',async()=>{
  const rows=await query('SELECT * FROM rsi.defect_candidates($1)',[asOf]);
  assert.deepEqual(rows.map(r=>r.reason).sort(),['garbled_chunks','short_chunks']);
});
test('coverage gate, grace period, retired rows and semantic-only observations',async()=>{
  await query(`INSERT INTO rsi.retrieval_requests SELECT 'q'||n,$1::timestamptz-interval '8 days',
    'semantic_search','results' FROM generate_series(1,20)n`,[asOf]);
  const good=(await query("SELECT id FROM brain_entries WHERE source_ref='good#0'"))[0].id;
  await query("INSERT INTO rsi.retrieval_results VALUES ('q1',$1)",[good]);
  // recent_entries must not count as successful semantic retrieval.
  await query("INSERT INTO rsi.retrieval_requests VALUES ('recent',$1,'recent_entries','results')",[asOf]);
  await db.exec("INSERT INTO rsi.retrieval_results SELECT 'recent',id FROM brain_entries WHERE source_ref='pfsense#0'");
  const rows=await query('SELECT * FROM rsi.defect_candidates($1)',[asOf]);
  assert.deepEqual(rows.filter(r=>r.reason==='not_observed').map(r=>r.doc_ref).sort(),['garbled','pfsense']);
  assert.equal(rows.find(r=>r.reason==='short_chunks').evidence.affected_chunks,3);
  assert.ok(rows.every(r=>!JSON.stringify(r.evidence).includes('normal prose')));
});
test('scan is additive, idempotent per finding, preserves disposition, and restricts execution',async()=>{
  const before=await query('SELECT * FROM brain_entries ORDER BY id');
  await db.exec('SELECT rsi.scan_defects()');
  const count=(await query('SELECT count(*) n FROM rsi.defect_reviews'))[0].n;
  await db.exec("UPDATE rsi.defect_reviews SET status='dismissed' WHERE reason='short_chunks'; SELECT rsi.scan_defects()");
  assert.equal((await query('SELECT count(*) n FROM rsi.defect_reviews'))[0].n,count);
  assert.equal((await query("SELECT status FROM rsi.defect_reviews WHERE reason='short_chunks'"))[0].status,'dismissed');
  assert.deepEqual(await query('SELECT * FROM brain_entries ORDER BY id'),before);
  await db.exec('SET ROLE outsider');
  await assert.rejects(db.exec('SELECT rsi.scan_defects()'),/permission denied/);
  await db.exec('RESET ROLE; SET ROLE openbrain; SELECT rsi.scan_defects(); RESET ROLE;');
});
