import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {bodyDirection,sceneFrame,localToMoonDirection} from '../web/scene-model.mjs';
import {runMission,evaluateStart} from '../web/engine.mjs';
import {communicationDemo} from '../web/overview.mjs';

const root=process.cwd(),work=resolve(root,'progress',`experience-${Date.now()}`);
const bundleBytes=await readFile(resolve(root,'web/data/bundle.json')),bundle=JSON.parse(bundleBytes);
const requireExtendedSite=process.argv.includes('--require-extended-site')||process.env.LUNARIS_REQUIRE_EXTENDED_SITE==='1';
const requireExtended=requireExtendedSite||process.argv.includes('--require-extended')||process.env.LUNARIS_REQUIRE_EXTENDED==='1';
const extraSite=bundle.sites.find(site=>site.id==='peak-near-shackleton');
if(requireExtendedSite)assert(extraSite,'--require-extended-site needs the actual NASA R07 observer and its own evidence, not the three-site cache.');
let extraTerrainMetadata=null,extraSiteEvidence=null;
if(extraSite){
  assert.equal(extraSite.lat,-88.811);assert.equal(extraSite.lon,123.6901);assert.equal(extraSite.heightM,2);
  const metadata=JSON.parse(await readFile(resolve(root,'web/data/terrain-scenes.json'),'utf8'));
  assert.equal(metadata.frame,bundle.manifest.frame.working);assert.equal(metadata.verticalExaggeration,1);assert.equal(metadata.metresPerUnit,1);
  extraTerrainMetadata=metadata.sites.find(row=>row.siteId===extraSite.id);assert(extraTerrainMetadata,'R07 needs its own display terrain metadata.');
  assert.equal(metadata.bundleSha256,createHash('sha256').update(bundleBytes).digest('hex'),'Display metadata must identify the actual expanded bundle bytes.');
  for(const key of ['lat','lon','groundM','heightM'])assert.equal(extraTerrainMetadata[key],extraSite[key],`R07 mesh observer ${key}`);
  const meshPath=resolve(root,'web/data',extraTerrainMetadata.positionFile);
  assert(meshPath.startsWith(resolve(root,'web/data')+sep),'The R07 mesh must be a local bundled asset.');
  const mesh=await readFile(meshPath),meshSha256=createHash('sha256').update(mesh).digest('hex');
  assert.equal(mesh.length,extraTerrainMetadata.byteLength);assert.equal(meshSha256,extraTerrainMetadata.sha256);
  assert(metadata.sites.filter(row=>row.siteId!==extraSite.id).every(row=>row.sha256!==meshSha256),'R07 must not borrow another study point\'s display mesh.');
  extraSiteEvidence={siteId:extraSite.id,coordinates:[extraSite.lat,extraSite.lon],meshBytes:mesh.length,meshSha256,
    mission:false,compare:false,atlas:false,exactCoordinate:false,unsupportedNeighbor:false,sensitivityIsolation:false,mobile:false,noWebGL:false};
}
const plannedExtendedDates=['2026-12-31T18:00:00Z','2027-07-01T06:00:00Z','2027-12-31T06:00:00Z'].map(value=>Date.parse(value)/1000);
if(requireExtended){
  assert.deepEqual(bundle.coverage,[Date.parse('2026-11-01T00:00:00Z')/1000,Date.parse('2028-01-01T00:00:00Z')/1000],
    '--require-extended needs the actual 426-day bundle; the November-only release cannot satisfy this browser gate.');
  assert(plannedExtendedDates.every(time=>time>=bundle.coverage[0]&&time+43200<=bundle.coverage[1]));
}
const outsideArrival=bundle.coverage[1]+86400;
const unsupportedDurationHours=(bundle.coverage[1]-bundle.coverage[0])/3600+24;
const inputUtc=seconds=>new Date(seconds*1000).toISOString().slice(0,19);
const extendedBrowserEvidence=[];
let extendedPlaybackEvidence=null;
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
  const checkWheel=async mode=>{
    await evaluate('scrollTo(0,0)');await sleep(200);
    const before=await inspect(),point=await evaluate("(()=>{const r=document.querySelector('#scene-mount canvas').getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height*.5}})()");
    await command('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:-120});
    await until(async()=>{const c=(await inspect()).camera;return mode==='surface'?c.fov<before.camera.fov:Math.hypot(...c.position)<Math.hypot(...before.camera.position);});
    assert.equal(await evaluate('scrollY'),0,`${mode}: ordinary wheel over the scene must zoom without scrolling the page.`);
    const zoomed=await inspect();
    await command('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:120});
    await until(async()=>{const c=(await inspect()).camera;return mode==='surface'?c.fov>zoomed.camera.fov:Math.hypot(...c.position)>Math.hypot(...zoomed.camera.position);});
    await command('Input.dispatchMouseEvent',{type:'mouseWheel',x:20,y:20,deltaX:0,deltaY:320});
    await until(()=>evaluate('scrollY>50'));await evaluate('scrollTo(0,0)');
  };
  const checkZoomKeys=async mode=>{
    const metric=async()=>{const c=(await inspect()).camera;return mode==='surface'?c.fov:Math.hypot(...c.position);};
    const before=await metric();
    await evaluate("document.querySelector('#scene-mount canvas').focus()");
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'+',code:'Equal',windowsVirtualKeyCode:187});
    assert(await metric()<before,`${mode}: keyboard plus must zoom in.`);
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'+',code:'Equal',windowsVirtualKeyCode:187});
    const zoomed=await metric();await command('Input.dispatchKeyEvent',{type:'keyDown',key:'-',code:'Minus',windowsVirtualKeyCode:189});
    assert(await metric()>zoomed,`${mode}: keyboard minus must zoom out.`);
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'-',code:'Minus',windowsVirtualKeyCode:189});
  };
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
  const checkExtraFrame=async time=>{
    const frame=await inspect(),sample=extraSite.geometry.find(row=>row[0]===time),expected=sceneFrame(extraSite,sample,bundle.coverage);
    assert.equal(frame.siteId,extraSite.id);assert.equal(frame.time,time);assert.equal(frame.mode,'surface');assert(sample);
    assert.equal(frame.terrain.siteId,extraSite.id);assert.equal(frame.terrain.loaded,true);
    assert.equal(frame.terrain.sha256,extraTerrainMetadata.sha256);assert.equal(frame.terrain.vertexCount,extraTerrainMetadata.vertexCount);
    assert.equal(frame.farHorizon.siteId,extraSite.id);assert.equal(frame.farHorizon.rendered,true);assert.equal(frame.camera.position[1],extraSite.heightM);
    for(const [key,az,el]of [['sun',1,2],['earth',4,5]]){
      assert.equal(frame[key].azimuth,sample[az]);assert.equal(frame[key].elevation,sample[el]);
      assert.deepEqual(frame[key].direction,bodyDirection(sample[az],sample[el]));
      assert.equal(frame[key].state,expected.states[key]);assert.equal(frame[key].visible,expected.states[key]==='visible');
      const world=localToMoonDirection(extraSite,bodyDirection(sample[az],sample[el]));
      assert.deepEqual(frame.orbital[key].direction,world);
      const actual=frame.orbital[key].position.map((value,index)=>value-frame.orbital.rayOrigin[index]),length=Math.hypot(...actual);
      assert(actual.every((value,index)=>Math.abs(value/length-world[index])<1e-12),'R07 rendered orbital positions must use its own ENU-to-Moon frame.');
    }
    return frame;
  };
  const desktop={width:1366,height:768,deviceScaleFactor:1,mobile:false};
  await command('Network.enable');await command('Runtime.enable');await command('Page.enable');await command('Performance.enable');await command('Emulation.setDeviceMetricsOverride',desktop);
  await command('Page.navigate',{url});
  try{await until(async()=>Boolean((await inspect())?.moon.textured));}
  catch(error){
    await screenshot('initialization-failure');
    console.error('Initial scene state:',await evaluate("({status:document.querySelector('#scene-status')?.textContent,scene:{...document.querySelector('#scene-mount')?.dataset},loadError:document.querySelector('#load-error')?.textContent,workspace:document.body.dataset.workspace,rect:document.querySelector('#scene-mount')?.getBoundingClientRect().toJSON()})"),exceptions);
    throw error;
  }
  await until(async()=>(await inspect()).renderedFrames>0);
  await until(()=>evaluate("!!document.querySelector('#quick-tour')"));
  const coldRequests=[...requests],coldSceneReadyMs=await evaluate('performance.now()');
  assert(await evaluate("!document.querySelector('#quick-tour').hidden&&document.querySelector('#quick-tour').dataset.step==='welcome'"),'First visit must offer onboarding without loading a preset.');
  await evaluate("document.querySelector('.quick-tour-close').click()");
  assert.match(await evaluate("document.querySelector('#experience-title').textContent"),/Explore the Moon. Find a landing window/);
  await screenshot('cold-mission-desktop');
  const coldLayout=await evaluate("Object.fromEntries(['visual-site','visual-arrival','visual-duration','story-title','find-opportunities','explore-site'].map(id=>{const r=document.querySelector('#'+id).getBoundingClientRect();return [id,{top:r.top,bottom:r.bottom,left:r.left,right:r.right}]}))");
  await writeFile(resolve(work,'cold-layout.json'),JSON.stringify(coldLayout,null,2));
  assert(await evaluate("(()=>{for(const id of ['visual-site','visual-arrival','visual-duration','story-title','find-opportunities','explore-site']){const n=document.querySelector('#'+id),r=n.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight)return false;}const n=document.querySelector('#find-opportunities'),r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()"),'The default environment inputs, main conclusion, Find and Explore actions must be visible and clickable without scrolling at1366x768.');
  const clickVisible=async selector=>{
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({behavior:'instant',block:'nearest'})`);await sleep(60);
    const point=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,clear:!n.disabled&&r.width>0&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=document.documentElement.clientWidth+1&&n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};})()`);
    assert(point.clear,selector+' must be visible and unobscured.');
    await command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
  };
  // The complete, consent-gated workflow is exercised in test_onboarding.mjs.
  await clickVisible('#tour-start');
  assert.equal(await evaluate("document.querySelector('#quick-tour').dataset.step"),'welcome');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert(await evaluate("document.querySelector('#quick-tour').hidden&&document.activeElement.id==='tour-start'"));
  await evaluate("document.querySelector('#apply-requirements').checked=false;document.querySelector('#apply-requirements').dispatchEvent(new Event('change'));document.querySelector('#mode-orbital').click();document.querySelector('#reset-orbit').click();scrollTo(0,0)");
  assert(await evaluate("!!document.querySelector('#find-opportunities')"),'Mission needs a direct landing-opportunity action.');
  assert.equal(await evaluate("document.querySelector('#apply-requirements')?.checked"),false,'Cold start must explore the environment without arbitrary mission requirements.');
  assert(await evaluate("document.querySelector('#story-status').hidden&&document.querySelector('#decision-evidence').hidden"));
  assert.match(await evaluate("document.querySelector('.hero-support').textContent"),/Choose a location and date/);
  assert.match(await evaluate("document.querySelector('#story-title').textContent"),/At least 7 h 53 min/);
  assert(await evaluate("[...document.querySelectorAll('#environment-overview .environment-measurement')].every(n=>n.closest('details')&&!n.closest('details').open)"),'Secondary measurements must be expandable, not six equally emphasized opening cards.');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.orbital-story-slot')).overflowY"),'visible','Mission must use normal page scrolling.');
  await evaluate("document.querySelector('#product-analyst').click()");
  assert(await evaluate("document.querySelectorAll('.science-guide>details').length===5&&!document.querySelector('#analysis-tools').open"),'Advanced explains five method questions before raw tools.');
  await screenshot('advanced-methods-desktop');
  await evaluate("document.querySelector('#product-explore').click()");
  const environmentRecord=await download('environment-record');
  assert.equal(environmentRecord.record_type,'environment-evidence');assert.equal(environmentRecord.requirements_applied,false);assert(!('status' in environmentRecord));
  await screenshot('environment-mission-desktop');
  await command('Emulation.setDeviceMetricsOverride',{width:683,height:384,deviceScaleFactor:2,mobile:false});
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'A 200%-equivalent CSS viewport must not overflow horizontally; this is not a native browser-zoom conformance test.');
  await screenshot('narrow-css-viewport');await command('Emulation.setDeviceMetricsOverride',desktop);
  await evaluate("document.querySelector('#apply-requirements').checked=true;document.querySelector('#apply-requirements').dispatchEvent(new Event('change'))");
  assert(await evaluate("!document.querySelector('#story-status').hidden&&document.querySelector('.story-progress').hidden"),'Enabling requirements alone must not force the three-stage delay story.');
  await evaluate("document.querySelector('#mission-requirements-editor').open=true;document.querySelector('#quick-max-sun').value=6;document.querySelector('#apply-quick-requirements').click()");
  assert.equal(await evaluate("Number(document.querySelector('#decision-requirements [data-constraint=max_sun_block]').dataset.threshold)"),6);
  assert(await evaluate("document.querySelector('#top').hidden&&document.querySelector('#assessment-label').textContent.includes('my mission')"),'Optional requirements must be editable without entering the engineering form.');
  await evaluate("document.querySelector('#mission-requirements-editor').open=false");
  await evaluate("document.querySelector('#apply-requirements').checked=false;document.querySelector('#apply-requirements').dispatchEvent(new Event('change'))");
  await evaluate("document.querySelector('#product-compare').click()");
  assert(await evaluate("!document.querySelector('#option-comparison .status')&&document.querySelector('#option-comparison').textContent.includes('Sun')"));
  const originalB=await evaluate("document.querySelector('#comparison-arrival-B').value");
  await evaluate("document.querySelector('#comparison-arrival-B').value='';document.querySelector('#comparison-arrival-B').dispatchEvent(new Event('change'))");
  assert.match(await evaluate("document.querySelector('#comparison-difference').textContent"),/Comparison incomplete/);
  await evaluate(`document.querySelector('#comparison-arrival-B').value=${JSON.stringify(originalB)};document.querySelector('#comparison-arrival-B').dispatchEvent(new Event('change'))`);
  assert(await evaluate("document.querySelector('.comparison-difference').getBoundingClientRect().bottom<=document.querySelector('#option-comparison').getBoundingClientRect().top"));
  await screenshot('environment-compare-desktop');
  await evaluate("document.querySelector('#product-explore').click();document.querySelector('#find-opportunities').click()");
  await until(()=>evaluate("document.querySelector('#landing-opportunities').dataset.kind==='VISIBILITY_FOUND'"));
  assert.equal(await evaluate("document.querySelectorAll('#opportunity-options [data-status=ENVIRONMENT]').length"),bundle.sites.length);
  assert(await evaluate("!document.querySelector('#opportunity-options .status')"));
  assert.match(await evaluate("document.querySelector('#opportunities-status').textContent"),/sites offer 12 h.*earliest/);
  assert(await evaluate("!document.querySelector('.search-evidence').open&&document.querySelector('#opportunities-counts').closest('details')"),'Search statistics must remain secondary to its conclusion.');
  await evaluate("document.querySelector('#landing-opportunities').scrollIntoView({block:'start',behavior:'instant'})");await screenshot('environment-opportunities-desktop');
  await evaluate("document.querySelector('#product-explore').click();document.querySelector('#start-delay-demo').click()");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.main-nav button')].map(n=>n.textContent)"),['Mission','Compare','Advanced']);
  assert(await evaluate("getComputedStyle(document.querySelector('#scene-poster')).display==='none'"),'Loaded GPU scene must remove the Moon poster, including in surface mode.');
  let info=await inspect();assert.equal(info.mode,'orbital');assert(info.moon.vertices>10000);
  const performanceEvidence={softwareGpu:true,initialTexturedSceneObservedMs:coldSceneReadyMs,
    resources:await evaluate("performance.getEntriesByType('resource').map(r=>({name:r.name.split('/').pop(),bytes:r.transferSize,durationMs:r.duration}))")};
  assert(await evaluate("document.querySelector('#top').hidden"),'Opening experience must not show the engineering form wall.');
  assert(await evaluate("(()=>{const canvas=document.querySelector('#scene-mount').getBoundingClientRect(),controls=document.querySelector('.scene-site-picker').getBoundingClientRect(),mode=document.querySelector('#mode-orbital'),m=mode.getBoundingClientRect();return canvas.width>=innerWidth*.95&&controls.left>=canvas.left&&controls.right<=canvas.right&&controls.top>=canvas.top&&controls.bottom<=canvas.bottom&&mode.contains(document.elementFromPoint(m.x+m.width/2,m.y+m.height/2))})()"),'The reconstructed world must span the viewport, with integrated planning and view controls fully inside it and unobscured.');
  assert(!coldRequests.some(r=>/terrain-.*.mesh/.test(r)),'Surface terrain must remain lazy while orbital bodies load.');
  assert(info.orbital,'Orbital Sun and Earth direction context is missing.');
  const orbitalSite=bundle.sites.find(s=>s.id===info.siteId),orbitalSample=orbitalSite.geometry.find(r=>r[0]===info.time);
  for(const [key,az,el]of [['sun',1,2],['earth',4,5]]){
    const expectedDirection=localToMoonDirection(orbitalSite,bodyDirection(orbitalSample[az],orbitalSample[el]));
    assert(info.orbital[key].direction.every((v,i)=>Math.abs(v-expectedDirection[i])<1e-12),'Orbital directions must match the verified local-to-Moon transform.');
  }
  await until(async()=>(await inspect()).orbital.earth.textured);
  await checkWheel('orbital');
  await checkZoomKeys('orbital');
  await evaluate("document.querySelector('#focus-earth').click()");await until(async()=>(await inspect()).orbital.earth.inFrustum);
  assert.equal((await inspect()).mode,'orbital');await screenshot('orbital-earth-desktop');
  await evaluate("document.querySelector('#focus-sun').click()");await until(async()=>(await inspect()).orbital.sun.inFrustum);await screenshot('orbital-sun-desktop');
  await evaluate("document.querySelector('#reset-orbit').click()");
  await until(async()=>{const c=(await inspect()).camera;return c.position.every((v,i)=>Math.abs(v-c.overviewPosition[i])<1e-5);});
  await evaluate("document.querySelector('#focus-terrain').click()");await sleep(1500);await screenshot('orbital-study-points-desktop');
  assert(Math.hypot(...(await inspect()).camera.position)>=3,'Study-point focus should retain a recognizable Moon silhouette, not a magnified global-texture patch.');
  await evaluate("document.querySelector('#reset-orbit').click()");
  await until(async()=>{const c=(await inspect()).camera;return c.position.every((v,i)=>Math.abs(v-c.overviewPosition[i])<1e-5);});
  for(const [width,height] of [[1024,768],[1440,900]]){
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    assert(await evaluate("(()=>{const n=document.querySelector('#story-next'),r=n.getBoundingClientRect();return r.bottom<=innerHeight&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('#story-next')===n&&document.documentElement.scrollWidth<=innerWidth})()"),`The mission action must remain usable at ${width}x${height}.`);
    await screenshot('orbital-'+width);
  }
  await command('Emulation.setDeviceMetricsOverride',desktop);
  await until(async()=>(await inspect()).moon.detail==='high');
  assert((await inspect()).moon.textured,'Desktop quality must upgrade automatically to the live 4K NASA texture.');
  assert.equal(await evaluate("document.querySelector('#moon-hd')"),null,'Judges should not need an HD button.');
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
  const darkFrame=await inspect();assert(darkFrame.displayLighting.ambientIntensity<.01);assert.equal(darkFrame.displayLighting.fill.intensity,0);
  await evaluate("document.querySelector('#night-visibility').click()");
  const assistFrame=await inspect();assert.equal(assistFrame.sun.visible,false);assert.equal(assistFrame.sun.directLightIntensity,0);
  assert(assistFrame.displayLighting.ambientIntensity>darkFrame.displayLighting.ambientIntensity);
  assert.equal(assistFrame.time,darkFrame.time);assert.deepEqual(assistFrame.sun.direction,darkFrame.sun.direction);
  assert.match(await evaluate("document.querySelector('#scene-mode-label').textContent"),/ARTIFICIAL/);
  await screenshot('delayed-enhanced-display');
  await evaluate("document.querySelector('#night-visibility').click()");await screenshot('delayed-dark-display');
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
  assert(await evaluate("(()=>{const a=document.querySelector('.recovery-wait').getBoundingClientRect(),b=document.querySelector('.scene-site-picker').getBoundingClientRect();return (a.bottom<=b.top||b.bottom<=a.top)&&a.top>=0&&a.bottom<=innerHeight})()"),'Recovery cost must stay visible without overlapping the compact mission controls.');
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
  assert.equal(await evaluate("document.querySelectorAll('#site-comparison article').length"),bundle.sites.length);
  const visibleCalendar=await evaluate("({month:document.querySelector('#calendar-month').textContent,starts:[...new Set([...document.querySelectorAll('.feasibility-cell')].map(n=>n.dataset.start))]})");
  assert.match(visibleCalendar.month,/November 2026/);
  assert.equal(await evaluate("document.querySelectorAll('.feasibility-cell').length"),visibleCalendar.starts.length*bundle.sites.length);
  assert(visibleCalendar.starts.every(value=>new Date(Number(value)*1000).getUTCMonth()===10),'Calendar rows must represent the displayed month.');
  assert.equal(await evaluate("document.querySelectorAll('#site-comparison .compact-requirements [data-constraint]').length"),bundle.sites.length*8,'Every original/delayed compared site must show the same four rules.');
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
  assert.equal(await evaluate("Date.parse(document.querySelector('#visual-arrival').value+'Z')/1000"),expected.nominal.start,'Resetting the example must synchronize the arrival even if validation left the field focused.');
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
  await evaluate("document.querySelector('#explore-site').click()");await sleep(30);
  await evaluate("document.querySelector('#scene-mount canvas').focus()");
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'+',code:'Equal',windowsVirtualKeyCode:187});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'+',code:'Equal',windowsVirtualKeyCode:187});
  await until(async()=>{const i=await inspect();return i?.mode==='surface'&&i.terrain.loaded&&i.earth.textured;});
  info=await inspect();assert.equal(info.camera.position[1],2);assert(info.terrain.vertexCount>50000);assert(info.terrain.indexCount>300000);
  const currentSite=bundle.sites.find(s=>s.id===info.siteId),sample=currentSite.geometry.find(r=>r[0]===info.time);
  await evaluate("document.querySelector('#focus-terrain').click()");await screenshot('surface-terrain-desktop');
  await checkWheel('surface');
  await checkZoomKeys('surface');
  const pinchPoint=await evaluate("(()=>{const r=document.querySelector('#scene-mount canvas').getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height*.5}})()"),pinchFov=(await inspect()).camera.fov;
  const touches=span=>[{id:1,x:pinchPoint.x-span,y:pinchPoint.y},{id:2,x:pinchPoint.x+span,y:pinchPoint.y}];
  await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:touches(35)});
  await command('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:touches(65)});
  await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await until(async()=>(await inspect()).camera.fov<pinchFov);
  const frame=sceneFrame(currentSite,sample,bundle.coverage);
  for(const [key,az,el] of [['sun',1,2],['earth',4,5]]){
    assert.equal(info[key].visible,frame.states[key]==='visible');
    assert.deepEqual(info[key].direction,bodyDirection(sample[az],sample[el]));
  }
  await evaluate("document.querySelector('#focus-earth').click()");await until(async()=>(await inspect()).camera.fov===10);
  assert(Math.abs((await inspect()).earth.angularDiameterDeg-1.9)<.001);
  await screenshot('surface-earth-desktop');
  await evaluate("document.querySelector('#focus-sun').click()");
  assert.equal((await inspect()).camera.fov,8,'Sun focus must use optical zoom without changing body angular size.');
  assert(Math.abs((await inspect()).sun.angularDiameterDeg-.53)<.001);
  await screenshot('surface-sun-desktop');
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
      const plannedArrival=await evaluate("document.querySelector('#visual-arrival').value");
      await evaluate(`document.querySelector('#hero-time').value=${index};document.querySelector('#hero-time').dispatchEvent(new Event('input'))`);
      assert.equal(await evaluate("document.querySelector('#visual-arrival').value"),plannedArrival,'View clock scrubbing must not change the evaluated arrival.');
      info=await inspect();assert.equal(info[key].state,state);assert.equal(info[key].visible,state==='visible',`${site.id} ${key} ${state}`);
      if(key==='earth'&&state==='blocked'){
        const arrivalBefore=await evaluate("document.querySelector('#visual-arrival').value"),conclusionBefore=await evaluate("document.querySelector('#story-explanation').textContent");
        await evaluate("document.querySelector('#focus-earth').click()");
        await until(()=>evaluate("!document.querySelector('.mission-terrain-obstruction').hidden"));
        assert.equal((await inspect()).earth.visible,false);
        assert(await evaluate("!document.querySelector('.mission-terrain-obstruction').hidden"),'Blocked Earth needs a directional annotation, not a rendered body.');
        assert.equal(await evaluate("document.querySelector('#visual-arrival').value"),arrivalBefore);
        assert.equal(await evaluate("document.querySelector('#story-explanation').textContent"),conclusionBefore);
        await screenshot(`earth-blocked-${site.id}`);
      }
    }
  }
  // Additional dates use the real expanded cache, never shifted November fixtures.
  const extendedDates=plannedExtendedDates.filter(time=>time>=bundle.coverage[0]&&time+43200<=bundle.coverage[1]);
  for(const [index,time]of extendedDates.entries()){
    const site=bundle.sites[index%bundle.sites.length],started=await evaluate('performance.now()');
    await evaluate(`document.querySelector('#verified-demo').click();document.querySelector('#visual-site').value=${JSON.stringify(site.id)};document.querySelector('#visual-site').dispatchEvent(new Event('change'));document.querySelector('#visual-arrival').value=${JSON.stringify(inputUtc(time))};document.querySelector('#visual-date-go').click()`);
    await until(async()=>{const frame=await inspect();return frame.siteId===site.id&&frame.time===time;});
    const elapsed=await evaluate('performance.now()')-started;
    const expectedInputs={...communicationDemo(bundle),siteId:site.id,nominal:time,earliest:bundle.coverage[0],latest:bundle.coverage[1]-43200};
    const expectedPlan=evaluateStart(bundle,expectedInputs,site.id,time);
    assert.equal(await evaluate("document.querySelector('#story-status').textContent"),expectedPlan.status);
    assert.match(await evaluate("document.querySelector('#story-date').textContent"),new RegExp(String(new Date(time*1000).getUTCFullYear())));
    const record=await download('extended-'+index);checkCertificate(record,expectedPlan,'nominal');
    assert.equal(record.data_bundle_hash,bundle.manifest.bundleSha256);
    assert.equal(record.inputs.earliest,expectedInputs.earliest);assert.equal(record.inputs.latest,expectedInputs.latest,'Candidate bounds must not rewrite the allowed schedule.');
    const arrival=await evaluate("document.querySelector('#visual-arrival').value");
    await evaluate("document.querySelector('#hero-time').value=1;document.querySelector('#hero-time').dispatchEvent(new Event('input'))");
    assert.equal((await inspect()).time,time+1800);
    assert.equal(await evaluate("document.querySelector('#visual-arrival').value"),arrival,'Extended-date scrubbing must not change the evaluated arrival.');
    await screenshot('extended-date-'+index);
    extendedBrowserEvidence.push({siteId:site.id,startUtc:new Date(time*1000).toISOString(),status:expectedPlan.status,inputToSceneStateMs:elapsed});
  }
  if(extendedDates.length){
    const first=extendedDates[0],second=extendedDates.at(-1),beforeCompare=(await inspect()).time;
    await evaluate("document.querySelector('#product-compare').click()");
    await evaluate(`document.querySelector('#comparison-arrival-A').value=${JSON.stringify(inputUtc(first))};document.querySelector('#comparison-arrival-A').dispatchEvent(new Event('change'));document.querySelector('#comparison-arrival-B').value=${JSON.stringify(inputUtc(second))};document.querySelector('#comparison-arrival-B').dispatchEvent(new Event('change'))`);
    assert.equal(await evaluate("Number(document.querySelector('#option-comparison [data-option=A]').dataset.start)"),first);
    assert.equal(await evaluate("Number(document.querySelector('#option-comparison [data-option=B]').dataset.start)"),second);
    assert.equal((await inspect()).time,beforeCompare,'Editing extended-date comparisons must leave the active scene unchanged.');
    await screenshot('extended-compare');
    await evaluate("document.querySelector('#comparison-view-A').click();document.querySelector('#product-compare').click();document.querySelector('#month-explorer').open=true");
    const planBeforeMonth=await evaluate("document.querySelector('#visual-arrival').value+'|'+document.querySelector('#visual-site').value"),monthBefore=await evaluate("document.querySelector('#calendar-month').textContent");
    await evaluate("document.querySelector('#calendar-next').click()");
    assert.notEqual(await evaluate("document.querySelector('#calendar-month').textContent"),monthBefore);
    assert.equal(await evaluate("document.querySelector('#visual-arrival').value+'|'+document.querySelector('#visual-site').value"),planBeforeMonth,'Calendar browsing must not change mission inputs.');
    assert((await evaluate("[...document.querySelectorAll('.feasibility-cell')].map(n=>Number(n.dataset.start))")).every(time=>new Date(time*1000).getUTCFullYear()===2027),'Calendar navigation must cross the year boundary with correct dates.');
    await screenshot('extended-calendar');
    const allCacheStarted=await evaluate('performance.now()');
    await evaluate("document.querySelector('#product-explore').click();document.querySelector('#hero-scope-month').click()");
    const fullScene=await inspect(),fullSite=bundle.sites.find(site=>site.id===fullScene.siteId);
    const fullSampleCount=fullSite.geometry.filter(row=>row[0]>=bundle.coverage[0]&&row[0]<bundle.coverage[1]).length;
    extendedPlaybackEvidence={sampleCount:fullSampleCount,fullCacheInteractionMs:await evaluate('performance.now()')-allCacheStarted};
    assert.equal(Number(await evaluate("document.querySelector('#hero-time').max")),fullSampleCount-1,'The full-cache scrubber must expose every actual cached sample in the half-open range.');
    await evaluate("document.querySelector('#hero-time').value=document.querySelector('#hero-time').max;document.querySelector('#hero-time').dispatchEvent(new Event('input'))");
    assert((await inspect()).time<bundle.coverage[1],'Full-cache playback must retain the exclusive end.');
    assert.equal(await evaluate("document.querySelector('#visual-arrival').value+'|'+document.querySelector('#visual-site').value"),planBeforeMonth);
    await evaluate("document.querySelector('#hero-scope-stay').click();document.querySelector('#find-opportunities').click()");
    await until(()=>evaluate("document.querySelector('#landing-opportunities').getAttribute('aria-busy')==='false'&&!document.querySelector('#landing-opportunities').hidden"));
    assert(['PASS_FOUND','NO_PASS','UNRESOLVED'].includes(await evaluate("document.querySelector('#landing-opportunities').dataset.kind")),'A fully covered extended request must distinguish actual failed/unresolved candidates from missing data.');
    if(bundle.coverage[1]-43200-first>30*86400)assert.match(await evaluate("document.querySelector('#opportunities-basis').textContent"),/later dates remain unsearched/i);
    await screenshot('extended-opportunities');
  }
  if(extraSite){
    // Load actual de Gerlache sensitivity evidence first, then prove it cannot be
    // relabeled or exported as an assessment of the new observation point.
    await evaluate("document.querySelector('#verified-demo').click();document.querySelector('#story-recovered').click();document.querySelector('#product-analyst').click();document.querySelector('#analysis-tools').open=true");
    for(const kind of ['height','position','terrain']){
      await evaluate(`document.querySelector('#${kind}-panel').open=true;document.querySelector('#run-${kind}s').click()`);
      await until(()=>evaluate(`!document.querySelector('#${kind}-results').hidden&&document.querySelector('#${kind}-results').childElementCount>0`));
    }
    const time=Date.parse('2027-07-01T06:00:00Z')/1000;
    await evaluate(`document.querySelector('#product-explore').click();document.querySelector('#visual-site').value=${JSON.stringify(extraSite.id)};document.querySelector('#visual-site').dispatchEvent(new Event('change'));document.querySelector('#visual-arrival').value=${JSON.stringify(inputUtc(time))};document.querySelector('#visual-date-go').click();document.querySelector('#mode-surface').click()`);
    await until(async()=>{const frame=await inspect();return frame.mode==='surface'&&frame.siteId===extraSite.id&&frame.time===time&&frame.terrain.siteId===extraSite.id&&frame.terrain.loaded;});
    await checkExtraFrame(time);extraSiteEvidence.mission=true;
    assert.match(await evaluate("document.querySelector('#visual-site-detail').textContent"),/88\.8110.*123\.6901/);
    assert(requests.some(url=>url.endsWith('/'+extraTerrainMetadata.positionFile)),'The browser must request the actual R07 terrain asset.');
    for(const kind of ['height','position','terrain']){
      assert(await evaluate(`document.querySelector('#run-${kind}s').disabled&&document.querySelector('#${kind}-results').hidden&&document.querySelector('#${kind}-results').childElementCount===0`));
      assert.match(await evaluate(`document.querySelector('#${kind}-status').textContent`),/de Gerlache/);
    }
    const record=await download('r07-no-sensitivity-leak');
    checkCertificate(record,evaluateStart(bundle,record.inputs,extraSite.id,time),'nominal');
    assert.deepEqual(record.scenario_ids,[]);assert.deepEqual(record.scenario_results,[]);
    assert(!Object.keys(record).some(key=>key.startsWith('height_study')));
    for(const key of ['position_study','terrain_study','one_factor_configurations'])assert.equal(record[key],undefined);
    assert.deepEqual(record.point_coordinates,{latitude_deg:extraSite.lat,longitude_east_deg:extraSite.lon});
    extraSiteEvidence.sensitivityIsolation=true;await evaluate("scrollTo(0,0)");await screenshot('r07-mission-desktop');

    // Independent option editing must not move the inspected mission. Only the
    // existing View action applies the option to the shared scene and clock.
    const comparisonTime=time+86400,beforeCompare=await inspect();
    await evaluate("document.querySelector('#product-compare').click()");
    const a=await evaluate("document.querySelector('#comparison-arrival-A').value+'|'+document.querySelector('#comparison-site-A').value");
    await evaluate(`document.querySelector('#comparison-site-B').value=${JSON.stringify(extraSite.id)};document.querySelector('#comparison-site-B').dispatchEvent(new Event('change'));document.querySelector('#comparison-arrival-B').value=${JSON.stringify(inputUtc(comparisonTime))};document.querySelector('#comparison-arrival-B').dispatchEvent(new Event('change'))`);
    assert.equal(await evaluate("document.querySelector('#comparison-arrival-A').value+'|'+document.querySelector('#comparison-site-A').value"),a);
    assert.equal((await inspect()).time,beforeCompare.time);assert.equal((await inspect()).siteId,beforeCompare.siteId);
    const compared=evaluateStart(bundle,{...record.inputs,nominal:comparisonTime},extraSite.id,comparisonTime);
    assert.equal(await evaluate("document.querySelector('#option-comparison [data-option=B]').dataset.status"),compared.status);
    await screenshot('r07-compare-desktop');await evaluate("document.querySelector('#comparison-view-B').click()");
    await until(async()=>{const frame=await inspect();return frame.siteId===extraSite.id&&frame.time===comparisonTime;});
    await checkExtraFrame(comparisonTime);
    checkCertificate(await download('r07-comparison-certificate'),compared,'nominal');extraSiteEvidence.compare=true;

    // The atlas and coordinate form recognize only the exact cached observer.
    await evaluate("document.querySelector('#visual-site').value='de-gerlache-rim';document.querySelector('#visual-site').dispatchEvent(new Event('change'));document.querySelector('#product-analyst').click();document.querySelector('#analysis-tools').open=true");
    await until(()=>evaluate(`!!document.querySelector('.atlas-site-button[data-site-id="${extraSite.id}"]')`));
    await evaluate(`document.querySelector('.atlas-site-button[data-site-id="${extraSite.id}"]').click()`);
    assert.equal((await inspect()).siteId,extraSite.id);extraSiteEvidence.atlas=true;
    await evaluate(`document.querySelector('#visual-site').value='de-gerlache-rim';document.querySelector('#visual-site').dispatchEvent(new Event('change'));document.querySelector('#explore-lat').value=${extraSite.lat};document.querySelector('#explore-lon').value=${extraSite.lon};document.querySelector('#coordinate-form').requestSubmit()`);
    assert.equal((await inspect()).siteId,extraSite.id);assert.equal(await evaluate("document.querySelector('#coordinate-feedback').dataset.supported"),'true');extraSiteEvidence.exactCoordinate=true;
    const beforeNeighbor=await evaluate("document.querySelector('#site').value+'|'+document.querySelector('#nominal').value");
    await evaluate(`document.querySelector('#explore-lat').value=${extraSite.lat+.0001};document.querySelector('#coordinate-form').requestSubmit()`);
    assert.equal(await evaluate("document.querySelector('#coordinate-feedback').dataset.supported"),'false');
    assert.match(await evaluate("document.querySelector('#coordinate-feedback').textContent"),/Unsupported terrain-aware calculation/);
    assert.equal(await evaluate("document.querySelector('#site').value+'|'+document.querySelector('#nominal').value"),beforeNeighbor);extraSiteEvidence.unsupportedNeighbor=true;
    await screenshot('r07-atlas-desktop');
    await evaluate("document.querySelector('#verified-demo').click();document.querySelector('#product-explore').click()");
  }
  // Custom planning is separate from a delayed same-site recovery.
  await evaluate("document.querySelector('#solar-demo').click();document.querySelector('#product-explore').click();document.querySelector('#visual-arrival').value='2026-11-17T03:00:00';document.querySelector('#visual-date-go').click()");
  assert.equal(await evaluate("Date.parse(document.querySelector('#latest').value+'Z')"),(bundle.coverage[1]-12*3600)*1000,'A custom arrival must not inherit the solar teaching preset\'s Nov7 cap.');
  await evaluate("document.querySelector('#verified-demo').click();document.querySelector('#visual-arrival').value='2026-11-17T03:00:00';document.querySelector('#visual-date-go').click();document.querySelector('#find-opportunities').click()");
  await until(()=>evaluate("document.querySelector('#landing-opportunities').dataset.kind==='PASS_FOUND'"));
  assert.equal(await evaluate("document.querySelector('#delay').value"),'72','The new-arrival search must not alter the original delay demo.');
  assert.equal(await evaluate("Number(document.querySelector('#opportunity-options [data-status=PASS]').dataset.start)"),Date.parse('2026-11-17T03:00Z')/1000);
  assert.equal(await evaluate("document.querySelectorAll('#opportunity-options article').length"),bundle.sites.length);
  await evaluate("document.querySelector('#landing-opportunities').scrollIntoView({block:'start',behavior:'instant'})");await screenshot('opportunities-pass-desktop');
  const viewed=await evaluate("(()=>{const c=document.querySelector('#opportunity-options [data-status=PASS]');return {site:c.dataset.site,start:Number(c.dataset.start)}})()");
  await evaluate("document.querySelector('#opportunity-options [data-status=PASS] button').click()");
  assert.equal((await inspect()).siteId,viewed.site);assert.equal((await inspect()).time,viewed.start);
  const viewedExpected=runMission(bundle,{...communicationDemo(bundle),siteId:viewed.site,nominal:viewed.start});
  checkCertificate(await download('opportunity-view-certificate'),viewedExpected.nominal,'nominal');
  await evaluate("document.querySelector('#earliest').value='2026-11-04T06:00:00';document.querySelector('#latest').value='2026-11-04T06:00:00';for(const id of ['earliest','latest'])document.querySelector('#'+id).dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#visual-arrival').value='2026-11-04T06:00:00';document.querySelector('#visual-date-go').click();document.querySelector('#find-opportunities').click()");
  // The expanded inventory includes an unresolved Kocher option on Nov4.
  // Assert that it remains unknown, then use a genuinely all-failing date.
  if(bundle.sites.some(site=>site.id==='de-gerlache-kocher')){
    await until(()=>evaluate("document.querySelector('#landing-opportunities').dataset.kind==='UNRESOLVED'"));
    assert(bundle.sites.some(site=>evaluateStart(bundle,{...communicationDemo(bundle),nominal:Date.parse('2026-11-04T06:00:00Z')/1000,earliest:Date.parse('2026-11-04T06:00:00Z')/1000,latest:Date.parse('2026-11-04T06:00:00Z')/1000},site.id).status==='INDETERMINATE'));
    await screenshot('opportunities-unresolved-desktop');
    const failedStart=Date.parse('2026-11-06T06:00:00Z')/1000;
    assert(bundle.sites.every(site=>evaluateStart(bundle,{...communicationDemo(bundle),nominal:failedStart,earliest:failedStart,latest:failedStart},site.id).status==='FAIL'),'The no-passing-option fixture must independently fail for every included site.');
    await evaluate("document.querySelector('#earliest').value='2026-11-06T06:00:00';document.querySelector('#latest').value='2026-11-06T06:00:00';for(const id of ['earliest','latest'])document.querySelector('#'+id).dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#visual-arrival').value='2026-11-06T06:00:00';document.querySelector('#visual-date-go').click();document.querySelector('#find-opportunities').click()");
  }
  await until(()=>evaluate("document.querySelector('#landing-opportunities').dataset.kind==='NO_PASS'"));
  assert(await evaluate("!document.querySelector('#opportunity-other').hidden&&document.querySelector('#opportunity-near-misses').textContent.includes('broken')"));await screenshot('opportunities-near-misses-desktop');
  await evaluate("document.querySelector('#visual-arrival').value='2026-11-17T03:00:00';document.querySelector('#visual-date-go').click();document.querySelector('#find-opportunities').click()");
  await until(()=>evaluate("document.querySelector('#landing-opportunities').dataset.kind==='SCHEDULE_EMPTY'"));
  assert.equal(await evaluate("Date.parse(document.querySelector('#latest').value+'Z')"),Date.parse(bundle.sites.some(site=>site.id==='de-gerlache-kocher')?'2026-11-06T06:00:00Z':'2026-11-04T06:00:00Z'),'Explicitly edited schedule limits must remain fixed.');await screenshot('opportunities-schedule-excluded-desktop');
  await evaluate("document.querySelector('#verified-demo').click();document.querySelector('#visual-duration').value=6;document.querySelector('#visual-arrival').value='2026-11-30T18:00:00';document.querySelector('#visual-date-go').click()");
  assert.equal(await evaluate("Date.parse(document.querySelector('#latest').value+'Z')"),(bundle.coverage[1]-6*3600)*1000);
  await evaluate(`document.querySelector('#verified-demo').click();document.querySelector('#visual-arrival').value=${JSON.stringify(inputUtc(outsideArrival))};document.querySelector('#visual-date-go').click();document.querySelector('#find-opportunities').click()`);
  await until(()=>evaluate("document.querySelector('#landing-opportunities').dataset.kind==='NO_DATA'"));
  assert.equal(await evaluate("document.querySelectorAll('#opportunity-options article').length"),0);await screenshot('opportunities-no-data-desktop');
  // The reconstructed explorer is disclosed on demand. Opening it must show
  // the current unsupported epoch, never stale cached angles from another view.
  await evaluate("document.querySelector('#any-site').open=true");
  await until(()=>evaluate("document.querySelector('#any-site-result').textContent.includes('outside the cached date range')"));
  assert.match(await evaluate("document.querySelector('#any-site-result').textContent"),/outside the cached date range/);
  assert.equal(await evaluate("document.querySelectorAll('#any-site-result .any-site-body').length"),0,'Other-location angles must not clamp an unsupported time to the last cached direction.');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.any-site-playhead')).display"),'none','The level-horizon chart must not retain a stale playhead outside coverage.');
  await evaluate(`document.querySelector('#verified-demo').click();document.querySelector('#visual-duration').value=${unsupportedDurationHours};document.querySelector('#visual-date-go').click();document.querySelector('#find-opportunities').click()`);
  await until(()=>evaluate("document.querySelector('#landing-opportunities').dataset.kind==='NO_DATA'"));
  assert.equal(await evaluate("Number(document.querySelector('#duration').value)"),unsupportedDurationHours,'An unsupported long duration must remain unchanged and receive a coverage explanation.');
  await evaluate(`document.querySelector('#nominal').value=${JSON.stringify(inputUtc(outsideArrival))};document.querySelector('#latest').value=${JSON.stringify(inputUtc(outsideArrival+8*86400))};document.querySelector('#time-scope').value='mission';document.querySelector('#evaluate').click()`);
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
  assert.match(await evaluate("document.querySelector('#experience-title').innerText"),/Explore the Moon/);
  assert(await evaluate("(()=>{const a=document.querySelector('.mission-scene-caption').getBoundingClientRect();return ['focus-earth','focus-sun','focus-terrain'].every(id=>{const b=document.getElementById(id).getBoundingClientRect();return a.bottom<=b.top||b.bottom<=a.top||a.right<=b.left||b.right<=a.left})})()"),'The selected site/coordinate row must never overlap any camera action.');
  await evaluate("document.querySelector('#focus-terrain').click()");await screenshot('surface-terrain-mobile');
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
  await evaluate("document.querySelector('#mode-orbital').click()");await until(async()=>(await inspect()).mode==='orbital');await screenshot('orbital-mobile');
  await evaluate("document.querySelector('#reset-orbit').click()");
  await until(async()=>{const camera=(await inspect()).camera;return camera.position.every((v,i)=>Math.abs(v-camera.overviewPosition[i])<1e-5);});
  await evaluate('scrollTo(0,0)');await screenshot('orbital-layout-mobile');
  assert(await evaluate("(()=>{const scene=document.querySelector('#scene-mount').getBoundingClientRect();return ['mode-orbital','mode-surface'].every(id=>{const n=document.getElementById(id),r=n.getBoundingClientRect();return r.left>=scene.left&&r.right<=scene.right&&r.top>=scene.top&&r.bottom<=scene.bottom&&r.height>=44&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})})()"),'Mobile view controls must be integrated into the scene, fully contained, touch-sized and unobscured.');
  assert(await evaluate("document.querySelector('#find-opportunities').getBoundingClientRect().bottom<=innerHeight"),'The mobile landing-opportunity action must be visible before advanced analysis.');
  await evaluate("document.querySelector('#apply-requirements').checked=false;document.querySelector('#apply-requirements').dispatchEvent(new Event('change'));scrollTo(0,0)");
  await screenshot('environment-mission-mobile');
  assert(await evaluate("(()=>{const n=document.querySelector('.mission-qualification'),note=n.getBoundingClientRect();return note.width>=innerWidth*.8&&note.height>0&&parseFloat(getComputedStyle(n).fontSize)>=14&&!n.closest('details')})()"),'The mobile scientific qualification must remain readable, full-width and outside a collapsed disclosure.');
  assert(await evaluate("document.querySelector('#find-opportunities').getBoundingClientRect().bottom<=innerHeight&&document.querySelector('#story-status').hidden"));
  await evaluate("document.querySelector('#find-opportunities').click()");await until(()=>evaluate("document.querySelector('#landing-opportunities').dataset.kind==='VISIBILITY_FOUND'"));
  await evaluate("document.querySelector('#landing-opportunities').scrollIntoView({block:'start',behavior:'instant'})");await screenshot('environment-opportunities-mobile');
  assert(await evaluate("[...document.querySelectorAll('#opportunity-options article')].every(n=>n.getBoundingClientRect().right<=innerWidth)"));
  await evaluate("document.querySelector('#product-compare').click()");await screenshot('environment-compare-mobile');
  if(extraSite){
    const time=Date.parse('2027-07-01T06:00:00Z')/1000;
    await evaluate(`document.querySelector('#product-explore').click();document.querySelector('#visual-site').value=${JSON.stringify(extraSite.id)};document.querySelector('#visual-site').dispatchEvent(new Event('change'));document.querySelector('#visual-arrival').value=${JSON.stringify(inputUtc(time))};document.querySelector('#visual-date-go').click();document.querySelector('#mode-surface').click();scrollTo(0,0)`);
    await until(async()=>{const frame=await inspect();return frame.mode==='surface'&&frame.terrain.siteId===extraSite.id&&frame.terrain.loaded&&frame.time===time;});
    await checkExtraFrame(time);assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    assert.equal(await evaluate("document.querySelector('#visual-site').value"),extraSite.id);await screenshot('r07-mission-mobile');
    await evaluate("document.querySelector('#product-compare').click()");
    await evaluate(`document.querySelector('#comparison-site-B').value=${JSON.stringify(extraSite.id)};document.querySelector('#comparison-site-B').dispatchEvent(new Event('change'));document.querySelector('#comparison-arrival-B').value=${JSON.stringify(inputUtc(time+1800))};document.querySelector('#comparison-arrival-B').dispatchEvent(new Event('change'))`);
    assert(await evaluate("[...document.querySelectorAll('#option-comparison>article')].every(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})"));
    await screenshot('r07-compare-mobile');await evaluate("document.querySelector('#comparison-view-B').click()");
    assert.equal((await inspect()).siteId,extraSite.id);assert.equal((await inspect()).time,time+1800);
    await evaluate(`document.querySelector('#product-analyst').click();document.querySelector('#analysis-tools').open=true;document.querySelector('.atlas-site-button[data-site-id="${extraSite.id}"]').scrollIntoView({block:'center',behavior:'instant'})`);
    assert(await evaluate(`(()=>{const n=document.querySelector('.atlas-site-button[data-site-id="${extraSite.id}"]'),r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})()`));
    assert.equal(await evaluate("document.querySelectorAll('.atlas-site-button').length"),bundle.sites.length);
    await screenshot('r07-atlas-mobile');extraSiteEvidence.mobile=true;
  }
  await evaluate("document.querySelector('#product-explore').click();document.querySelector('#start-delay-demo').click()");
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert(await evaluate("getComputedStyle(document.querySelector('.scene-poster')).transitionDuration==='0s'"));
  await clickVisible('#tour-start');
  for(let i=0;i<3;i++)await clickVisible('.quick-tour-next');
  await evaluate("document.querySelector('#scene-mount canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()");
  await until(()=>evaluate("document.querySelector('#scene-mount').dataset.webgl==='lost'"));
  assert(await evaluate("!document.querySelector('#top').hidden"));assert.equal((await inspect()).earth.visible,false);assert.equal((await inspect()).sun.visible,false);
  assert.match(await evaluate("document.querySelector('#scene-status').textContent"),/2D planner/);
  await evaluate("document.querySelector('#hero-time').value=Number(document.querySelector('#hero-time').value)+1;document.querySelector('#hero-time').dispatchEvent(new Event('input'))");
  await sleep(150);assert.equal((await inspect()).earth.visible,false);assert.equal((await inspect()).sun.visible,false);
  assert.equal(await evaluate("document.querySelector('#experience').dataset.ready"),'false');
  await until(()=>evaluate("document.querySelector('#quick-tour').getClientRects().length>0"));
  await clickVisible('.quick-tour-next');
  await until(()=>evaluate("document.querySelector('#quick-tour').dataset.step==='geometry'&&document.querySelector('#quick-tour-description').textContent.includes('3D is unavailable')"));
  assert(await evaluate("document.querySelector('#view-earth').classList.contains('quick-tour-target')"),'Lost WebGL must leave a real scientific control highlighted.');
  await clickVisible('.quick-tour-close');
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
  if(extraSite){
    const time=Date.parse('2027-07-01T06:00:00Z')/1000;
    await evaluate(`document.querySelector('#visual-site').value=${JSON.stringify(extraSite.id)};document.querySelector('#visual-site').dispatchEvent(new Event('change'));document.querySelector('#visual-arrival').value=${JSON.stringify(inputUtc(time))};document.querySelector('#visual-date-go').click();document.querySelector('#apply-requirements').checked=true;document.querySelector('#apply-requirements').dispatchEvent(new Event('change'))`);
    assert.equal(await evaluate("document.querySelector('#site').value"),extraSite.id);
    assert.equal(Number(await evaluate("document.querySelector('#local-sky').dataset.time")),time);
    assert.match(await evaluate("document.querySelector('#local-sky').textContent"),/Peak Near Shackleton/);
    assert.equal(await evaluate("document.querySelector('#experience').dataset.ready"),'false');
    const record=await download('r07-no-webgl-certificate');checkCertificate(record,evaluateStart(bundle,record.inputs,extraSite.id,time),'nominal');
    assert.deepEqual(record.scenario_ids,[]);assert.deepEqual(record.scenario_results,[]);
    await screenshot('r07-fallback-mobile');extraSiteEvidence.noWebGL=true;
  }
  await command('Network.setBlockedURLs',{urls:['*/data/bundle.json']});
  await command('Page.navigate',{url});
  await until(()=>evaluate("!document.querySelector('#load-error').hidden"));
  assert(await evaluate("!document.querySelector('#top').hidden&&!document.querySelector('#workspace-notice').hidden"),'A missing science bundle must expose an actionable error instead of an endless hidden loading state.');
  await screenshot('missing-bundle-mobile');
  if(requireExtended){
    assert.equal(extendedBrowserEvidence.length,3,'All three actual extended dates must execute, not silently skip.');
    assert.deepEqual(extendedBrowserEvidence.map(row=>Date.parse(row.startUtc)/1000),plannedExtendedDates);
    assert.equal(extendedPlaybackEvidence?.sampleCount,426*48,'The actual annual full-cache playback check must execute.');
  }
  if(requireExtendedSite)assert(extraSiteEvidence&&Object.values(extraSiteEvidence).every(value=>value!==false),'Every required R07 interaction must execute, including mobile and no-WebGL evidence.');
  await writeFile(resolve(work,'verification.json'),JSON.stringify({viewports:[[1024,768],[1366,768],[1440,900],[390,840]],
    defaultMode:'environment-without-requirements',optionalExampleInitialStatus:'PASS',delayedStatus:'FAIL',recoveredStatus:'PASS',certificateRoles:['nominal','delayed','recommended','cross-site alternative'],
    invalidArrivalRejected:true,exportSelectionRace:true,allSiteVisibilityGates:true,noExternalRequests:true,customOpportunitySearch:true,automaticAndExplicitSchedules:true,opportunityCertificateIdentity:true,ordinaryWheelZoomAndPageScrollOutsideCanvas:['orbital','surface'],keyboardZoom:['orbital','surface'],surfaceTouchPinch:true,
    webglFallback:true,missingBundleError:true,physicalDevice:false,humanComprehension:false,requireExtended,requireExtendedSite,extendedBrowserEvidence,extendedPlaybackEvidence,extraSiteEvidence,
    dataBundlePayloadSha256:bundle.manifest.bundleSha256,coverageUtc:bundle.coverage.map(time=>new Date(time*1000).toISOString()),siteIds:bundle.sites.map(site=>site.id),
    browser:await command('Browser.getVersion'),performance:performanceEvidence},null,2));
  console.log(`3D experience passed: textured GPU Moon/Earth, real DEM meshes, camera controls, PASS/FAIL/PASS story, all-site obstruction gating, lazy/offline assets, mobile, reduced motion and lost/absent WebGL fallback. Evidence: ${work}`);
}finally{socket?.close();browser.kill();server.close();}
