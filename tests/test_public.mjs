import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {evaluateStart} from '../web/engine.mjs';
import {communicationDemo} from '../web/overview.mjs';
import {bodyDirection,sceneFrame} from '../web/scene-model.mjs';

const url=process.argv[2]??'https://aryaergin.github.io/lunaris-spaceapps-2026/';
const expectedSha=process.argv[3];
assert.match(expectedSha??'',/^[a-f0-9]{40}$/i,'Supply the exact expected public release SHA after the URL.');
const skipMedia=process.argv.includes('--skip-media');
const requireExtendedSite=process.argv.includes('--require-extended-site');
const requireTenSites=process.argv.includes('--require-ten-sites');
const work=resolve('.operator/release-integration-20261115',`public-${Date.now()}`);await mkdir(work,{recursive:true});
const release=await fetch(new URL('release.json',url)).then(r=>{assert.equal(r.status,200);return r.json();});
assert.equal(release.application_release_sha,expectedSha);
const bundleBytes=await fetch(new URL('data/bundle.json',url)).then(async r=>{assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer());});
const bundle=JSON.parse(bundleBytes.toString('utf8'));
assert(bundle.sites.length>=3);assert.equal(new Set(bundle.sites.map(site=>site.id)).size,bundle.sites.length);
for(const id of ['connecting-ridge','shackleton-rim','de-gerlache-rim'])assert(bundle.sites.some(site=>site.id===id),`Original verified study point ${id} must remain published.`);
assert.equal((await fetch(new URL('data/terrain-atlas.png',url))).status,200);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const extendedSiteId='peak-near-shackleton',extendedStart=Date.parse('2027-07-01T06:00:00Z')/1000;
const inputUtc=seconds=>new Date(seconds*1000).toISOString().slice(0,19);
let extendedEvidence=null,extendedSite=null,extendedTerrain=null;
if(requireTenSites){
  const localBundle=JSON.parse(await readFile(resolve('web/data/bundle.json'),'utf8'));
  assert.equal(localBundle.sites.length,10,'Run the ten-site release check from its matching integration checkout.');
  assert.deepEqual(bundle.sites.map(({id,lat,lon,heightM})=>({id,lat,lon,heightM})),localBundle.sites.map(({id,lat,lon,heightM})=>({id,lat,lon,heightM})),'The public release must publish the complete matching ten-site inventory.');
  assert.equal(sha256(bundleBytes),sha256(await readFile(resolve('web/data/bundle.json'))),'The public bundle must match the verified ten-site release bytes.');
}
if(requireExtendedSite||requireTenSites){
  for(const id of ['connecting-ridge','shackleton-rim','de-gerlache-rim','peak-near-shackleton'])assert(bundle.sites.some(site=>site.id===id),`The extended release must preserve original study point ${id}.`);
  assert.deepEqual(bundle.coverage,[Date.parse('2026-11-01T00:00:00Z')/1000,Date.parse('2028-01-01T00:00:00Z')/1000],
    'The extended public release must contain the actual half-open 426-day cache.');
  extendedSite=bundle.sites.find(site=>site.id===extendedSiteId);assert(extendedSite,'The extended release needs the actual NASA R07 study point.');
  assert.equal(extendedSite.lat,-88.811);assert.equal(extendedSite.lon,123.6901);assert.equal(extendedSite.heightM,2);
  assert(extendedSite.geometry.some(row=>row[0]===extendedStart),'R07 must have actual 2027 geometry samples.');
  const metadataBytes=await fetch(new URL('data/terrain-scenes.json',url)).then(async r=>{assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer());});
  const metadata=JSON.parse(metadataBytes.toString('utf8'));
  assert.equal(metadata.bundleSha256,sha256(bundleBytes),'Published terrain metadata must bind to the exact published bundle bytes.');
  assert.equal(metadata.frame,bundle.manifest.frame.working);assert.equal(metadata.verticalExaggeration,1);assert.equal(metadata.metresPerUnit,1);
  extendedTerrain=metadata.sites.find(row=>row.siteId===extendedSiteId);assert(extendedTerrain,'R07 must have its own published terrain metadata.');
  for(const key of ['lat','lon','groundM','heightM'])assert.equal(extendedTerrain[key],extendedSite[key],`Published R07 terrain observer ${key}`);
  const dataUrl=new URL('data/',url),meshUrl=new URL(extendedTerrain.positionFile,dataUrl);
  assert(meshUrl.href.startsWith(dataUrl.href),'R07 terrain must be a bundled same-origin asset.');
  const mesh=await fetch(meshUrl).then(async r=>{assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer());});
  assert.equal(mesh.length,extendedTerrain.byteLength);assert.equal(sha256(mesh),extendedTerrain.sha256,'Published R07 terrain bytes must match their recorded SHA-256.');
  assert(metadata.sites.filter(row=>row.siteId!==extendedSiteId).every(row=>row.sha256!==extendedTerrain.sha256),'R07 must not reuse another study point terrain asset.');
  extendedEvidence={siteId:extendedSiteId,coordinates:[extendedSite.lat,extendedSite.lon],heightM:extendedSite.heightM,
    startUtc:new Date(extendedStart*1000).toISOString(),bundleFileSha256:sha256(bundleBytes),bundlePayloadSha256:bundle.manifest.bundleSha256,
    terrainMetadataSha256:sha256(metadataBytes),terrainFile:extendedTerrain.positionFile,terrainSha256:sha256(mesh),terrainBytes:mesh.length,
    desktop:false,mobile:false,noWebGL:false};
}
const profile=resolve(work,'anonymous-chrome');
const browser=spawn(process.env.LUNARIS_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--no-first-run','--disable-extensions',
  '--disable-background-networking','--use-angle=swiftshader','--enable-unsafe-swiftshader','about:blank'],{stdio:['ignore','ignore','pipe']});
let logs='';browser.stderr.on('data',c=>logs=(logs+c).slice(-1200));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<180;i++){const v=await fn().catch(()=>null);if(v)return v;await sleep(100);}throw Error('Public browser timeout '+logs);}
let socket;
try{
  const port=(await until(()=>readFile(resolve(profile,'DevToolsActivePort'),'utf8'))).split(/\r?\n/)[0];
  const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await once(socket,'open');
  let id=0;const callbacks=new Map(),errors=[],requests=[];
  socket.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(callbacks.has(m.id)){callbacks.get(m.id)(m);callbacks.delete(m.id);}});
  const command=(method,params={})=>new Promise((ok,no)=>{const key=++id;callbacks.set(key,m=>m.error?no(Error(JSON.stringify(m.error))):ok(m.result));socket.send(JSON.stringify({id:key,method,params}));});
  const evaluate=async(expression,userGesture=false)=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
  const screenshot=async name=>{const r=await command('Page.captureScreenshot',{format:'png'});await writeFile(resolve(work,name+'.png'),Buffer.from(r.data,'base64'));};
  const inspect=()=>evaluate(`import(${JSON.stringify(new URL('app.mjs',url).href)}).then(m=>m.inspectExperience())`);
  const extendedInputs=()=>({...communicationDemo(bundle),siteId:extendedSiteId,nominal:extendedStart,
    earliest:bundle.coverage[0],latest:bundle.coverage[1]-12*3600});
  const checkExtendedClock=async(time,{surface=false}={})=>{
    const state=await evaluate(`(()=>{const q=id=>document.querySelector('#'+id);return {site:q('visual-site').value,analystSite:q('site').value,
      arrival:q('visual-arrival').value,viewTime:Number(q('scene-mount').dataset.time),horizonTime:Number(q('local-sky').dataset.time),
      telemetryTime:Number(q('live-telemetry').dataset.time),clock:q('scene-clock').textContent,probeClock:q('probe-slider').getAttribute('aria-valuetext'),
      heroIndex:q('hero-time').value,probeIndex:q('probe-slider').value,status:q('story-status').textContent,requirements:q('apply-requirements').checked}})()`);
    assert.equal(state.site,extendedSiteId);assert.equal(state.analystSite,extendedSiteId);assert.equal(Date.parse(state.arrival+'Z')/1000,extendedStart);
    for(const key of ['viewTime','horizonTime','telemetryTime'])assert.equal(state[key],time,`R07 ${key} must follow the selected cached sample.`);
    assert.equal(state.clock,state.probeClock);assert.match(state.clock,/2027/);assert.equal(state.heroIndex,state.probeIndex);assert.equal(state.requirements,true);
    const plan=evaluateStart(bundle,extendedInputs(),extendedSiteId,extendedStart);assert.equal(state.status,plan.status);
    if(surface){
      const frame=await inspect(),sample=extendedSite.geometry.find(row=>row[0]===time),expected=sceneFrame(extendedSite,sample,bundle.coverage);
      assert(sample);assert.equal(frame.webgl,'ready');assert.equal(frame.mode,'surface');assert.equal(frame.siteId,extendedSiteId);assert.equal(frame.time,time);
      assert(frame.renderedFrames>0,'The public WebGL surface must actually render.');assert.equal(frame.earth.textured,true);
      assert.equal(frame.terrain.siteId,extendedSiteId);assert.equal(frame.terrain.loaded,true);assert.equal(frame.terrain.sha256,extendedTerrain.sha256);
      assert.equal(frame.terrain.vertexCount,extendedTerrain.vertexCount);assert.equal(frame.camera.position[1],extendedSite.heightM);
      assert.equal(frame.farHorizon.siteId,extendedSiteId);assert.equal(frame.farHorizon.rendered,true);
      for(const [key,az,el]of [['sun',1,2],['earth',4,5]]){
        assert.equal(frame[key].azimuth,sample[az]);assert.equal(frame[key].elevation,sample[el]);
        assert.deepEqual(frame[key].direction,bodyDirection(sample[az],sample[el]));
        assert.equal(frame[key].state,expected.states[key]);assert.equal(frame[key].visible,expected.states[key]==='visible');
      }
    }
    return plan;
  };
  const checkExtendedDownload=async(label,time)=>{
    const folder=resolve(work,label);await mkdir(folder,{recursive:true});await command('Page.setDownloadBehavior',{behavior:'allow',downloadPath:folder});
    await evaluate("document.querySelector('#export').click()");
    const file=await until(async()=>(await readdir(folder)).find(name=>name.endsWith('.json'))),record=JSON.parse(await readFile(resolve(folder,file),'utf8'));
    const inputs=extendedInputs(),plan=evaluateStart(bundle,inputs,extendedSiteId,extendedStart);
    assert.equal(record.certificate_version,'2.0');assert.equal(record.application_release_sha,expectedSha);assert.equal(record.engine_commit,expectedSha);
    assert.equal(record.data_bundle_hash,bundle.manifest.bundleSha256);assert.equal(record.data_bundle_version,bundle.version);
    assert.deepEqual(record.inputs,inputs);assert.deepEqual(record.selected_plan,plan);assert.deepEqual(record.nominal_result,plan);
    assert.equal(record.selected_role,'nominal');assert.equal(record.selected_alternative_index,null);assert.equal(record.site_id,extendedSiteId);
    assert.equal(record.status,plan.status);assert.deepEqual(record.constraints,plan.constraints);
    assert.deepEqual(record.witness_intervals,plan.constraints.map(c=>({constraint_id:c.id,interval:c.witness,segments:c.witnessSegments??null})));
    assert.equal(Date.parse(record.mission_start_utc)/1000,plan.start);assert.equal(Date.parse(record.mission_end_utc)/1000,plan.end);
    assert.deepEqual(record.point_coordinates,{latitude_deg:extendedSite.lat,longitude_east_deg:extendedSite.lon});
    assert.deepEqual(record.coordinate_source,extendedSite.source);assert.deepEqual(record.frame,bundle.manifest.frame);
    assert.deepEqual(record.instrument_heights_m,{solar:2,earth_center_los:2});
    assert.deepEqual(record.inspected_mission,{role:'nominal',alternativeIndex:null,siteId:extendedSiteId,start:plan.start,end:plan.end,status:plan.status});
    assert.deepEqual(record.scenario_ids,[]);assert.deepEqual(record.scenario_results,[]);
    assert.equal(record.display_inspection.sample_utc,time);assert.deepEqual(record.display_inspection.sample,extendedSite.geometry.find(row=>row[0]===time));
    return {status:plan.status,start:plan.start,end:plan.end,certificate:file,sampleUtc:time};
  };
  const selectExtendedMission=async()=>{
    await evaluate(`document.querySelector('#verified-demo').click();document.querySelector('#visual-site').value=${JSON.stringify(extendedSiteId)};
      document.querySelector('#visual-site').dispatchEvent(new Event('change'));document.querySelector('#visual-arrival').value=${JSON.stringify(inputUtc(extendedStart))};
      document.querySelector('#visual-date-go').click();document.querySelector('#hero-scope-stay').click()`);
    await until(()=>evaluate(`Number(document.querySelector('#local-sky').dataset.time)===${extendedStart}&&!document.querySelector('#export').disabled`));
  };
  await command('Page.enable');await command('Runtime.enable');await command('Network.enable');
  await command('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false});
  await command('Page.navigate',{url});await until(()=>evaluate("!!document.querySelector('#export:not([disabled])')"));
  assert.equal(await evaluate('location.href'),url,'Public app must not redirect to authentication.');
  const guided=await evaluate("!!document.querySelector('#story-next')");
  if(await evaluate("document.querySelector('#apply-requirements')?.checked===false")){
    assert(await evaluate("document.querySelector('#story-status').hidden&&document.querySelector('#environment-overview').childElementCount>0"));
    await screenshot('anonymous-environment-desktop');
    await evaluate("document.querySelector('#find-opportunities').click()");
    await until(()=>evaluate("document.querySelector('#landing-opportunities').dataset.kind==='VISIBILITY_FOUND'"));
    assert(await evaluate(`!document.querySelector('#opportunity-options .status')&&document.querySelectorAll('#opportunity-options article').length===${bundle.sites.length}`));
    await evaluate("document.querySelector('#landing-opportunities').scrollIntoView({block:'start',behavior:'instant'})");
    await screenshot('anonymous-environment-opportunities');
    await evaluate("document.querySelector('#start-delay-demo').click()");
  }
  if(!guided)await evaluate("document.querySelector('#communication-demo').click()");
  await screenshot('anonymous-desktop');
  const states=[],certificates=[];
  for(const role of ['nominal','delayed','recommended']){
    const folder=resolve(work,role);await mkdir(folder,{recursive:true});await command('Page.setDownloadBehavior',{behavior:'allow',downloadPath:folder});
    await evaluate(guided?`document.querySelector('[data-story="${role}"]').click()`:`document.querySelector('[data-decision="${role}"]').click()`);
    const screen=await evaluate(`(()=>{const n=document.querySelector('[data-decision="${role}"]');return{start:Number(n.dataset.start),end:Number(n.dataset.end),status:n.querySelector('.decision-status').textContent}})()`);
    states.push(screen.status);await evaluate("document.querySelector('#export').click()");
    const file=await until(async()=>(await readdir(folder)).find(n=>n.endsWith('.json')));
    const certificate=JSON.parse(await readFile(resolve(folder,file),'utf8'));certificates.push(certificate);
    assert.equal(certificate[role+'_result'].start,screen.start);
    if(certificate.certificate_version==='2.0'){
      assert.equal(certificate.selected_role,role);assert.equal(certificate.selected_plan.start,screen.start);
      assert.equal(certificate.status,screen.status);assert.equal(certificate.application_release_sha,release.application_release_sha);
      assert.equal(Date.parse(certificate.mission_start_utc)/1000,screen.start);
      assert.equal(Date.parse(certificate.mission_end_utc)/1000,screen.end);
      assert.deepEqual(certificate.constraints,certificate.selected_plan.constraints);
    }
  }
  assert.deepEqual(states,['PASS','FAIL','PASS']);
  if(guided){assert.equal(certificates[2].recommended_result.start,Date.parse('2026-11-17T03:00:00Z')/1000);}
  if(requireExtendedSite){
    assert.equal(certificates[1].delayed_result.start-certificates[0].nominal_result.start,72*3600,'The original real-data failure must retain the 72-hour delay.');
    assert.equal(await evaluate("fetch('./release.json').then(r=>r.json()).then(r=>r.application_release_sha)"),expectedSha,'The anonymous browser must receive the expected public release identity.');
    await selectExtendedMission();await evaluate("document.querySelector('#mode-surface').click()");
    const rendering=await until(async()=>{
      const frame=await inspect();
      if(frame?.webgl==='ready'&&frame.mode==='surface'&&frame.siteId===extendedSiteId&&frame.time===extendedStart&&frame.terrain.loaded)return 'surface';
      return await evaluate("document.querySelector('#scene-status').textContent.includes('3D graphics unavailable')&&document.querySelector('#experience').dataset.ready==='false'")?'fallback':null;
    });
    if(rendering==='fallback')assert(await evaluate("!document.querySelector('#top').hidden&&!document.querySelector('#export').disabled"),'Unavailable WebGL must leave the accessible planner functional.');
    await checkExtendedClock(extendedStart,{surface:rendering==='surface'});
    assert.match(await evaluate("document.querySelector('#visual-site-detail').textContent"),/88\.8110.*123\.6901.*2 m/);
    if(rendering==='surface')assert(requests.some(request=>request===new URL(extendedTerrain.positionFile,new URL('data/',url)).href),'The public browser must request R07 terrain itself.');
    extendedEvidence.desktop={rendering,...await checkExtendedDownload('r07-desktop',extendedStart)};
    await screenshot('anonymous-r07-2027-desktop');
    await evaluate("document.querySelector('#hero-time').value=1;document.querySelector('#hero-time').dispatchEvent(new Event('input'))");
    await checkExtendedClock(extendedStart+1800,{surface:rendering==='surface'});
    await checkExtendedDownload('r07-scrubbed',extendedStart+1800);
    extendedEvidence.scrub={viewSampleUtc:extendedStart+1800,arrivalUnchanged:inputUtc(extendedStart)};
  }
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:840,deviceScaleFactor:1,mobile:false});
  await evaluate('scrollTo(0,0)');await screenshot('anonymous-mobile');
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
  if(requireExtendedSite){
    await checkExtendedClock(extendedStart+1800,{surface:extendedEvidence.desktop.rendering==='surface'});
    extendedEvidence.mobile={...await checkExtendedDownload('r07-mobile',extendedStart+1800),width:390,horizontalOverflow:false};
    await screenshot('anonymous-r07-2027-mobile');
  }
  await evaluate("document.querySelector('#product-analyst').click()");
  assert.equal(await evaluate("document.querySelectorAll('.science-guide>details').length"),5);
  await screenshot('anonymous-advanced-mobile');
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await command('Page.addScriptToEvaluateOnNewDocument',{source:"const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /webgl/i.test(type)?null:original.call(this,type,...args)}"});
  await command('Page.navigate',{url});await until(()=>evaluate("!!document.querySelector('#export:not([disabled])')"));
  if(guided)await until(()=>evaluate("document.querySelector('#scene-status').textContent.includes('3D graphics unavailable')"));
  await screenshot('anonymous-no-webgl');assert.deepEqual(errors,[]);
  if(requireExtendedSite){
    await selectExtendedMission();await checkExtendedClock(extendedStart);
    assert.equal(await evaluate("document.querySelector('#experience').dataset.ready"),'false');
    assert.match(await evaluate("document.querySelector('#scene-status').textContent"),/3D graphics unavailable.*2D planner/);
    assert(await evaluate("!document.querySelector('#top').hidden&&!document.querySelector('#export').disabled"));
    assert.match(await evaluate("document.querySelector('#local-sky').textContent"),/Peak Near Shackleton/);
    assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    extendedEvidence.noWebGL={...await checkExtendedDownload('r07-no-webgl',extendedStart),accessiblePlanner:true};
    await screenshot('anonymous-r07-2027-no-webgl');assert.deepEqual(errors,[]);
  }
  let video=null;
  if(!skipMedia){
  await command('Page.navigate',{url:new URL('demo.html',url).href});
  await until(()=>evaluate("document.querySelector('video')?.readyState>=1"));
  video=await evaluate("(()=>{const v=document.querySelector('video');return {duration:v.duration,width:v.videoWidth,height:v.videoHeight}})()");
  assert.equal(video.duration,28.8);assert(video.duration<30,'Submission video must stay under 30 seconds');assert.deepEqual([video.width,video.height],[1920,1080]);
  await evaluate("document.querySelector('video').play()",true);
  await until(()=>evaluate("document.querySelector('video').currentTime>0.15"));
  await evaluate("document.querySelector('video').pause();document.querySelector('video').currentTime=27");
  await until(()=>evaluate("!document.querySelector('video').seeking&&document.querySelector('video').readyState>=2"));
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
  await screenshot('anonymous-demo-mobile');assert.deepEqual(errors,[]);
  }
  const version=await command('Browser.getVersion');
  if(requireExtendedSite)assert(extendedEvidence.desktop&&extendedEvidence.mobile&&extendedEvidence.noWebGL,'All required extended-site public checks must execute.');
  await writeFile(resolve(work,'verification.json'),JSON.stringify({url,release,states,anonymous:true,requireExtendedSite,extendedSite:extendedEvidence,demo:video,mediaNotExercised:skipMedia,viewports:[[1366,768],[390,840]],browser:version,physicalSecondDevice:false},null,2));
  console.log(`Public anonymous deployment verified: ${url} SHA ${release.application_release_sha}; JSON/PNG, refresh, PASS/FAIL/PASS, downloaded certificates, mobile emulation and JavaScript-without-WebGL passed. Evidence: ${work}`);
}finally{socket?.close();browser.kill();}
