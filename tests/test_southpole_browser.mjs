// Standalone actual-data Chrome regression. No fixture substitution or app edits.
// LUNARIS_SOUTHPOLE_ROOT=<release checkout> node tests/test_southpole_browser.mjs
// Optional: LUNARIS_CHROME, LUNARIS_SOUTHPOLE_EVIDENCE_DIR, --hardware-gpu.
// Default software WebGL is reproducible; no frame-rate or physical-phone claim.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const root=resolve(process.env.LUNARIS_SOUTHPOLE_ROOT??process.cwd());
const originalIds=['connecting-ridge','shackleton-rim','de-gerlache-rim','peak-near-shackleton'];
const addedIds=['nobile-rim-1','malapert-massif','leibnitz-beta-plateau','de-gerlache-kocher','haworth','nobile-rim-2'];
const requiredIds=[...originalIds,...addedIds];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const readJson=async name=>JSON.parse(await readFile(resolve(root,name),'utf8'));
const source=await readFile(resolve(root,'web/data/bundle.json'));
const bundle=JSON.parse(source),scenes=await readJson('web/data/terrain-scenes.json');
assert(bundle.sites?.length>=10,`PRECONDITION: requires the assembled actual >=10-site bundle; found ${bundle.sites?.length??0} at ${root}. No browser checks ran.`);
const ids=bundle.sites.map(site=>site.id);
assert.equal(new Set(ids).size,ids.length,'Duplicate scientific study-point identities');
for(const id of requiredIds)assert(ids.includes(id),`PRECONDITION: missing requested study point ${id}`);
assert.equal(scenes.bundleSha256,digest(source),'PRECONDITION: terrain-scenes.json is stale relative to the exact serialized bundle file');
const sceneById=new Map(scenes.sites.map(record=>[record.siteId,record]));
assert.equal(sceneById.size,scenes.sites.length,'Duplicate display terrain identities');
for(const site of bundle.sites){
  const record=sceneById.get(site.id);assert(record,`PRECONDITION: no own display mesh for ${site.id}`);
  for(const key of ['lat','lon','heightM','groundM'])assert.equal(record[key],site[key],`PRECONDITION: mesh observer ${site.id}/${key}`);
  assert.equal(record.positionFile,`terrain-${site.id}.mesh`,'Mesh file must name its actual site');
  const bytes=await readFile(resolve(root,'web/data',record.positionFile));
  assert.equal(bytes.length,record.byteLength,`PRECONDITION: ${site.id} mesh length`);
  assert.equal(digest(bytes),record.sha256,`PRECONDITION: ${site.id} mesh hash`);
}
const engine=await import(pathToFileURL(resolve(root,'web/engine.mjs')).href);
const {missionMetrics}=await import(pathToFileURL(resolve(root,'web/operations.mjs')).href);
const {communicationDemo}=await import(pathToFileURL(resolve(root,'web/overview.mjs')).href);
const {sceneFrame}=await import(pathToFileURL(resolve(root,'web/scene-model.mjs')).href);
const {farHorizonData}=await import(pathToFileURL(resolve(root,'web/scene3d.mjs')).href);
const {projectToMap,inspectCoordinate}=await import(pathToFileURL(resolve(root,'web/atlas.mjs')).href);
const atlas=await readJson('web/data/terrain-atlas.json');
const releaseDescriptor=await readJson('web/release.json').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
for(const site of bundle.sites){
  const p=projectToMap(site.lat,site.lon,atlas);
  assert(p.x>=13&&p.y>=13&&p.x<=atlas.display.width-13&&p.y<=atlas.display.height-13,`PRECONDITION: atlas clips ${site.id}`);
  const inspected=inspectCoordinate(bundle,atlas,site.lat,site.lon);
  assert.equal(inspected.siteId,site.id);assert.equal(inspected.insideMap,true);
}
const demoInputs=communicationDemo(bundle),demo=engine.runMission(bundle,demoInputs);
assert.deepEqual([demo.nominal.status,demo.delayed.status,demo.recommended?.status],['PASS','FAIL','PASS'],'Original real-data demonstration changed');
assert.equal(demo.delayed.start-demo.nominal.start,72*3600,'Original demonstration must retain its 72-hour delay');
assert.equal(demo.recommended.start,Date.parse('2026-11-17T03:00:00Z')/1000,'Original recommended start changed');
const work=resolve(process.env.LUNARIS_SOUTHPOLE_EVIDENCE_DIR??resolve(process.cwd(),'progress',`southpole-browser-${Date.now()}-${process.pid}`));
await mkdir(work,{recursive:true});
const evidence={status:'RUNNING',scope:'Actual packaged local data; no deployment or release publication is verified. Fresh Chrome documents, disabled HTTP cache and reduced-motion. Actual desktop orbital canvas pointer hits, all-site selector/atlas wiring, native mesh identity, clock and metric parity, comparison parity, original delay story, rapid-load last-selection wins. Mobile uses a 390 px desktop-browser viewport, not a physical phone. No scientific accuracy or graphics-performance certification.',root,siteIds:ids,releaseDescriptor,releaseIdentityScope:releaseDescriptor?.application_release_sha?'Local descriptor names a commit; no deployment is checked.':'Unstamped local preview; no public release SHA is asserted.',
  bundle:{bytes:source.length,fileSha256:digest(source),payloadSha256:bundle.manifest.bundleSha256},terrainManifestSha256:digest(await readFile(resolve(root,'web/data/terrain-scenes.json'))),
  viewports:[],failures:[]};
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.mesh':'application/octet-stream','.mp4':'video/mp4'};
const served=[];
const server=createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/favicon.ico'){res.writeHead(204).end();return;}
  const file=resolve(root,`.${pathname.endsWith('/')?pathname+'index.html':pathname}`);
  if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
  try{const bytes=await readFile(file);served.push({pathname,bytes:bytes.length});res.setHeader('Content-Type',mime[extname(file)]??'application/octet-stream');res.setHeader('Cache-Control','no-store');res.end(bytes);}
  catch(error){served.push({pathname,status:error.code==='ENOENT'?404:500});res.writeHead(error.code==='ENOENT'?404:500).end();}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`,url=origin+'/web/';
const executable=process.env.LUNARIS_CHROME??(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'chromium');
const pause=ms=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms));
async function until(action,label,timeoutMs=90000){
  const began=performance.now();let lastError,last;
  while(performance.now()-began<timeoutMs){try{last=await action();if(last)return last;}catch(error){lastError=error;}await pause(100);}
  throw Error(`Timed out: ${label}. Last value ${JSON.stringify(last)}. ${lastError?.message??''}`);
}
const canonicalInputs=saved=>{
  const f=saved.fields,num=id=>f[id]===''?null:Number(f[id]),time=id=>Date.parse(f[id]+'Z')/1000;
  return {siteId:f.site,nominal:time('nominal'),delayHours:num('delay'),durationHours:num('duration'),maxSunHours:num('max-sun'),maxEarthHours:num('max-earth'),
    minJointHours:num('min-total'),minContinuousJointHours:num('min-continuous'),earliest:time('earliest'),latest:time('latest'),gridMinutes:num('grid'),mode:saved.prelaunch?'prelaunch':'same-site'};
};
const measurements=(actual,expected,label)=>{
  assert.equal(actual.length,6,`${label}: six bounded environmental metrics`);
  for(const row of actual){const split=row.metric.indexOf('-'),channel=row.metric.slice(0,split),key=row.metric.slice(split+1);assert.deepEqual([row.lower,row.upper],expected[channel][key],`${label}: ${row.metric}`);}
};
try{
  for(const viewport of [{width:1440,height:1000,deviceScaleFactor:1,mobile:false},{width:390,height:840,deviceScaleFactor:1,mobile:false}]){
    const label=`${viewport.width}x${viewport.height}`,profile=resolve(work,'profile-'+label),hardware=process.argv.includes('--hardware-gpu');
    const flags=['--headless=new','--remote-debugging-port=0','--no-first-run','--disable-extensions','--disable-background-networking',`--user-data-dir=${profile}`,
      ...(!hardware?['--use-angle=swiftshader','--enable-unsafe-swiftshader']:[]),'about:blank'];
    const browser=spawn(executable,flags,{stdio:['ignore','ignore','pipe'],windowsHide:true});
    let socket,browserLog='',browserError;
    browser.stderr.on('data',chunk=>{browserLog=(browserLog+chunk).slice(-6000);});browser.on('error',error=>{browserError=error;});
    const report={viewport,flags,sites:[],orbitalPointerHits:[],comparisons:[],exceptions:[],failedRequests:[],consoleErrors:[],stage:'Chrome startup'};
    evidence.viewports.push(report);
    try{
      const port=(await until(()=>readFile(resolve(profile,'DevToolsActivePort'),'utf8'),`${label}: Chrome port; ${browserError?.message??''}`)).split(/\r?\n/)[0];
      const tabs=await fetch(`http://127.0.0.1:${port}/json/list`).then(response=>response.json());
      socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await once(socket,'open');
      let next=0;const callbacks=new Map(),requests=[];
      socket.addEventListener('message',({data})=>{
        const message=JSON.parse(data);
        if(message.method==='Network.requestWillBeSent')requests.push(message.params.request.url);
        if(message.method==='Runtime.exceptionThrown')report.exceptions.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text);
        if(message.method==='Runtime.consoleAPICalled'&&message.params.type==='error')report.consoleErrors.push(message.params.args.map(x=>x.value??x.description??x.type).join(' '));
        if(message.method==='Network.loadingFailed'&&!message.params.canceled)report.failedRequests.push({type:message.params.type,errorText:message.params.errorText});
        const callback=callbacks.get(message.id);if(callback){callbacks.delete(message.id);callback(message);}
      });
      const command=(method,params={})=>new Promise((yes,no)=>{
        const id=++next,timer=setTimeout(()=>{callbacks.delete(id);no(Error(`CDP timeout ${method}`));},120000);
        callbacks.set(id,message=>{clearTimeout(timer);message.error?no(Error(JSON.stringify(message.error))):yes(message.result);});socket.send(JSON.stringify({id,method,params}));
      });
      const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
      const inspect=()=>evaluate("import('/web/app.mjs').then(m=>m.inspectExperience())");
      const saved=()=>evaluate("import('/web/app.mjs').then(m=>m.captureOnboardingPlan())");
      const screenshot=async name=>{const result=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(resolve(work,`${label}-${name}.png`),Buffer.from(result.data,'base64'));};
      const assertCurrent=async id=>{
        const state=await evaluate(`({visual:document.querySelector('#visual-site').value,analyst:document.querySelector('#site').value,scene:document.querySelector('#scene-mount').dataset.site})`);
        assert.deepEqual(state,{visual:id,analyst:id,scene:id},`${label}: coherent selected site ${id}`);
        const snapshot=await inspect();assert.equal(snapshot.siteId,id);assert.equal(snapshot.contextSiteId,null);return snapshot;
      };
      const select=async id=>{
        await evaluate(`document.querySelector('#hero-pause').click();document.querySelector('#visual-site').value=${JSON.stringify(id)};document.querySelector('#visual-site').dispatchEvent(new Event('change'));`);
        await until(async()=>{const s=await inspect();return s?.siteId===id&&Number.isFinite(s.time)&&await evaluate(`document.querySelector('#site').value===${JSON.stringify(id)}&&!document.querySelector('#export').disabled`);},`${label}: select ${id}`);
        return assertCurrent(id);
      };
      const awaitOwnMesh=async id=>until(async()=>{
        const s=await inspect();if(s?.terrain.error)throw Error(`${id}: ${s.terrain.error}`);
        return s?.mode==='surface'&&s.siteId===id&&s.terrain.loaded&&s.terrain.siteId===id?s:null;
      },`${label}: own native mesh ${id}`);
      await command('Page.enable');await command('Runtime.enable');await command('Network.enable');await command('Network.setCacheDisabled',{cacheDisabled:true});
      await command('Emulation.setDeviceMetricsOverride',viewport);
      await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      const loadStart=performance.now();report.stage='Cold document and data load';
      await command('Page.navigate',{url});
      await until(()=>evaluate("document.querySelector('#export:not([disabled])')!==null&&document.querySelector('#visual-site:not([disabled])')!==null"),`${label}: app load`);
      await until(async()=>{const s=await inspect();return s?.webgl==='ready'&&s.renderedFrames>0&&s.moon.textured;},`${label}: actual textured WebGL scene`);
      report.coldReadyMs=performance.now()-loadStart;
      report.browser=await evaluate('navigator.userAgent');report.graphics=(await inspect()).graphics;
      const optionIds=await evaluate("({visual:[...document.querySelector('#visual-site').options].map(o=>o.value),analyst:[...document.querySelector('#site').options].map(o=>o.value),atlas:[...document.querySelectorAll('#map-sites .atlas-site-button')].map(o=>o.dataset.siteId)})");
      assert.deepEqual(optionIds.visual,ids);assert.deepEqual(optionIds.analyst,ids);
      await until(()=>evaluate(`document.querySelectorAll('#map-sites .atlas-site-button').length===${ids.length}`),`${label}: atlas source load`);
      assert.deepEqual(await evaluate("[...document.querySelectorAll('#map-sites .atlas-site-button')].map(o=>o.dataset.siteId)"),ids);
      await evaluate("document.querySelector('#start-delay-demo').click();document.querySelector('#hero-pause').click()");
      const phases=[];
      for(const role of ['nominal','delayed','recommended']){
        await evaluate(`document.querySelector('[data-story="${role}"]').click()`);
        const shown=await evaluate(`(()=>{const c=document.querySelector('[data-decision="${role}"]');return {start:Number(c.dataset.start),end:Number(c.dataset.end),status:c.querySelector('.decision-status').textContent}})()`);
        assert.equal(shown.start,demo[role].start);assert.equal(shown.end,demo[role].end);assert.equal(shown.status,demo[role].status);phases.push(shown);
      }
      assert.equal(phases[1].start-phases[0].start,72*3600);report.originalDelayStory=phases;
      await evaluate("document.querySelector('[data-story=nominal]').click();document.querySelector('#hero-pause').click();document.querySelector('#mode-surface').click()");
      await until(async()=>{const s=await inspect();return s?.mode==='surface';},`${label}: enter surface`);
      report.stage='Uncached rapid site-load race';const raceStart=performance.now();
      await evaluate(`(()=>{const q=document.querySelector('#visual-site');for(const id of ${JSON.stringify(ids)}){q.value=id;q.dispatchEvent(new Event('change'));}})()`);
      const last=ids.at(-1),race=await awaitOwnMesh(last);assert.equal(race.terrain.sha256,sceneById.get(last).sha256);await assertCurrent(last);
      report.rapidLoad={siteOrder:ids,lastSiteId:race.siteId,lastMeshSiteId:race.terrain.siteId,lastMeshSha256:race.terrain.sha256,observedMs:performance.now()-raceStart};
      for(const [index,site]of bundle.sites.entries()){
        report.stage=`Site ${index+1}/${ids.length}: ${site.id}`;console.log(`${label}: ${report.stage}`);const started=performance.now();
        await select(ids[(index+1)%ids.length]);
        await evaluate(`(()=>{const marker=document.querySelector('#site-map .map-marker[data-site-id="${site.id}"]');if(!marker)throw Error('Missing own atlas marker');marker.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`);
        await until(async()=>{const s=await inspect();return s?.siteId===site.id;},`${label}: atlas marker selection ${site.id}`);await assertCurrent(site.id);
        await evaluate(`document.querySelector('#map-sites .atlas-site-button[data-site-id="${site.id}"]').click();document.querySelector('#hero-pause').click();document.querySelector('#hero-scope-stay').click();document.querySelector('#hero-reset').click();document.querySelector('#product-explore').click();document.querySelector('#mode-surface').click()`);
        const frame=await awaitOwnMesh(site.id),record=sceneById.get(site.id),horizon=farHorizonData(site);
        assert.equal(frame.webgl,'ready');assert.equal(frame.terrain.sha256,record.sha256);assert.equal(frame.terrain.vertexCount,record.vertexCount);assert.equal(frame.terrain.indexCount,record.indexCount);
        assert.equal(frame.camera.position[1],site.heightM);assert.equal(frame.farHorizon.siteId,site.id);assert.equal(frame.farHorizonSectors,horizon.sectorCount);
        assert.equal(frame.farHorizon.rendered,horizon.sectorCount>0);assert.equal(frame.earth.textured,true);assert(frame.renderedFrames>0);
        const before=await saved(),inputs=canonicalInputs(before),expected=engine.evaluateStart(bundle,inputs,site.id,inputs.nominal);
        const actualMetrics=await evaluate("[...document.querySelectorAll('#live-telemetry [data-metric][data-lower]')].map(n=>({metric:n.dataset.metric,lower:Number(n.dataset.lower),upper:Number(n.dataset.upper)}))");
        measurements(actualMetrics,missionMetrics(expected,site),`${label} ${site.id}`);
        const chartTimes=await evaluate("({scene:Number(document.querySelector('#scene-mount').dataset.time),horizon:Number(document.querySelector('#local-sky').dataset.time),telemetry:Number(document.querySelector('#live-telemetry').dataset.time)})");
        assert.equal(chartTimes.scene,frame.time);assert.equal(chartTimes.horizon,frame.time);assert.equal(chartTimes.telemetry,frame.time);
        await evaluate("document.querySelector('#hero-time').value=1;document.querySelector('#hero-time').dispatchEvent(new Event('input'))");
        const moved=await until(async()=>{const s=await inspect();return s?.siteId===site.id&&s.time!==frame.time?s:null;},`${label}: deterministic time seek ${site.id}`);
        const after=await saved();assert.deepEqual(after.fields,before.fields,`${site.id}: seek cannot change mission inputs`);
        const sample=site.geometry.find(row=>row[0]===moved.time);assert(sample,`${site.id}: rendered time must identify an exact cached sample`);
        const authoritative=sceneFrame(site,sample,bundle.coverage);
        for(const [key,az,el]of [['sun',1,2],['earth',4,5]]){assert.equal(moved[key].azimuth,sample[az]);assert.equal(moved[key].elevation,sample[el]);assert.equal(moved[key].state,authoritative.states[key]);assert.equal(moved[key].visible,authoritative.states[key]==='visible');}
        const times=await evaluate("({scene:Number(document.querySelector('#scene-mount').dataset.time),horizon:Number(document.querySelector('#local-sky').dataset.time),telemetry:Number(document.querySelector('#live-telemetry').dataset.time),hero:document.querySelector('#hero-time').value,probe:document.querySelector('#probe-slider').value})");
        for(const key of ['scene','horizon','telemetry'])assert.equal(times[key],moved.time);assert.equal(times.hero,times.probe);
        report.sites.push({id:site.id,selectionRoutes:['visual selector','atlas SVG click event','atlas named button'],meshSha256:frame.terrain.sha256,farHorizonSectors:frame.farHorizonSectors,sampleUtc:moved.time,missionStatus:expected.status,observedMs:performance.now()-started});
      }
      if(viewport.width===1440){
        report.stage='Actual orbital canvas pointer selection';
        await evaluate("document.querySelector('#product-explore').click();document.querySelector('#mode-orbital').click();document.querySelector('#experience').scrollIntoView({block:'start',behavior:'instant'})");
        for(const [index,site]of bundle.sites.entries()){
          await select(ids[(index+1)%ids.length]);
          const projected=await evaluate(`(async()=>{const app=await import('/web/app.mjs'),vendor=await import('/web/vendor/three-bundle.mjs'),THREE=vendor.THREE??vendor;
            const state=app.inspectExperience();if(state.mode!=='orbital')throw Error('Orbital camera unavailable');const info=state.camera,[w,h]=info.canvasSize;
            const camera=new THREE.PerspectiveCamera(info.fov,w/h,.001,1000);camera.position.fromArray(info.position);camera.zoom=info.orbitalZoom;
            camera.lookAt(new THREE.Vector3().fromArray(info.position).add(new THREE.Vector3().fromArray(info.direction)));
            camera.setViewOffset(w,h,0,info.orbitalViewLiftPx,w,h);camera.updateProjectionMatrix();camera.updateMatrixWorld();
            const point=${JSON.stringify({lat:site.lat,lon:site.lon})},phi=point.lat*Math.PI/180,lam=point.lon*Math.PI/180;
            const world=new THREE.Vector3(Math.cos(phi)*Math.cos(lam),Math.sin(phi),-Math.cos(phi)*Math.sin(lam)).multiplyScalar(1.014);
            const facing=world.dot(camera.position.clone().sub(world))>0,ndc=world.clone().project(camera),canvas=document.querySelector('#scene-mount canvas'),rect=canvas.getBoundingClientRect();
            const x=rect.left+(ndc.x*.5+.5)*rect.width,y=rect.top+(-ndc.y*.5+.5)*rect.height,top=document.elementFromPoint(x,y);
            return {x,y,ndc:[ndc.x,ndc.y,ndc.z],facing,canvasHit:top===canvas,topElement:top?.id??top?.className??null,previousSite:state.siteId};})()`);
          assert(projected.facing&&projected.ndc[0]>-1&&projected.ndc[0]<1&&projected.ndc[1]>-1&&projected.ndc[1]<1,`${site.id}: orbital marker is not projectable from the focused neighboring site: ${JSON.stringify(projected)}`);
          assert(projected.canvasHit,`${site.id}: orbital marker is covered by another element: ${JSON.stringify(projected)}`);
          assert.notEqual(projected.previousSite,site.id,'A pointer test must actually change site identity');
          await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:projected.x,y:projected.y});
          await command('Input.dispatchMouseEvent',{type:'mousePressed',x:projected.x,y:projected.y,button:'left',buttons:1,clickCount:1});
          await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:projected.x,y:projected.y,button:'left',buttons:0,clickCount:1});
          await until(async()=>{const s=await inspect();return s?.siteId===site.id&&await evaluate(`document.querySelector('#visual-site').value===${JSON.stringify(site.id)}`);},`${site.id}: real orbital pointer hit`);
          await assertCurrent(site.id);report.orbitalPointerHits.push({id:site.id,from:projected.previousSite,x:projected.x,y:projected.y,method:'CDP real canvas mouse press/release, reconstructed live Three.js camera'});
        }
      }else report.orbitalPointerScope='Desktop actual-pointer results are tested separately; mobile selector/atlas/mesh/clock checks are required above.';
      report.stage='Comparison A/B direct-engine parity';
      await evaluate("document.querySelector('#product-compare').click()");
      const compareBase=canonicalInputs(await saved());
      for(const [index,site]of bundle.sites.entries()){
        const other=bundle.sites[(index+1)%ids.length],starts={A:compareBase.nominal,B:compareBase.nominal+3600};
        for(const [key,target]of [['A',site],['B',other]]){
          await evaluate(`(()=>{const s=document.querySelector('#comparison-site-${key}');s.value=${JSON.stringify(target.id)};s.dispatchEvent(new Event('change'));const d=document.querySelector('#comparison-arrival-${key}');d.value=${JSON.stringify(new Date(starts[key]*1000).toISOString().slice(0,19))};d.dispatchEvent(new Event('change'));})()`);
        }
        const cards=await evaluate("[...document.querySelectorAll('#option-comparison .option-card')].map(c=>({option:c.dataset.option,site:c.dataset.site,start:Number(c.dataset.start),end:Number(c.dataset.end),status:c.dataset.status,optionIds:[...c.querySelector('select').options].map(o=>o.value),metrics:[...c.querySelectorAll('[data-metric][data-lower]')].map(n=>({metric:n.dataset.metric,lower:Number(n.dataset.lower),upper:Number(n.dataset.upper)}))}))");
        for(const [key,target]of [['A',site],['B',other]]){const card=cards.find(c=>c.option===key);assert(card);assert.deepEqual(card.optionIds,ids);const expected=engine.evaluateStart(bundle,compareBase,target.id,starts[key]);assert.equal(card.site,target.id);assert.equal(card.start,expected.start);assert.equal(card.end,expected.end);assert.equal(card.status,expected.status);measurements(card.metrics,missionMetrics(expected,target),`${label} comparison ${key}/${target.id}`);}
        report.comparisons.push({A:site.id,B:other.id,starts});
      }
      const transfer=bundle.sites.at(-1),transferStart=compareBase.nominal;
      await evaluate(`(()=>{const q=document.querySelector('#comparison-site-A');q.value=${JSON.stringify(transfer.id)};q.dispatchEvent(new Event('change'));const d=document.querySelector('#comparison-arrival-A');d.value=${JSON.stringify(new Date(transferStart*1000).toISOString().slice(0,19))};d.dispatchEvent(new Event('change'));document.querySelector('#comparison-view-A').click();})()`);
      await until(async()=>{const s=await inspect();return s?.siteId===transfer.id;},`${label}: comparison-to-Mission transfer`);await assertCurrent(transfer.id);
      const transferInputs=canonicalInputs(await saved());assert.equal(transferInputs.siteId,transfer.id);assert.equal(transferInputs.nominal,transferStart);assert.equal(transferInputs.durationHours,compareBase.durationHours);
      report.comparisonTransfer={siteId:transfer.id,start:transferStart,durationHours:transferInputs.durationHours};
      await evaluate("document.querySelector('#product-explore').click();document.querySelector('#experience').scrollIntoView({block:'start',behavior:'instant'})");
      assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),`${label}: horizontal overflow in Mission`);
      await screenshot('mission');
      await evaluate("document.querySelector('#product-compare').click();scrollTo(0,0)");
      assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),`${label}: horizontal overflow in Compare`);
      await screenshot('compare');
      for(const id of ids)assert(requests.includes(new URL(sceneById.get(id).positionFile,new URL('data/',url)).href),`${label}: browser never requested own mesh ${id}`);
      const remote=requests.filter(request=>/^https?:/.test(request)&&!request.startsWith(origin+'/'));
      assert.deepEqual(remote,[],'Offline workflow attempted an external page request');assert.deepEqual(report.exceptions,[],'Browser runtime exceptions');assert.deepEqual(report.failedRequests,[],'Browser failed requests');assert.deepEqual(report.consoleErrors,[],'Browser console errors');
      report.stage='PASSED';report.networkRequestCount=requests.length;report.remoteRequests=remote;report.javascriptHeapBytes=await evaluate('performance.memory?.usedJSHeapSize??null');
      console.log(`${label}: all ${ids.length} sites, comparison parity and offline checks passed.`);
    }catch(error){report.stage+=' FAILED';report.error=error.stack??String(error);report.browserLog=browserLog;throw error;}
    finally{socket?.close();browser.kill();}
  }
  assert.deepEqual(served.filter(request=>request.status),[],'Local release contains missing or failed assets');
  evidence.status='PASSED';evidence.servedRequestCount=served.length;
}catch(error){evidence.status='FAILED';evidence.failures.push(error.stack??String(error));process.exitCode=1;console.error(error.stack??error);}
finally{server.close();evidence.servedRequestCount=served.length;evidence.localAssetFailures=served.filter(request=>request.status);evidence.servedBodyBytes=served.reduce((sum,request)=>sum+(request.bytes??0),0);await writeFile(resolve(work,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(`South-pole browser evidence: ${work}`);}
