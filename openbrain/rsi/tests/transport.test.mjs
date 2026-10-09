import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connect} from '../run-live.mjs';
test('MCP initialization, session headers, and SSE results work without waiting for stream closure',async()=>{
  let n=0;let cancelled=false;
  const search=await connect('https://fixture.invalid/mcp','fixture-token',async(url,options)=>{
    const body=JSON.parse(options.body);n++;
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer fixture-token');
    if(n===1){assert.equal(body.method,'initialize');return new Response(JSON.stringify({id:body.id,result:{protocolVersion:'2024-11-05'}}),{headers:{'mcp-session-id':'fixture-session','content-type':'application/json'}});}
    assert.equal(options.headers['Mcp-Session-Id'],'fixture-session');
    if(n===2){assert.equal(body.method,'notifications/initialized');assert.ok(!('id' in body));return new Response(null,{status:202});}
    assert.equal(body.params.name,'semantic_search');
    const encoder=new TextEncoder();
    return new Response(new ReadableStream({start(controller){
      controller.enqueue(encoder.encode('event: message\r'));
      controller.enqueue(encoder.encode('\ndata: '+JSON.stringify({jsonrpc:'2.0',id:body.id,result:{content:[]}})+'\r\n\r\n'));
    },cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
  });
  assert.deepEqual(await search({query:'fixture'}),{content:[]});
  assert.equal(n,3);assert.equal(cancelled,true);
});
test('HTTP and protocol errors reject without exposing response bodies',async()=>{
  await assert.rejects(connect('http://fixture.invalid','x'),/HTTPS/);
  await assert.rejects(connect('https://fixture.invalid','x',async()=>new Response('sensitive',{status:401})),/^Error: MCP HTTP 401$/);
  await assert.rejects(connect('https://fixture.invalid','x',async()=>new Response(JSON.stringify({id:99,result:{}}))),/protocol error/);
});
