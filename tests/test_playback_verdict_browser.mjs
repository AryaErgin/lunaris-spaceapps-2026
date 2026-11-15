// Focused original-plan versus hypothetical view-clock regression.
// Local static server by default. Optional anonymous public check:
// LUNARIS_PUBLIC_URL=https://.../ LUNARIS_EXPECTED_SHA=<40hex> node tests/test_playback_verdict_browser.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {evaluateStart} from '../web/engine.mjs';
import {communicationDemo} from '../web/overview.mjs';
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
const evidence={url,expectedSha,status:'RUNNING',viewports:[],limitations:['Mobile checks use desktop Chrome CSS viewport emulation, not physical devices.','Hypothetical arrival checks use the existing authoritative evaluateStart; they must not replace the inspected mission or exported selected plan.']};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=45000){const start=Date.now();while(Date.now()-start<timeout){const v=await fn();if(v)return v;await pause(60);}throw Error('Timed out: '+label);}
const utc=value=>Date.parse(value+'Z')/1000;
const fieldsToInputs=saved=>{const f=saved.fields,num=id=>f[id]===''?null:Number(f[id]);return{siteId:f.site,nominal:utc(f.nominal),durationHours:num('duration'),delayHours:num('delay'),maxSunHours:num('max-sun'),maxEarthHours:num('max-earth'),minJointHours:num('min-total'),minContinuousJointHours:num('min-continuous'),earliest:utc(f.earliest),latest:utc(f.latest),gridMinutes:num('grid'),mode:saved.prelaunch?'prelaunch':'same-site'};};
let browser,socket;
try{
 for(const viewport of [{width:1366,height:768},{width:1920,height:1080},{width:390,height:840},{width:320,height:840}]){
  const label=`${viewport.width}x${viewport.height}`,record={viewport,exceptions:[],assessments:[]};evidence.viewports.push(record);
  const profile=resolve(work,'chrome-'+label);browser=spawn(process.env.LUNARIS_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--remote-debugging-port=0','--no-first-run','--disable-extensions','--disable-background-networking',`--user-data-dir=${profile}`,'--use-angle=swiftshader','--enable-unsafe-swiftshader','about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  await until(async()=>{try{return(await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).length;}catch{return false;}},'Chrome startup');
  const port=(await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0],tabs=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
  socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await once(socket,'open');let next=0;const pending=new Map();
  socket.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.method==='Runtime.exceptionThrown')record.exceptions.push(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.no(Error(JSON.stringify(m.error))):p.ok(m.result);}});
  const command=(method,params={})=>new Promise((ok,no)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);no(Error('CDP timeout '+method));},60000);pending.set(id,{ok:v=>{clearTimeout(timer);ok(v);},no:e=>{clearTimeout(timer);no(e);}});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
  const saved=()=>evaluate(`import(${JSON.stringify(new URL('app.mjs',url).href)}).then(m=>m.captureOnboardingPlan())`);
  const screenshot=async name=>{const r=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(resolve(work,label+'-'+name+'.png'),Buffer.from(r.data,'base64'));};
  const click=async selector=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause(70);const p=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,clear:!n.disabled&&r.width>0&&r.top>=0&&r.bottom<=innerHeight&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);assert(p.clear,selector+' must be clickable without an obscuring element');await command('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});};
  const assessment=()=>evaluate("(()=>{const n=document.querySelector('#hero-landing-verdict');const r=n.getBoundingClientRect(),style=getComputedStyle(n);return{text:n.textContent.trim(),data:{...n.dataset},rect:r.toJSON(),rendered:r.width>0&&r.height>0&&style.display!=='none'&&style.visibility!=='hidden',clipped:n.scrollHeight>n.clientHeight+1,statusChips:[...n.querySelectorAll('.status')].map(s=>s.textContent.trim())}})()");
  const selectedCertificate=async name=>{const dir=resolve(work,label+'-'+name);await mkdir(dir,{recursive:true});await command('Page.setDownloadBehavior',{behavior:'allow',downloadPath:dir});await evaluate("document.querySelector('#export').click()");let file;await until(async()=>file=(await readdir(dir)).find(n=>n.endsWith('.json')),'downloaded decision record');return JSON.parse(await readFile(resolve(dir,file),'utf8'));};
  const scopeAll=()=>evaluate("document.querySelector('#time-scope').value='coverage';document.querySelector('#time-scope').dispatchEvent(new Event('change'))");
  const seek=async time=>{const plan=fieldsToInputs(await saved()),site=bundle.sites.find(s=>s.id===plan.siteId),index=site.geometry.findIndex(r=>r[0]===time);assert(index>=0,'seek requires a genuine cached row');await evaluate(`document.querySelector('#hero-time').value=${index};document.querySelector('#hero-time').dispatchEvent(new Event('input'))`);await until(()=>evaluate(`Number(document.querySelector('#scene-mount').dataset.time)===${time}`),'shared UTC seek');};
  const assertLive=async(name,inputs,time)=>{const expected=evaluateStart(bundle,inputs,inputs.siteId,time),actual=await assessment();assert(actual.rendered&&!actual.clipped,name+': live card must be rendered with all text, including mobile.');assert.equal(actual.data.status,expected.status,name+': hypothetical decision must equal the full original evaluator');assert.equal(Number(actual.data.start),time);assert.equal(actual.data.site,inputs.siteId);assert.match(actual.text,/view|clock|landing/i);record.assessments.push({name,time,status:expected.status,actual});return expected;};
  await command('Runtime.enable');await command('Page.enable');await command('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:false});await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await command('Page.bringToFront');await command('Page.navigate',{url});
  await until(()=>evaluate("!!document.querySelector('#export:not([disabled])')"),'actual data ready');await until(()=>evaluate("!!document.querySelector('#quick-tour')"),'first-visit offer');await evaluate("document.querySelector('.quick-tour-close').click()");
  // This fails on the partial HTML-only implementation: the panel is empty.
  assert((await assessment()).text.length>0,'View-clock assessment must be populated on first load, including environment-only mode.');
  assert.equal(await evaluate("!!document.querySelector('#delay-shortcut')"),false,'Duplicate header delay shortcut must be removed.');
  assert(await evaluate("!!document.querySelector('#tour-start')"),'Show me how remains available.');
  assert.match(await evaluate("document.querySelector('#explore-site').textContent"),/Try a 72.hour delay/i);
  assert.equal((await assessment()).data.status,'NOT_APPLIED');assert(!(await assessment()).statusChips.some(s=>/^(PASS|FAIL)$/.test(s)),'Environment-only mode cannot emit requirement PASS/FAIL chips.');

  // A real custom mission must survive cancelling the clearly offered preset.
  await evaluate("document.querySelector('#visual-site').value='peak-near-shackleton';document.querySelector('#visual-site').dispatchEvent(new Event('change'));document.querySelector('#visual-arrival').value='2027-07-01T06:00';document.querySelector('#visual-duration').value='24';document.querySelector('#visual-duration').dispatchEvent(new Event('change'))");
  await until(()=>evaluate("!document.querySelector('#export').disabled"),'custom arrival');
  await click('#mission-options > summary');await click('#mission-requirements-editor > summary');
  await evaluate("for(const[id,v]of [['quick-max-sun','3'],['quick-max-earth','1'],['quick-min-total','2'],['quick-min-continuous','1']])document.getElementById(id).value=v");await click('#apply-quick-requirements');
  const custom=await saved(),customInputs=fieldsToInputs(custom),customExpected=evaluateStart(bundle,customInputs);
  assert.equal(await evaluate("document.querySelector('#story-status').textContent"),customExpected.status,'Prominent original-plan verdict must reflect custom applied requirements.');
  await click('#explore-site');
  assert(await evaluate("document.querySelector('#delay-demo-confirm').open"),'Delay preset must be offered through a real dialog.');
  assert.match(await evaluate("document.querySelector('#delay-demo-confirm').textContent"),/replace|load|preset|example/i);
  assert.deepEqual(await saved(),custom,'Opening consent must not replace the custom mission.');await screenshot('demo-consent');
  await click('#delay-demo-cancel');assert.deepEqual(await saved(),custom,'Cancel must preserve every input and the inspected plan.');
  await click('#explore-site');await click('#delay-demo-load');
  await until(()=>evaluate("document.querySelector('#story-status').textContent==='PASS'"),'verified initial PASS');
  const nominal=await saved(),inputs=fieldsToInputs(nominal),originalMission=evaluateStart(bundle,inputs),before=await selectedCertificate('original-record');
  assert.deepEqual(inputs,communicationDemo(bundle),'Explicit demo load must preserve the verified original preset.');
  assert.deepEqual(before.selected_plan,originalMission);assert.equal(before.application_release_sha,expectedSha);
  await evaluate('scrollTo(0,0)');await screenshot('main-pass');await evaluate("document.querySelector('#mission-story').scrollIntoView({block:'center',behavior:'instant'})");await screenshot('main-pass-centered');
  await assertLive('nominal clock',inputs,inputs.nominal);
  await scopeAll();const failedTime=inputs.nominal+72*3600;await seek(failedTime);
  const hypothetical=await assertLive('72h hypothetical clock',inputs,failedTime);assert.equal(hypothetical.status,'FAIL');await evaluate("document.querySelector('#hero-landing-verdict').scrollIntoView({block:'center',behavior:'instant'})");await screenshot('live-fail-original-pass');
  assert.equal(await evaluate("document.querySelector('#story-status').textContent"),'PASS','Scrubbing cannot rewrite the original nominal verdict.');
  assert.deepEqual(await saved(),nominal,'Scrubbing must not change mission inputs, constraints, role or certificate identity.');
  const after=await selectedCertificate('scrubbed-original-record');assert.deepEqual(after.inputs,before.inputs);assert.deepEqual(after.selected_plan,before.selected_plan);assert.equal(after.selected_role,before.selected_role);
  await evaluate("document.querySelector('#hero-speed').value='48';document.querySelector('#hero-speed').dispatchEvent(new Event('change'))");
  const timeBeforePlay=Number(await evaluate("document.querySelector('#scene-mount').dataset.time"));await click('#hero-play');await pause(350);await click('#hero-pause');
  const timeAfterPlay=Number(await evaluate("document.querySelector('#scene-mount').dataset.time"));assert(timeAfterPlay>timeBeforePlay,'Play must visibly advance genuine cached times.');
  await assertLive('played clock',inputs,timeAfterPlay);assert.deepEqual(await saved(),nominal);
  const jumpTime=Date.parse('2026-11-17T03:00Z')/1000;
  await evaluate("document.querySelector('#sky-jump').value='2026-11-17T03:00';document.querySelector('#sky-jump-go').click()");await assertLive('UTC jump',inputs,jumpTime);assert.deepEqual(await saved(),nominal);
  const states=[];
  for(const role of ['delayed','recommended']){await click('#story-next');await until(()=>evaluate(`!document.querySelector('#story-next').disabled&&document.querySelector('#story-status').textContent===${JSON.stringify(role==='delayed'?'FAIL':'PASS')}`),'actual '+role+' decision');const card=await evaluate(`(()=>{const n=document.querySelector('[data-decision="${role}"]');return{start:Number(n.dataset.start),status:n.querySelector('.decision-status').textContent}})()`);states.push(card);if(role==='delayed'){await evaluate('scrollTo(0,0)');await screenshot('main-fail');await evaluate("document.querySelector('#mission-story').scrollIntoView({block:'center',behavior:'instant'})");await screenshot('main-fail-centered');}}
  assert.equal(states[0].start-inputs.nominal,72*3600);assert.equal(states[1].start,jumpTime);assert.deepEqual(states.map(s=>s.status),['FAIL','PASS']);record.demo=states;

  // A dirty raw engineering input must never regain the old PASS through
  // chart resize or an analysis-panel redraw before explicit evaluation.
  await evaluate("document.querySelector('#min-total').value='13';document.querySelector('#min-total').dispatchEvent(new Event('input',{bubbles:true}))");
  let dirty=await assessment();assert.equal(dirty.data.status,'INDETERMINATE');assert.match(dirty.text,/inputs changed|apply your changes/i);
  await evaluate("document.querySelector('#product-analyst').click();document.querySelector('#analysis-tools').open=false");await pause(60);
  await evaluate("document.querySelector('#analysis-tools').open=true");await pause(100);
  dirty=await assessment();assert.equal(dirty.data.status,'INDETERMINATE','Opening old analysis must not restore a cached PASS.');assert.match(dirty.text,/inputs changed|apply your changes/i);
  const plotBefore=await evaluate("document.querySelector('#plot').clientWidth");
  await command('Emulation.setDeviceMetricsOverride',{width:viewport.width<=740?viewport.width+37:1024,height:viewport.height,deviceScaleFactor:1,mobile:false});await pause(180);
  const plotAfter=await evaluate("document.querySelector('#plot').clientWidth");assert.notEqual(plotAfter,plotBefore,'Dirty-input resize fixture must actually change the observed chart width.');
  dirty=await assessment();assert.equal(dirty.data.status,'INDETERMINATE','ResizeObserver must not restore a stale verdict.');assert.match(dirty.text,/inputs changed|apply your changes/i);assert(await evaluate("document.querySelector('#export').disabled"),'Dirty evidence cannot be exported as current.');
  record.dirtyRedraw={plotBefore,plotAfter,status:dirty.data.status,reason:dirty.text};
  await command('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:false});await pause(120);
  dirty=await assessment();assert.equal(dirty.data.status,'INDETERMINATE');
  await evaluate("document.querySelector('#mission-form').requestSubmit();document.querySelector('#product-explore').click()");
  const appliedDirty=await saved(),appliedDirtyInputs=fieldsToInputs(appliedDirty),appliedDirtyTime=Number(await evaluate("document.querySelector('#scene-mount').dataset.time"));assert.equal(appliedDirtyInputs.minJointHours,13);
  await assertLive('explicitly applied dirty requirement',appliedDirtyInputs,appliedDirtyTime);assert.equal((await assessment()).data.status,'FAIL');

  // Remove requirements through the actual control, then change site and limits.
  await evaluate("document.querySelector('#apply-requirements').checked=false;document.querySelector('#apply-requirements').dispatchEvent(new Event('change'))");
  assert.equal((await assessment()).data.status,'NOT_APPLIED');assert(!(await assessment()).statusChips.some(s=>/^(PASS|FAIL)$/.test(s)),'Requirements-off cannot retain an old PASS or FAIL badge.');
  await evaluate("document.querySelector('#visual-site').value='connecting-ridge';document.querySelector('#visual-site').dispatchEvent(new Event('change'))");
  assert.equal((await assessment()).data.site,'connecting-ridge','Changing location cannot retain another location assessment.');
  await evaluate("document.querySelector('#apply-requirements').checked=true;document.querySelector('#apply-requirements').dispatchEvent(new Event('change'))");
  let changed=await saved(),changedInputs=fieldsToInputs(changed),current=Number(await evaluate("document.querySelector('#scene-mount').dataset.time"));await assertLive('changed site',changedInputs,current);
  await evaluate("document.querySelector('#quick-max-sun').value='0';document.querySelector('#apply-quick-requirements').click()");changed=await saved();changedInputs=fieldsToInputs(changed);current=Number(await evaluate("document.querySelector('#scene-mount').dataset.time"));await assertLive('changed limit',changedInputs,current);

  // Explicit bounds distinguish schedule exclusion from lunar conditions.
  await evaluate("document.querySelector('#product-analyst').click();document.querySelector('#analysis-tools').open=true;for(const[id,value]of [['earliest','2026-11-20T00:00'],['latest','2026-11-25T00:00']]){const n=document.getElementById(id);n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('#mission-form').requestSubmit();document.querySelector('#product-explore').click()");
  changed=await saved();changedInputs=fieldsToInputs(changed);await scopeAll();await seek(failedTime);const excluded=await assertLive('schedule excluded',changedInputs,failedTime);assert.equal(excluded.startAllowed,false);assert.match((await assessment()).text,/schedule|allowed|excluded/i);
  // A covered schedule with no ephemeris evidence must remain INDETERMINATE.
  await evaluate("document.querySelector('#product-analyst').click();document.querySelector('#analysis-tools').open=true;for(const[id,value]of [['nominal','2028-01-02T00:00'],['earliest','2028-01-01T00:00'],['latest','2028-01-03T00:00']]){const n=document.getElementById(id);n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('#mission-form').requestSubmit();document.querySelector('#product-explore').click()");
  await evaluate("document.querySelector('#time-scope').value='mission';document.querySelector('#time-scope').dispatchEvent(new Event('change'))");
  changed=await saved();assert.equal(evaluateStart(bundle,fieldsToInputs(changed)).status,'INDETERMINATE');assert.equal((await assessment()).data.status,'INDETERMINATE');assert.match((await assessment()).text,/coverage|data|cached|uncertain|unavailable/i);
  assert(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),'No horizontal overflow, including scrollbar gutters.');
  assert.deepEqual(record.exceptions,[],'No uncaught JavaScript exceptions.');record.status='PASS';console.log(label+': original identity, live verdict, consent, playback and recovery PASS');
  socket.close();socket=null;browser.kill();browser=null;
 }
 evidence.status='PASS';
}catch(error){evidence.status='FAIL';evidence.error=error.stack;throw error;}
finally{await writeFile(resolve(work,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');socket?.close();browser?.kill();server?.close();console.log('Playback-verdict evidence '+work);}
