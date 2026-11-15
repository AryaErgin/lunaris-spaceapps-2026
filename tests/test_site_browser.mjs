// Actual Chrome integration and load benchmark; no frontend layout changes.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.cwd(),work=resolve(root,'progress',`site-browser-${Date.now()}`);
await mkdir(work,{recursive:true});
const mime={'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.jpg':'image/jpeg','.png':'image/png'};
const server=createServer(async(request,response)=>{
  const pathname=new URL(request.url,'http://localhost').pathname;
  const file=resolve(root,`.${pathname.endsWith('/')?pathname+'index.html':pathname}`);
  if(!file.startsWith(root+sep))return response.writeHead(403).end();
  try{response.setHeader('Content-Type',mime[extname(file)]??'application/octet-stream');response.end(await readFile(file));}
  catch{response.writeHead(404).end();}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const profile=resolve(work,'profile'),executable=process.env.LUNARIS_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe';
const chrome=spawn(executable,['--headless=new',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--no-first-run','--disable-extensions','--disable-background-networking','about:blank'],{stdio:['ignore','ignore','pipe']});
let log='',socket;
chrome.stderr.on('data',chunk=>{log=(log+chunk).slice(-4000);});
chrome.on('error',error=>{log+=error.message;});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(action){for(let i=0;i<100;i++){const value=await action().catch(()=>null);if(value)return value;await pause(100);}throw Error('Browser prerequisite timed out. '+log);}
try{
  const port=(await until(()=>readFile(resolve(profile,'DevToolsActivePort'),'utf8'))).split(/\r?\n/)[0];
  const target=(await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json())).find(t=>t.type==='page');
  socket=new WebSocket(target.webSocketDebuggerUrl);await once(socket,'open');
  const pending=new Map(),requests=[],errors=[];let next=0;
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(message.method==='Network.requestWillBeSent')requests.push(message.params.request.url);
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);
    const handler=pending.get(message.id);if(handler){pending.delete(message.id);message.error?handler.reject(Error(JSON.stringify(message.error))):handler.resolve(message.result);}
  });
  function command(method,params={}){return new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});}
  async function evaluate(expression){const reply=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(reply.exceptionDetails)throw Error(reply.exceptionDetails.exception?.description??reply.exceptionDetails.text);return reply.result.value;}
  await command('Network.enable');await command('Network.setCacheDisabled',{cacheDisabled:true});await command('Runtime.enable');
  const url=`http://127.0.0.1:${server.address().port}/web/`;
  await command('Page.navigate',{url});
  await until(()=>evaluate("Boolean(document.querySelector('#export:not([disabled])'))"));
  const result=await evaluate(`(async()=>{
    const began=performance.now();
    const [{createAnalysisContext},{communicationDemo},bundle]=await Promise.all([
      import('./site-analysis.mjs'),import('./overview.mjs'),fetch('./data/bundle.json').then(r=>r.json())]);
    const loaded=performance.now(),analysis=createAnalysisContext(bundle),sites=analysis.listSites(),inputs=communicationDemo(bundle);
    const comparison=analysis.compareSites({siteIds:sites.map(s=>s.id),inputs,time:inputs.nominal});
    const compared=performance.now(),annual=analysis.compareSites({siteIds:sites.map(s=>s.id),range:bundle.coverage,time:bundle.coverage[0]});
    const full=performance.now(),again=analysis.compareSites({siteIds:sites.map(s=>s.id),inputs,time:inputs.nominal});
    const switched=sites.map(site=>analysis.analyzeSite({siteId:site.id,time:inputs.nominal,range:[inputs.nominal,inputs.nominal+43200]}).site.id);
    const recovery=analysis.replan({inputs});
    return {siteIds:sites.map(s=>s.id),terrainIds:sites.filter(s=>s.capabilities.missionEvaluation).map(s=>s.id),switched,
      geometryOnly:comparison.rows.filter(r=>r.analysisMode==='geometry-only').map(r=>({id:r.site.id,decision:r.decision,terrainMetrics:r.terrainMetrics})),
      farSide:annual.rows.find(r=>r.site.id==='change-4').levelGeometry.earth,
      parity:JSON.stringify(comparison)===JSON.stringify(again),outcomes:[recovery.nominal.status,recovery.delayed.status,recovery.recommended?.status],
      recoveryStart:recovery.recommended?.start,elapsedMs:{load:loaded-began,firstComparison:compared-loaded,annualComparison:full-compared,warmComparison:performance.now()-full},
      javascriptHeapBytes:performance.memory?.usedJSHeapSize??null,userAgent:navigator.userAgent};
  })()`);
  assert.equal(result.siteIds.length,13);assert.equal(result.terrainIds.length,4);assert.deepEqual(result.switched,result.siteIds);
  assert.equal(result.geometryOnly.length,9);for(const row of result.geometryOnly){assert.equal(row.decision,null);assert.equal(row.terrainMetrics,null);}
  assert.equal(result.farSide.aboveLevelSecondsEstimate,0);assert.equal(result.farSide.unknownSeconds,0);
  assert(result.parity);assert.deepEqual(result.outcomes,['PASS','FAIL','PASS']);
  assert.equal(result.recoveryStart,Date.parse('2026-11-17T03:00:00Z')/1000);
  assert.deepEqual(errors,[]);
  const remote=requests.filter(url=>/^https?:/.test(url)&&!url.startsWith(`http://127.0.0.1:${server.address().port}/`));
  assert.deepEqual(remote,[],'Offline workflow must not call external services');
  const artifacts=[];
  for(const name of ['web/site-registry.mjs','web/site-analysis.mjs','web/data/site-catalog.json']){
    const bytes=await readFile(resolve(root,name));artifacts.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  const evidence={...result,artifacts,networkRequestCount:requests.length,remoteRequests:remote,browserExceptions:errors,
    scope:'Fresh Chrome document and cache-disabled local HTTP. OS cache, CPU scheduling and physical mobile hardware are not controlled. No graphics performance claim.'};
  await writeFile(resolve(work,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));console.log('Scientific registry browser checks passed. Evidence: '+work);
}finally{socket?.close();chrome.kill();server.close();}
