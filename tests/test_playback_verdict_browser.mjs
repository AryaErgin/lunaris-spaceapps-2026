// Focused original-plan versus hypothetical view-clock regression.
// Local static server by default. Optional anonymous public check:
// LUNARIS_PUBLIC_URL=https://.../ LUNARIS_EXPECTED_SHA=<40hex> node tests/test_playback_verdict_browser.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {evaluateStart} from '../web/engine.mjs';
import {communicationDemo} from '../web/overview.mjs';
import {missionMetrics} from '../web/operations.mjs';
import {firstScreenConclusion} from '../web/explanations.mjs';
const root=process.cwd(),work=resolve(root,'.operator',`playback-verdict-${Date.now()}-${process.pid}`);
await mkdir(work,{recursive:true});
const bundle=JSON.parse(await readFile(resolve(root,'web/data/bundle.json'),'utf8'));
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.json':'application/json','.css':'text/css','.jpg':'image/jpeg','.png':'image/png','.woff2':'font/woff2'};
let server;
if(!process.env.LUNARIS_PUBLIC_URL){
 server=createServer(async(req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/favicon.ico'){res.writeHead(204).end();return;}const file=resolve(root,`.${pathname.endsWith('/')?pathname+'index.html':pathname}`);if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}try{res.setHeader('Content-Type',mime[extname(file)]??'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404).end();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
}
const url=process.env.LUNARIS_PUBLIC_URL??`http://127.0.0.1:${server.address().port}/web/`,expectedSha=process.env.LUNARIS_EXPECTED_SHA??null;
if(process.env.LUNARIS_PUBLIC_URL){assert.match(expectedSha??'',/^[a-f0-9]{40}$/);const release=await fetch(new URL('release.json',url)).then(r=>{assert.equal(r.status,200);return r.json();});assert.equal(release.application_release_sha,expectedSha);}
const evidence={url,expectedSha,status:'RUNNING',viewports:[],limitations:['One desktop smoke only; no mobile, screenshot or broad regression sweep.','The normal verdict remains tied to the actual selected arrival while the view clock moves; changing arrival explicitly creates a new decision.']};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=45000){const start=Date.now();while(Date.now()-start<timeout){const v=await fn();if(v)return v;await pause(60);}throw Error('Timed out: '+label);}
const utc=value=>Date.parse(value+'Z')/1000;
const fieldsToInputs=saved=>{const f=saved.fields,num=id=>f[id]===''?null:Number(f[id]);return{siteId:f.site,nominal:utc(f.nominal),durationHours:num('duration'),delayHours:num('delay'),maxSunHours:num('max-sun'),maxEarthHours:num('max-earth'),minJointHours:num('min-total'),minContinuousJointHours:num('min-continuous'),earliest:utc(f.earliest),latest:utc(f.latest),gridMinutes:num('grid'),mode:saved.prelaunch?'prelaunch':'same-site'};};
let browser,socket;
try{
 for(const viewport of [{width:1366,height:768}]){
  const label=`${viewport.width}x${viewport.height}`,record={viewport,exceptions:[],assessments:[]};evidence.viewports.push(record);
  const profile=resolve(work,'chrome-'+label);browser=spawn(process.env.LUNARIS_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--remote-debugging-port=0','--no-first-run','--disable-extensions','--disable-background-networking',`--user-data-dir=${profile}`,'--use-angle=swiftshader','--enable-unsafe-swiftshader','about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  await until(async()=>{try{return(await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).length;}catch{return false;}},'Chrome startup');
  const port=(await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0],tabs=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
  socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await once(socket,'open');let next=0;const pending=new Map();
  socket.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.method==='Runtime.exceptionThrown')record.exceptions.push(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.no(Error(JSON.stringify(m.error))):p.ok(m.result);}});
  const command=(method,params={})=>new Promise((ok,no)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);no(Error('CDP timeout '+method));},60000);pending.set(id,{ok:v=>{clearTimeout(timer);ok(v);},no:e=>{clearTimeout(timer);no(e);}});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
  const saved=()=>evaluate(`import(${JSON.stringify(new URL('app.mjs',url).href)}).then(m=>m.captureOnboardingPlan())`);
  const click=async selector=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);const point=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:!n.disabled&&r.width>0&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);assert(point.hit,selector+' must be reachable');await command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});};
  const shown=()=>evaluate("(()=>{const n=document.querySelector('#mission-story'),badge=document.querySelector('#story-status');return{status:badge.textContent.trim(),hidden:badge.hidden,assessmentStart:Number(badge.dataset.assessmentStart),title:document.querySelector('#story-title').textContent.trim(),explanation:document.querySelector('#story-explanation').textContent,data:{...n.dataset},clock:Number(document.querySelector('#scene-mount').dataset.time)}})()");
  await command('Runtime.enable');await command('Page.enable');await command('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:false});await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await command('Page.bringToFront');await command('Page.navigate',{url});
  await until(()=>evaluate("!!document.querySelector('#export:not([disabled])')"),'actual data ready');await until(()=>evaluate("!!document.querySelector('#quick-tour')"),'first visit offer');await evaluate("document.querySelector('.quick-tour-close').click()");
  assert.equal(await evaluate("!!document.querySelector('#hero-landing-verdict')"),false,'There must be no duplicate verdict panel.');

  // 1. The normal mission verdict belongs to the actual selected arrival,
  // regardless of which instant the sky playback is showing.
  const normalPlan=await saved(),normalInputs=fieldsToInputs(normalPlan),normalSite=bundle.sites.find(site=>site.id===normalInputs.siteId),normalBefore=await shown();
  assert.equal(normalPlan.delayStoryEnabled,false);
  const nominalDecision=evaluateStart(bundle,normalInputs),conclusion=firstScreenConclusion(missionMetrics(nominalDecision,normalSite),normalInputs.durationHours*3600);
  assert.equal(nominalDecision.status,'PASS');assert.equal(normalBefore.title,conclusion.headline);
  const assertSelected=async label=>{const state=await shown();assert.equal(state.status,nominalDecision.status,label+': badge must retain the selected-arrival verdict');assert.equal(state.hidden,false);assert.equal(state.assessmentStart,normalInputs.nominal,label+': assessment start cannot follow the view clock');assert.equal(state.title,normalBefore.title);assert.equal(state.explanation,normalBefore.explanation);assert.deepEqual(await saved(),normalPlan);return state;};
  await assertSelected('initial');
  await evaluate("document.querySelector('#hero-scope-stay').click()");
  const samples=normalSite.geometry.filter(row=>row[0]>=normalInputs.nominal&&row[0]<normalInputs.nominal+normalInputs.durationHours*3600);assert(samples.length>2);
  record.clockInspections=[];
  for(const index of [0,Math.floor(samples.length/2),samples.length-1]){await evaluate(`document.querySelector('#hero-time').value=${index};document.querySelector('#hero-time').dispatchEvent(new Event('input'))`);const state=await assertSelected('scrub '+index);assert.equal(state.clock,samples[index][0]);record.clockInspections.push({clock:state.clock,status:state.status,assessmentStart:state.assessmentStart});}
  await click('#hero-reset');await assertSelected('reset before Play');
  const beforePlay=(await shown()).clock;
  await evaluate("document.querySelector('#hero-speed').value='4';document.querySelector('#hero-speed').dispatchEvent(new Event('change'))");await click('#hero-play');
  await until(async()=>{const state=await shown();return state.clock!==beforePlay;},'actual clock playback');await click('#hero-pause');record.played=await assertSelected('Play/Pause');
  await click('#hero-reset');const reset=await assertSelected('final reset');assert.equal(reset.clock,samples[0][0]);

  // 2. Changing the actual arrival is a new evaluated mission and must update
  // that same badge through the existing authoritative evaluator.
  await evaluate("document.querySelector('#visual-arrival').value='2026-11-04T06:00';document.querySelector('#visual-arrival').dispatchEvent(new Event('change'))");
  const changedPlan=await saved(),changedInputs=fieldsToInputs(changedPlan),changedDecision=evaluateStart(bundle,changedInputs),changedSite=bundle.sites.find(site=>site.id===changedInputs.siteId);
  assert.equal(changedInputs.nominal,Date.parse('2026-11-04T06:00Z')/1000);assert.equal(changedPlan.delayStoryEnabled,false);assert.equal(changedDecision.status,'FAIL');
  const changed=await shown();assert.equal(changed.status,changedDecision.status);assert.equal(changed.hidden,false);assert.equal(changed.assessmentStart,changedInputs.nominal);assert.equal(changed.title,firstScreenConclusion(missionMetrics(changedDecision,changedSite),changedInputs.durationHours*3600).headline);
  for(const key of ['siteId','durationHours','maxSunHours','maxEarthHours','minJointHours','minContinuousJointHours'])assert.equal(changedInputs[key],normalInputs[key]);record.changedArrival={start:changedInputs.nominal,status:changed.status};

  // 3. The optional delay demo remains its independent real three-stage action
  // flow; opportunity search is not substituted for the simulation button.
  await click('#explore-site');await click('#delay-demo-load');const sequence=[];
  for(const[role,status]of [['nominal','PASS'],['delayed','FAIL'],['recommended','PASS']]){
    if(role==='delayed')assert.match(await evaluate("document.querySelector('#story-next').textContent"),/simulate.*72/i);
    if(role==='recommended')assert.match(await evaluate("document.querySelector('#story-next').textContent"),/find.*next|confirmed window/i);
    if(role!=='nominal')await click('#story-next');
    await until(async()=>{const state=await shown();return state.status===status&&await evaluate("!document.querySelector('#story-next').disabled");},role+' demo result');
    const state=await shown();sequence.push({role,status:state.status,start:Number(state.data.start),title:state.title});
  }
  const demo=communicationDemo(bundle);assert.equal(sequence[0].start,demo.nominal);assert.equal(sequence[1].start-demo.nominal,72*3600);assert.equal(sequence[2].start,Date.parse('2026-11-17T03:00Z')/1000);record.sequence=sequence;
  assert.deepEqual(record.exceptions,[]);record.status='PASS';console.log('Desktop selected-arrival/playback/demo smoke PASS');socket.close();socket=null;browser.kill();browser=null;
 }
 evidence.status='PASS';
}catch(error){evidence.status='FAIL';evidence.error=error.stack;throw error;}
finally{await writeFile(resolve(work,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');socket?.close();browser?.kill();server?.close();console.log('Playback-verdict evidence '+work);}
