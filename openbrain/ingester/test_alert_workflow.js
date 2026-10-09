import assert from 'node:assert/strict';
import fs from 'node:fs';
const workflow=JSON.parse(fs.readFileSync(new URL('./workflow.ingest-failure-alerts.json',import.meta.url),'utf8'));
function run(name,input,previous={},state={}) {
 const code=workflow.nodes.find(n=>n.name===name).parameters.jsCode;
 return new Function('$input','$','$getWorkflowStaticData',code)(
  {first:()=>({json:input})}, name=>({first:()=>({json:previous[name]})}),()=>state);
}
assert.deepEqual(run('Prepare digest',{reports:[]}),[]);
const report={id:'11111111-1111-4111-8111-111111111111',lease_token:'22222222-2222-4222-8222-222222222222',created_at:'2026-09-25T00:00:00Z',synthetic:'true'};
const digest=run('Prepare digest',{reports:[report]})[0].json;
assert.match(digest.subject,/^\[TEST\]/);
assert.match(digest.text,/11111111/);
assert.equal(digest.reports.length,1);
const monitor=run('Prepare digest',{error:'fixture-sensitive-error'})[0].json;
assert.equal(monitor.monitorError,true);
assert.ok(!monitor.text.includes('fixture-sensitive-error'));
assert.deepEqual(run('Prepare digest',{error:'bad'}, {},{lastMonitorAlert:Date.now()}),[]);
const to=workflow.nodes.find(n=>n.name==='Email digest').parameters.toEmail;
assert.throws(()=>run('Verify SMTP acceptance',{accepted:[],messageId:'x'},{'Prepare digest':digest}),/did not confirm/);
const accepted=run('Verify SMTP acceptance',{accepted:[to],messageId:'x'},{'Prepare digest':digest})[0].json;
assert.equal(accepted.messageId,'x');
assert.deepEqual(accepted.reports,[report]);
const state={};
assert.deepEqual(run('Verify SMTP acceptance',{accepted:[to],messageId:'x'},{'Prepare digest':monitor},state),[]);
assert.ok(state.lastMonitorAlert>0);
assert.throws(()=>run('Verify acknowledgement',{acknowledged:0},{'Verify SMTP acceptance':accepted}),/mismatch/);
assert.equal(run('Verify acknowledgement',{acknowledged:1},{'Verify SMTP acceptance':accepted})[0].json.acknowledged,1);
console.log('PASS: empty polling, safe digest, monitor failure, cooldown, SMTP rejection/acceptance, acknowledgement mismatch');
