import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {runSuite,score} from './eval.mjs';

// Streamable HTTP transport. OAuth access tokens or the existing MCP bearer are
// supplied by the operator's credential helper through the environment, never argv.
export async function connect(url,token,fetcher=fetch) {
  const parsed=new URL(url);
  if(parsed.protocol!=='https:' || parsed.username || parsed.password) throw Error('An HTTPS MCP endpoint is required');
  let session; let nextId=1; let protocol='2024-11-05';
  async function send(method,params,notification=false) {
    const id=nextId++;
    const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream',
      'MCP-Protocol-Version':protocol,...(token?{Authorization:`Bearer ${token}`}:{})};
    if(session) headers['Mcp-Session-Id']=session;
    const response=await fetcher(url,{method:'POST',redirect:'error',headers,
      signal:AbortSignal.timeout(90000),body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params})});
    if(!response.ok) throw Error(`MCP HTTP ${response.status}`);
    session=response.headers.get('mcp-session-id')||session;
    if(notification) {await response.body?.cancel();return;}
    const contentType=response.headers.get('content-type')||'';
    let message;
    if(contentType.includes('text/event-stream')) {
      // Stop on our response; a persistent event stream need not close afterward.
      const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer='';
      try {
        while(!message){
          const {done,value}=await reader.read();
          buffer=(buffer+decoder.decode(value,{stream:!done})).replace(/\r\n/g,'\n');
          let boundary;
          while((boundary=buffer.indexOf('\n\n'))>=0){
            const event=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
            const data=event.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
            if(data){const candidate=JSON.parse(data);if(candidate.id===id)message=candidate;}
          }
          if(done)break;
        }
      } finally {await reader.cancel();}
    } else message=await response.json();
    if(!message || message.id!==id || message.error || !('result' in message)) throw Error('MCP protocol error');
    return message.result;
  }
  const initialized=await send('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'openbrain-rsi-eval',version:'1'}});
  protocol=initialized.protocolVersion;
  await send('notifications/initialized',{},true);
  return args=>send('tools/call',{name:'semantic_search',arguments:args});
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [suitePath,evidencePath]=process.argv.slice(2);
  if(!suitePath || !evidencePath || !process.env.OPENBRAIN_MCP_URL) throw Error('Usage: node run-live.mjs suite.json evidence.json; set OPENBRAIN_MCP_URL and protected OPENBRAIN_MCP_TOKEN');
  try {
    const suite=JSON.parse(await fs.readFile(suitePath,'utf8'));
    const search=await connect(process.env.OPENBRAIN_MCP_URL,process.env.OPENBRAIN_MCP_TOKEN);
    const evidence=await runSuite(suite,search);
    await fs.writeFile(evidencePath,JSON.stringify(evidence,null,2),{mode:0o600});
    const report=score(suite,evidence);
    console.log(JSON.stringify(report,null,2));
    if(report.errors)process.exitCode=2;
  } catch (error) {
    const detail=/^MCP HTTP \d{3}$/.test(error.message)?error.message:'transport, protocol, authentication or input failure';
    console.error(`Evaluation failed: ${detail}.`);process.exitCode=2;
  }
}
