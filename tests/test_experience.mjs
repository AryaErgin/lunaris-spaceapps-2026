import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {bodyDirection,sceneFrame} from '../web/scene-model.mjs';
import {runMission} from '../web/engine.mjs';
import {communicationDemo} from '../web/overview.mjs';

const root=process.cwd(),work=resolve(root,'progress',`experience-${Date.now()}`);
const bundle=JSON.parse(await readFile(resolve(root,'web/data/bundle.json'),'utf8'));
await mkdir(work,{recursive:true});
const types={'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.jpg':'image/jpeg','.png':'image/png'};
const server=createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const path=resolve(root,`.${pathname.endsWith('/')?pathname+'index.html':pathname}`);
  if(!path.startsWith(root+sep))return res.writeHead(403).end();
  try{res.setHeader('Content-Type',types[extname(path)]??'application/octet-stream');res.end(await readFile(path));}
  catch{res.writeHead(404).end();}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`,url=origin+'/web/';
const executable=process.env.LUNARIS_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile=resolve(work,'chrome-profile');
const browser=spawn(executable,['--headless=new',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--no-first-run',
  '--disable-extensions','--disable-background-networking','--use-angle=swiftshader','--enable-unsafe-swiftshader','about:blank'],{stdio:['ignore','ignore','pipe']});
let browserLog='';browser.stderr.on('data',chunk=>{browserLog=(browserLog+chunk).slice(-2000);});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,attempts=160){for(let i=0;i<attempts;i++){const value=await fn().catch(()=>null);if(value)return value;await sleep(100);}throw Error('Browser prerequisite timeout: '+browserLog);}
let socket;
try{
  const port=(await until(()=>readFile(resolve(profile,'DevToolsActivePort'),'utf8'))).split(/\r?\n/)[0];
  const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await once(socket,'open');
  let id=0;const pending=new Map(),requests=[],exceptions=[];
  socket.addEventListener('message',({data})=>{const m=JSON.parse(data);
    if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);
    if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text);
    if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}
  });
  const command=(method,params={})=>new Promise((resolveCommand,reject)=>{const key=++id;
    const timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout '+method));},30000);
    pending.set(key,m=>{clearTimeout(timer);m.error?reject(Error(JSON.stringify(m.error))):resolveCommand(m.result);});socket.send(JSON.stringify({id:key,method,params}));});
  const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
  const inspect=()=>evaluate("import('/web/app.mjs').then(m=>m.inspectExperience())");
  const screenshot=async name=>{const r=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(resolve(work,name+'.png'),Buffer.from(r.data,'base64'));};
  const download=async(label,action)=>{
    const folder=resolve(work,label);await mkdir(folder,{recursive:true});await command('Page.setDownloadBehavior',{behavior:'allow',downloadPath:folder});
    await evaluate(action??"document.querySelector('#export').click()");
    const name=await until(async()=>(await readdir(folder)).find(n=>n.endsWith('.json')));
    return JSON.parse(await readFile(resolve(folder,name),'utf8'));
  };
  const checkCertificate=(record,plan,role,index=null)=>{
    assert.equal(record.selected_role,role);assert.equal(record.selected_alternative_index,index);
    assert.deepEqual(record.selected_plan,plan);assert.equal(record.site_id,plan.siteId);
    assert.equal(Date.parse(record.mission_start_utc)/1000,plan.start);assert.equal(Date.parse(record.mission_end_utc)/1000,plan.end);
    assert.equal(record.status,plan.status);assert.deepEqual(record.constraints,plan.constraints);
    assert.deepEqual(record.inspected_mission,{role,alternativeIndex:index,siteId:plan.siteId,start:plan.start,end:plan.end,status:plan.status});
  };
  const desktop={width:1366,height:768,deviceScaleFactor:1,mobile:false};
  await command('Network.enable');await command('Runtime.enable');await command('Page.enable');await command('Performance.enable');await command('Emulation.setDeviceMetricsOverride',desktop);
  await command('Page.navigate',{url});
  await until(async()=>Boolean((await inspect())?.moon.textured));
  await until(async()=>(await inspect()).renderedFrames>0);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.main-nav button')].map(n=>n.textContent)"),['Mission','Compare','Advanced']);
  assert(await evaluate("getComputedStyle(document.querySelector('#scene-poster')).display==='none'"),'Loaded GPU scene must remove the Moon poster, including in surface mode.');
  let info=await inspect();assert.equal(info.mode,'orbital');assert(info.moon.vertices>10000);
  const performanceEvidence={softwareGpu:true,initialTexturedSceneObservedMs:await evaluate('performance.now()'),
    resources:await evaluate("performance.getEntriesByType('resource').map(r=>({name:r.name.split('/').pop(),bytes:r.transferSize,durationMs:r.duration}))")};
  assert(await evaluate("document.querySelector('#top').hidden"),'Opening experience must not show the engineering form wall.');
  assert(await evaluate("(()=>{const canvas=document.querySelector('#scene-mount').getBoundingClientRect();return document.querySelector('.experience-intro').getBoundingClientRect().right<=canvas.left&&document.querySelector('.scene-mode-switch').getBoundingClientRect().bottom<=canvas.top+1})()"),'Desktop orbital copy and controls must sit outside the canvas.');
  assert(!requests.some(r=>/earth-color|terrain-.*\.bin/.test(r)),'Earth and surface meshes must load lazily.');
  for(const [width,height] of [[1024,768],[1440,900]]){
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    assert(await evaluate("(()=>{const n=document.querySelector('#story-next'),r=n.getBoundingClientRect();return r.bottom<=innerHeight&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('#story-next')===n&&document.documentElement.scrollWidth<=innerWidth})()"),`The mission action must remain usable at ${width}x${height}.`);
    await screenshot('orbital-'+width);
  }
  await command('Emulation.setDeviceMetricsOverride',desktop);
  await evaluate("document.querySelector('#moon-hd').click()");
  await until(async()=>(await inspect()).moon.detail==='high');
  assert((await inspect()).moon.textured,'The explicit 4K asset must become the live GPU Moon texture.');
  await screenshot('orbital-desktop');
  assert(await evaluate("(()=>{const result=document.querySelector('#story-status').getBoundingClientRect(),action=document.querySelector('#story-next').getBoundingClientRect();return result.top>=0&&result.bottom<=innerHeight&&action.bottom<=innerHeight})()"),'Mission outcome and primary action must be visible without scrolling at1366x768.');
  assert(await evaluate("(()=>{const n=document.querySelector('#story-next'),r=n.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('#story-next')===n})()"),'Primary action must not be overlapped by a site/date control.');
  assert.equal(await evaluate("document.querySelector('#story-status').textContent"),'PASS');
  const evidenceRows=()=>evaluate("[...document.querySelectorAll('#decision-requirements [data-constraint]')].map(n=>({id:n.dataset.constraint,threshold:Number(n.dataset.threshold),metric:Number(n.dataset.metric),margin:Number(n.dataset.margin),range:JSON.parse(n.dataset.range),marginRange:JSON.parse(n.dataset.marginRange),status:n.dataset.status}))");
  const checkEvidence=async mission=>assert.deepEqual(await evidenceRows(),mission.constraints.map(({id,threshold,metric,margin,range,marginRange,status})=>({id,threshold,metric,margin,range,marginRange,status})));
  const evidenceExpected=runMission(bundle,communicationDemo(bundle));
  await checkEvidence(evidenceExpected.nominal);
  assert(await evaluate("!document.querySelector('#decision-evidence').closest('details')&&document.querySelector('#top').hidden"),'All requirements must be presented outside Advanced and collapsed details.');
  assert.match(await evaluate("document.querySelector('#decision-evidence').textContent"),/Illustrative mission requirements.*not.*lander specifications/s);
  assert.match(await evaluate("document.querySelector('#story-joint').textContent"),/7 h 53 min 52 s/);
  await evaluate("window.observedRescueTimes=[];new MutationObserver(()=>window.observedRescueTimes.push(document.querySelector('#scene-clock').textContent)).observe(document.querySelector('#scene-clock'),{childList:true,subtree:true,characterData:true});document.querySelector('#story-next').click()");
  const delayStarted=Date.now();
  await until(()=>evaluate("document.querySelector('#story-status').textContent==='FAIL'&&document.querySelector('#rescue-transition').hidden"));
  assert(await evaluate("new Set(window.observedRescueTimes).size>10"),'Delay action must visibly advance the shared clock through actual cached samples.');
  assert.equal((await inspect()).mode,'surface');assert.equal((await inspect()).sun.visible,false);
  performanceEvidence.delayActionMs=Date.now()-delayStarted;
  performanceEvidence.distinctDelayClockSamples=await evaluate('new Set(window.observedRescueTimes).size');
  performanceEvidence.surface=await inspect();
  performanceEvidence.browserMetrics=(await command('Performance.getMetrics')).metrics;
  await sleep(500);await screenshot('delayed-desktop');
  assert.match(await evaluate("document.querySelector('#story-explanation').textContent"),/12 hours.*7 hours.*5 hours too long/);
  await checkEvidence(evidenceExpected.delayed);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#decision-timeline .constraint-highlight')].map(n=>[n.dataset.channel,Number(n.dataset.start),Number(n.dataset.end)])"),[['sun',evidenceExpected.delayed.start,evidenceExpected.delayed.end]]);
  await evaluate("document.querySelector('#decision-requirements [data-constraint=max_earth_block] button').click()");
  assert.match(await evaluate("document.querySelector('#evidence-focus-label').textContent"),/possible|unresolved/i);
  await evaluate("document.querySelector('#decision-requirements [data-constraint=min_joint_total] button').click()");
  assert.equal(await evaluate("document.querySelectorAll('#decision-timeline .constraint-highlight').length"),0,'Zero joint time must not fabricate a witness interval.');
  await evaluate("document.querySelector('#decision-requirements [data-constraint=max_sun_block] button').click()");
  await evaluate("document.querySelector('#story-next').click()");
  await until(()=>evaluate("document.querySelector('#story-status').textContent==='PASS'&&document.querySelector('#story-date').textContent.includes('17 Nov')"));
  await until(()=>evaluate("document.querySelector('#configuration-summary').textContent.includes('7 of 7')"));
  assert.match(await evaluate("document.querySelector('#story-joint').textContent"),/12 d 21 h/);
  await checkEvidence(evidenceExpected.recommended);
  assert.match(await evaluate("document.querySelector('#recovery-choice').textContent"),/60.minute.*240.*69/s);
  await evaluate("scrollTo({top:document.querySelector('#decision-evidence').getBoundingClientRect().top+scrollY,behavior:'instant'})");await screenshot('recovery-requirements-desktop');await evaluate("scrollTo({top:0,behavior:'instant'})");
  await sleep(500);await screenshot('recovered-desktop');
  assert(await evaluate("(()=>{const a=document.querySelector('.recovery-wait').getBoundingClientRect(),b=document.querySelector('.scene-site-picker').getBoundingClientRect();return a.bottom<=b.top&&a.bottom<=innerHeight})()"),'Recovery cost must be visible above the site controls.');
  const expected=runMission(bundle,communicationDemo(bundle));
  const recoveryRecord=await download('recovery-switch-race',"document.querySelector('#export').click();document.querySelector('#story-delayed').click()");
  checkCertificate(recoveryRecord,expected.recommended,'recommended');
  assert.equal(recoveryRecord.one_factor_configurations.pass_count,7,'A rapid selection must retain the evidence present at export click.');
  for(const role of ['nominal','delayed','recommended']){
    await evaluate(`document.querySelector('[data-story="${role}"]').click()`);
    checkCertificate(await download('certificate-'+role),expected[role],role);
  }
  const sharedBefore=await evaluate("[...document.querySelectorAll('#mission-form input,#mission-form select')].map(n=>[n.id,n.value,n.checked])");
  const timeBeforeModes=(await inspect()).time;
  for(const mode of ['compare','analyst','explore'])await evaluate(`document.querySelector('#product-${mode}').click()`);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#mission-form input,#mission-form select')].map(n=>[n.id,n.value,n.checked])"),sharedBefore);
  assert.equal((await inspect()).time,timeBeforeModes);
  await evaluate("document.querySelector('#product-compare').click()");
  assert.equal(await evaluate("document.querySelectorAll('#option-comparison [data-option]').length"),2);
  const optionA=await evaluate("document.querySelector('#comparison-arrival-A').value");
  await evaluate("document.querySelector('#comparison-duration').value=6;document.querySelector('#comparison-duration').dispatchEvent(new Event('change'))");
  assert(await evaluate("[...document.querySelectorAll('#option-comparison [data-option]')].every(n=>Number(n.dataset.end)-Number(n.dataset.start)===21600)"),'Both options must use the same edited duration.');
  assert.equal(await evaluate("document.querySelector('#comparison-arrival-A').value"),optionA);
  await evaluate("document.querySelector('#comparison-duration').value=12;document.querySelector('#comparison-duration').dispatchEvent(new Event('change'))");
  await evaluate("document.querySelector('#comparison-site-B').value='shackleton-rim';document.querySelector('#comparison-site-B').dispatchEvent(new Event('change'));document.querySelector('#comparison-arrival-B').value='2026-11-20T06:00';document.querySelector('#comparison-arrival-B').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("document.querySelector('#comparison-arrival-A').value"),optionA,'Editing B must preserve A.');
  assert.equal((await inspect()).siteId,'de-gerlache-rim','Comparison edits must not silently change the active scene.');
  await evaluate("document.querySelector('#add-comparison-option').click()");
  assert.equal(await evaluate("document.querySelectorAll('#option-comparison [data-option]').length"),3);
  await evaluate("document.querySelector('#remove-comparison-option').click()");
  assert.equal(await evaluate("document.querySelectorAll('#option-comparison [data-option]').length"),2);
  assert.equal(await evaluate("document.querySelectorAll('#site-comparison article').length"),3);
  assert.equal(await evaluate("document.querySelectorAll('.feasibility-cell').length"),90);
  assert.equal(await evaluate("document.querySelectorAll('#site-comparison .compact-requirements [data-constraint]').length"),24,'Every original/delayed compared site must show the same four rules.');
  assert(await evaluate("[...document.querySelectorAll('#option-comparison>article')].every(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})"),'Independent comparison cards must be visible without horizontal clipping.');
  await screenshot('compare-desktop');
  await evaluate("document.querySelector('#comparison-view-B').click()");
  assert.equal((await inspect()).siteId,bundle.sites[1].id);
  const optionInputs={...communicationDemo(bundle),siteId:'shackleton-rim',nominal:Date.parse('2026-11-20T06:00Z')/1000};
  checkCertificate(await download('view-comparison-option'),runMission(bundle,optionInputs).nominal,'nominal');
  await evaluate("document.querySelector('#product-compare').click()");
  assert.equal(await evaluate("document.querySelector('#comparison-arrival-A').value"),optionA);
  await evaluate("document.querySelector('#product-explore').click()");
  await evaluate("document.querySelector('#visual-arrival').value='2026-11-20T06:00:00';document.querySelector('#visual-date-go').click()");
  assert.equal((await inspect()).time,Date.parse('2026-11-20T06:00:00Z')/1000);
  const validTime=(await inspect()).time;
  await evaluate("document.querySelector('#visual-arrival').value='';document.querySelector('#visual-date-go').click()");
  assert.equal((await inspect()).time,validTime);
  assert.match(await evaluate("document.querySelector('#workspace-notice').textContent"),/Arrival not changed/);
  await evaluate("document.querySelector('#visual-arrival').value='2026-11-20T06:00:00';document.querySelector('#visual-date-go').click()");
  await evaluate("document.querySelector('#verified-demo').click();document.querySelector('#mode-orbital').click()");
  await evaluate("document.querySelector('#hero-play').click()");
  await until(async()=>(await inspect()).mode==='surface');
  await until(async()=>(await inspect()).time>expected.nominal.start);
  await evaluate("document.querySelector('#hero-pause').click();document.querySelector('#story-nominal').click();document.querySelector('#mode-orbital').click()");
  const initialCamera=info.camera.position;
  await evaluate("document.querySelector('#scene-mount canvas').focus()");
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await until(async()=>JSON.stringify((await inspect()).camera.position)!==JSON.stringify(initialCamera));
  await evaluate("document.querySelector('#reset-orbit').click()");
  await until(async()=>{const camera=(await inspect()).camera;return camera.position.every((v,i)=>Math.abs(v-camera.overviewPosition[i])<1e-5);});
  await evaluate("document.querySelector('#explore-site').click()");
  await until(async()=>{const i=await inspect();return i?.mode==='surface'&&i.terrain.loaded&&i.earth.textured;});
  info=await inspect();assert.equal(info.camera.position[1],2);assert(info.terrain.vertexCount>50000);assert(info.terrain.indexCount>300000);
  const currentSite=bundle.sites.find(s=>s.id===info.siteId),sample=currentSite.geometry.find(r=>r[0]===info.time);
  await evaluate("document.querySelector('#focus-terrain').click()");await screenshot('surface-terrain-desktop');
  const frame=sceneFrame(currentSite,sample,bundle.coverage);
  for(const [key,az,el] of [['sun',1,2],['earth',4,5]]){
    assert.equal(info[key].visible,frame.states[key]==='visible');
    assert.deepEqual(info[key].direction,bodyDirection(sample[az],sample[el]));
  }
  await evaluate("document.querySelector('#focus-earth').click()");await until(async()=>(await inspect()).camera.fov===10);
  assert(Math.abs((await inspect()).earth.angularDiameterDeg-1.9)<.001);
  await screenshot('surface-earth-desktop');
  const storyStates=[];
  for(const phase of ['nominal','delayed','recommended']){
    await evaluate(`document.querySelector('[data-story="${phase}"]').click()`);
    storyStates.push(await evaluate("document.querySelector('#story-status').textContent"));
    info=await inspect();const s=bundle.sites.find(s=>s.id===info.siteId),r=s.geometry.find(r=>r[0]===info.time),f=sceneFrame(s,r,bundle.coverage);
    assert.equal(info.sun.visible,f.states.sun==='visible');assert.equal(info.earth.visible,f.states.earth==='visible');
    if(phase==='delayed'){assert.equal(info.sun.visible,false);assert.match(await evaluate("document.querySelector('#story-witness').textContent"),/04 Nov.*06:00.*04 Nov.*18:00/);}
  }
  assert.deepEqual(storyStates,['PASS','FAIL','PASS']);
  await evaluate("document.querySelector('#solar-demo').click();document.querySelector('#prelaunch').checked=true;document.querySelector('#evaluate').click()");
  const cross=runMission(bundle,{...bundle.demo,mode:'prelaunch'}),crossIndex=cross.alternatives.findIndex(p=>p.siteId!==bundle.demo.siteId);
  assert(crossIndex>=0);
  await evaluate(`document.querySelector('#alternatives-list [data-decision="${crossIndex}"]').click()`);
  checkCertificate(await download('certificate-cross-site'),cross.alternatives[crossIndex],'alternative',crossIndex);
  await evaluate("document.querySelector('#verified-demo').click();document.querySelector('#product-explore').click()");
  const otherAlternative=await evaluate("document.querySelector('#alternatives-list [data-decision=\"1\"]')!==null");
  if(otherAlternative){
    await evaluate("document.querySelector('#alternatives-list [data-decision=\"1\"]').click()");
    assert.equal(await evaluate("document.querySelector('#mission-story').dataset.start"),await evaluate("document.querySelector('#scene-mount').dataset.missionStart"));
    assert.equal(await evaluate("document.querySelector('#mission-story').dataset.site"),(await inspect()).siteId);
  }
  await evaluate("document.querySelector('#story-nominal').click();document.querySelector('#hero-speed').value=12;document.querySelector('#hero-speed').dispatchEvent(new Event('change'));document.querySelector('#hero-play').click()");
  const before=await inspect();await until(async()=>(await inspect()).time>before.time);
  await evaluate("document.querySelector('#hero-pause').click()");const paused=(await inspect()).time;await sleep(200);assert.equal((await inspect()).time,paused);
  // Verify actual GPU object visibility on every model state represented in the real cache.
  for(const site of bundle.sites){
    await evaluate(`document.querySelector('#visual-site').value='${site.id}';document.querySelector('#visual-site').dispatchEvent(new Event('change'))`);
    await until(async()=>{const i=await inspect();return i.terrain.siteId===site.id&&i.terrain.loaded;});
    await evaluate("document.querySelector('#focus-terrain').click()");await screenshot(`terrain-${site.id}`);
    await evaluate("document.querySelector('#time-scope').value='coverage';document.querySelector('#time-scope').dispatchEvent(new Event('change'))");
    for(const key of ['sun','earth'])for(const state of ['visible','blocked','uncertain']){
      const index=site.geometry.findIndex(row=>row[0]<bundle.coverage[1]&&sceneFrame(site,row,bundle.coverage).states[key]===state);
      if(index<0)continue;
      await evaluate(`document.querySelector('#hero-time').value=${index};document.querySelector('#hero-time').dispatchEvent(new Event('input'))`);
      info=await inspect();assert.equal(info[key].state,state);assert.equal(info[key].visible,state==='visible',`${site.id} ${key} ${state}`);
    }
  }
  await evaluate("document.querySelector('#nominal').value='2026-12-02T00:00:00';document.querySelector('#latest').value='2026-12-10T00:00:00';document.querySelector('#time-scope').value='mission';document.querySelector('#evaluate').click()");
  info=await inspect();assert.equal(info.sun.visible,false);assert.equal(info.earth.visible,false);
  assert(await evaluate("document.querySelector('#hero-play').disabled"));
  await evaluate("document.querySelector('#verified-demo').click()");
  await until(async()=>{const i=await inspect();return i.mode==='surface'&&i.terrain.siteId===bundle.demo.siteId;});
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:840,deviceScaleFactor:1,mobile:false});
  await evaluate("document.querySelector('#product-compare').click()");
  assert(await evaluate("[...document.querySelectorAll('#option-comparison>article')].every(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})"),'Mobile comparison options must stack without clipping.');
  await screenshot('compare-mobile');
  await evaluate("document.querySelector('#product-explore').click()");
  await evaluate("document.querySelector('#focus-earth').click();scrollTo(0,0)");await screenshot('surface-mobile');
  assert.match(await evaluate("document.querySelector('#experience-title').innerText"),/your landing/);
  assert(await evaluate("(()=>{const a=document.querySelector('.mission-scene-caption').getBoundingClientRect(),b=document.querySelector('.mission-scene-body-status').getBoundingClientRect();return a.bottom<=b.top||a.right<=b.left})()"),'Mobile site and body captions must not overlap.');
  await evaluate("document.querySelector('#focus-terrain').click()");await screenshot('surface-terrain-mobile');
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
  await evaluate("document.querySelector('#mode-orbital').click()");await until(async()=>(await inspect()).mode==='orbital');await screenshot('orbital-mobile');
  await evaluate("document.querySelector('#reset-orbit').click()");
  await until(async()=>{const camera=(await inspect()).camera;return camera.position.every((v,i)=>Math.abs(v-camera.overviewPosition[i])<1e-5);});
  await evaluate('scrollTo(0,0)');await screenshot('orbital-layout-mobile');
  assert(await evaluate("document.querySelector('.scene-mode-switch').getBoundingClientRect().bottom<=document.querySelector('#scene-mount').getBoundingClientRect().top+1"),'Mobile controls must stack above the Moon canvas.');
  assert(await evaluate("document.querySelector('#story-next').getBoundingClientRect().bottom<=innerHeight"),'Mobile mission and primary action must appear before advanced analysis.');
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert(await evaluate("getComputedStyle(document.querySelector('.scene-poster')).transitionDuration==='0s'"));
  await evaluate("document.querySelector('#scene-mount canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()");
  await until(()=>evaluate("document.querySelector('#scene-mount').dataset.webgl==='lost'"));
  assert(await evaluate("!document.querySelector('#top').hidden"));assert.equal((await inspect()).earth.visible,false);assert.equal((await inspect()).sun.visible,false);
  assert.match(await evaluate("document.querySelector('#scene-status').textContent"),/2D planner/);
  await evaluate("document.querySelector('#hero-time').value=Number(document.querySelector('#hero-time').value)+1;document.querySelector('#hero-time').dispatchEvent(new Event('input'))");
  await sleep(150);assert.equal((await inspect()).earth.visible,false);assert.equal((await inspect()).sun.visible,false);
  assert.equal(await evaluate("document.querySelector('#experience').dataset.ready"),'false');
  assert.deepEqual(requests.filter(r=>r.startsWith('http')&&!r.startsWith(origin+'/')),[]);
  assert.deepEqual(exceptions,[]);
  // Cold load with WebGL blocked must expose an operable 2D fallback.
  await command('Page.addScriptToEvaluateOnNewDocument',{source:"const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /webgl/i.test(type)?null:original.call(this,type,...args)}"});
  await command('Page.navigate',{url});
  await until(()=>evaluate("document.querySelector('#scene-status').textContent.includes('3D graphics unavailable')")).catch(async error=>{
    console.log(await evaluate("({status:document.querySelector('#scene-status')?.textContent,mount:document.querySelector('#scene-mount')?.dataset,context:!!document.createElement('canvas').getContext('webgl2'),override:HTMLCanvasElement.prototype.getContext.toString()})"));
    await screenshot('fallback-timeout');throw error;
  });
  assert(await evaluate("!document.querySelector('#top').hidden&&!document.querySelector('#export').disabled"));
  await screenshot('fallback-mobile');
  await command('Network.setBlockedURLs',{urls:['*/data/bundle.json']});
  await command('Page.navigate',{url});
  await until(()=>evaluate("!document.querySelector('#load-error').hidden"));
  assert(await evaluate("!document.querySelector('#top').hidden&&!document.querySelector('#workspace-notice').hidden"),'A missing science bundle must expose an actionable error instead of an endless hidden loading state.');
  await screenshot('missing-bundle-mobile');
  await writeFile(resolve(work,'verification.json'),JSON.stringify({viewports:[[1024,768],[1366,768],[1440,900],[390,840]],
    initialStatus:'PASS',delayedStatus:'FAIL',recoveredStatus:'PASS',certificateRoles:['nominal','delayed','recommended','cross-site alternative'],
    invalidArrivalRejected:true,exportSelectionRace:true,allSiteVisibilityGates:true,noExternalRequests:true,
    webglFallback:true,missingBundleError:true,physicalDevice:false,humanComprehension:false,
    browser:await command('Browser.getVersion'),performance:performanceEvidence},null,2));
  console.log(`3D experience passed: textured GPU Moon/Earth, real DEM meshes, camera controls, PASS/FAIL/PASS story, all-site obstruction gating, lazy/offline assets, mobile, reduced motion and lost/absent WebGL fallback. Evidence: ${work}`);
}finally{socket?.close();browser.kill();server.close();}
