import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const health=async()=> (await db.query('SELECT * FROM rsi_monitoring.detector_health')).rows[0];
before(async()=>{
  await db.exec(`CREATE ROLE cnpg_metrics_exporter;
    CREATE TABLE execution_entity(id int PRIMARY KEY,"workflowId" text,mode text,status text,
      "startedAt" timestamptz,"stoppedAt" timestamptz,"deletedAt" timestamptz);`);
  await db.exec(fs.readFileSync(new URL('../monitoring/detector-health.sql',import.meta.url),'utf8'));
});
after(()=>db.close());
test('no execution is visible as zero timestamps; manual and other-workflow failures are excluded',async()=>{
  assert.equal((await health()).last_success_timestamp,0);
  await db.exec(`INSERT INTO execution_entity VALUES
    (1,'REPLACE_WITH_DETECTOR_WORKFLOW_ID','manual','error',now(),now(),NULL),
    (2,'other','trigger','error',now(),now(),NULL);`);
  assert.equal((await health()).latest_failed,0);
  assert.equal((await health()).last_failure_timestamp,0);
});
test('automatic failures stay visible while a later execution is running',async()=>{
  await db.exec(`INSERT INTO execution_entity VALUES
    (3,'REPLACE_WITH_DETECTOR_WORKFLOW_ID','trigger','error','2026-10-03T05:00Z','2026-10-03T05:01Z',NULL),
    (4,'REPLACE_WITH_DETECTOR_WORKFLOW_ID','trigger','running','2026-10-03T05:02Z',NULL,NULL);`);
  assert.equal((await health()).latest_failed,1);
  assert.equal((await health()).last_failure_timestamp,Date.parse('2026-10-03T05:01Z')/1000);
});
test('successful recovery clears current failure while retaining the recent-failure timestamp',async()=>{
  await db.exec(`INSERT INTO execution_entity VALUES
    (5,'REPLACE_WITH_DETECTOR_WORKFLOW_ID','trigger','success','2026-10-03T05:03Z','2026-10-03T05:04Z',NULL);`);
  const h=await health();assert.equal(h.latest_failed,0);
  assert.equal(h.last_success_timestamp,Date.parse('2026-10-03T05:04Z')/1000);
  assert.equal(h.last_failure_timestamp,Date.parse('2026-10-03T05:01Z')/1000);
});
test('soft-deleted failures do not override recovery',async()=>{
  await db.exec(`INSERT INTO execution_entity VALUES
    (6,'REPLACE_WITH_DETECTOR_WORKFLOW_ID','trigger','error',now(),now(),now());`);
  assert.equal((await health()).latest_failed,0);
});
test('exporter can read aggregate health but cannot read executions or write the view',async()=>{
  await db.exec('SET ROLE cnpg_metrics_exporter');
  assert.equal((await health()).latest_failed,0);
  await assert.rejects(db.exec('SELECT * FROM execution_entity'),/permission denied/);
  const permission=(await db.query("SELECT has_table_privilege(current_user,'rsi_monitoring.detector_health','DELETE') AS allowed")).rows[0];
  assert.equal(permission.allowed,false);
  await assert.rejects(db.exec('DELETE FROM rsi_monitoring.detector_health'),/permission denied|cannot delete from view/);
  await db.exec('RESET ROLE');
});
