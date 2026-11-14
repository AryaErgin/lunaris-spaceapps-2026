// Manual actual-data benchmark, deliberately outside the *.test.mjs unit glob.
// Run only after annual generation/CPU jobs finish:
//   node tests/test_extended_performance.mjs
// Defaults to reproducible software WebGL. Add --hardware-gpu for the installed
// browser's actual GPU; report the detected renderer rather than assume hardware.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {cpus,totalmem,platform,release,arch} from 'node:os';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';

const root=process.cwd(),raw=await readFile(resolve(root,'web/data/bundle.json'));
const bundle=JSON.parse(raw),start=Date.parse('2026-11-01T00:00:00Z')/1000,end=Date.parse('2028-01-01T00:00:00Z')/1000;
assert.deepEqual(bundle.coverage,[start,end],'This benchmark requires actual 426-day data; November-only fallback is not annual performance evidence.');
const work=resolve(root,'progress',`extended-performance-${Date.now()}`),hardwareRequested=process.argv.includes('--hardware-gpu');
await mkdir(work,{recursive:true});
const executable=process.env.LUNARIS_CHROME??(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'chromium');
const baseFlags=['--headless=new','--remote-debugging-port=0','--no-first-run','--disable-extensions','--disable-background-networking'];
const gpuFlags=hardwareRequested?[]:['--use-angle=swiftshader','--enable-unsafe-swiftshader'];
const cpu=cpus(),evidence={scope:'Local fresh-document, cache-disabled browser measurements; OS file cache and CPU scheduling are not controlled. No network throttling or physical mobile device.',
  environment:{node:process.version,os:platform(),osRelease:release(),arch:arch(),cpuModel:cpu[0]?.model,logicalCpuCount:cpu.length,totalMemoryBytes:totalmem(),
    browserFlags:[...baseFlags,...gpuFlags],hardwareGpuRequested:hardwareRequested},
  coverageUtc:bundle.coverage.map(t=>new Date(t*1000).toISOString()),siteIds:bundle.sites.map(s=>s.id),
  bundle:{bytes:raw.length,estimatedGzipBytes:gzipSync(raw).length,fileSha256:createHash('sha256').update(raw).digest('hex'),payloadSha256:bundle.manifest.bundleSha256},
  dataFiles:[],viewports:[],failures:[]};
for(const name of await readdir(resolve(root,'web/data'))){
  const path=resolve(root,'web/data',name),info=await stat(path);
  if(info.isFile())evidence.dataFiles.push({name,bytes:info.size});
}
const mime={'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const path=resolve(root,`.${pathname.endsWith('/')?pathname+'index.html':pathname}`);
  if(!path.startsWith(root+sep))return res.writeHead(403).end();
  try{res.setHeader('Content-Type',mime[extname(path)]??'application/octet-stream');res.end(await readFile(path));}
  catch{res.writeHead(404).end();}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`,url=origin+'/web/';
const sleep=ms=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms));
async function until(action,description,attempts=800){
  for(let index=0;index<attempts;index++){
    const value=await action().catch(()=>null);if(value)return value;await sleep(100);
  }
  throw Error('Timed out: '+description);
}

try{
  for(const viewport of [{width:1366,height:768,deviceScaleFactor:1,mobile:false},{width:390,height:840,deviceScaleFactor:1,mobile:false}]){
    const name=viewport.width+'x'+viewport.height,profile=resolve(work,'profile-'+name);
    const browser=spawn(executable,[...baseFlags,...gpuFlags,`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
    let browserLog='',socket;
    browser.stderr.on('data',chunk=>{browserLog=(browserLog+chunk).slice(-4000);});
    try{
      const port=(await until(()=>readFile(resolve(profile,'DevToolsActivePort'),'utf8'),'Chrome DevTools port')).split(/\r?\n/)[0];
      const tabs=await fetch(`http://127.0.0.1:${port}/json/list`).then(response=>response.json());
      socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await once(socket,'open');
      let id=0;const pending=new Map(),exceptions=[],requests=[];
      socket.addEventListener('message',({data})=>{
        const message=JSON.parse(data);
        if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text);
        if(message.method==='Network.requestWillBeSent')requests.push(message.params.request.url);
        if(pending.has(message.id)){pending.get(message.id)(message);pending.delete(message.id);}
      });
      const command=(method,params={})=>new Promise((resolveCommand,reject)=>{
        const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout '+method));},120000);
        pending.set(key,message=>{clearTimeout(timer);message.error?reject(Error(JSON.stringify(message.error))):resolveCommand(message.result);});
        socket.send(JSON.stringify({id:key,method,params}));
      });
      const evaluate=async expression=>{
        const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
        if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
        return result.result.value;
      };
      const inspect=()=>evaluate("import('/web/app.mjs').then(module=>module.inspectExperience())");
      const screenshot=async suffix=>{
        const result=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await writeFile(resolve(work,name+'-'+suffix+'.png'),Buffer.from(result.data,'base64'));
      };
      await command('Network.enable');await command('Network.setCacheDisabled',{cacheDisabled:true});
      await command('Page.enable');await command('Runtime.enable');await command('Performance.enable');
      await command('Emulation.setDeviceMetricsOverride',viewport);
      await command('Page.navigate',{url});
      await until(()=>evaluate("!document.querySelector('#export').disabled"),'application environmental record ready');
      const appReadyObservedMs=await evaluate('performance.now()');
      await until(async()=>{const scene=await inspect();return scene?.moon.textured&&scene.renderedFrames>0;},'actual textured Moon render');
      const firstScene=await inspect(),coldSceneReadyObservedMs=await evaluate('performance.now()');
      if(await evaluate("!document.querySelector('#quick-tour').hidden"))await evaluate("document.querySelector('.quick-tour-close').click()");
      const report={viewport,browser:await command('Browser.getVersion'),appReadyObservedMs,coldSceneReadyObservedMs,
        initialGraphics:firstScene.graphics,initialRenderedFrames:firstScene.renderedFrames,initialGpuResources:firstScene.gpuResources,
        coldResourceEntries:await evaluate("performance.getEntriesByType('resource').map(r=>({path:new URL(r.name).pathname,transferBytes:r.transferSize,encodedBytes:r.encodedBodySize,durationMs:r.duration}))"),
        firstFold:await evaluate("({noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth,findActionBottom:document.querySelector('#find-opportunities').getBoundingClientRect().bottom,viewportHeight:innerHeight})")};
      assert(report.firstFold.noHorizontalOverflow);await screenshot('orbital');
      report.jsonParse=await evaluate(`fetch('/web/data/bundle.json').then(response=>response.text()).then(text=>{
        const measurements=[];for(let i=0;i<5;i++){const before=performance.now(),parsed=JSON.parse(text);measurements.push(performance.now()-before);if(parsed.sites.length!==${bundle.sites.length})throw Error('Parse content mismatch');}
        const sorted=[...measurements].sort((a,b)=>a-b);return {iterations:5,measurementsMs:measurements,minimumMs:sorted[0],medianMs:sorted[2],meanMs:measurements.reduce((a,b)=>a+b)/5};
      })`);
      const target=bundle.sites.at(-1),time=Date.parse('2027-07-01T06:00:00Z')/1000;
      const previousFrame=(await inspect()).renderedFrames,changeStarted=await evaluate('performance.now()');
      await evaluate(`document.querySelector('#visual-site').value=${JSON.stringify(target.id)};document.querySelector('#visual-site').dispatchEvent(new Event('change'));document.querySelector('#visual-arrival').value='2027-07-01T06:00:00';document.querySelector('#visual-date-go').click()`);
      await until(async()=>{const scene=await inspect();return scene.siteId===target.id&&scene.time===time&&scene.renderedFrames>previousFrame;},'2027 inputs and actual render');
      report.siteDateChangeObservedMs=await evaluate('performance.now()')-changeStarted;
      const surfaceStarted=await evaluate('performance.now()');
      await evaluate("document.querySelector('#explore-site').click()");
      await until(async()=>{const scene=await inspect();return scene.mode==='surface'&&scene.terrain.loaded&&scene.terrain.siteId===target.id&&scene.earth.textured;},'actual lazy-loaded surface terrain');
      report.surfaceReadyObservedMs=await evaluate('performance.now()')-surfaceStarted;
      report.surface=await inspect();await evaluate("document.querySelector('#focus-terrain').click();scrollTo(0,0)");await screenshot('surface');
      const fullCacheStarted=await evaluate('performance.now()');
      await evaluate("document.querySelector('#hero-scope-month').click()");
      report.fullCacheScopeObservedMs=await evaluate('performance.now()')-fullCacheStarted;
      report.fullCacheSampleCount=Number(await evaluate("document.querySelector('#hero-time').max"))+1;
      assert.equal(report.fullCacheSampleCount,426*48);
      // Count completed renderer.render calls, not requestAnimationFrame callbacks.
      // Playback is an active workload; idle rendering intentionally stops.
      report.activePlayback=[];
      for(const mode of ['orbital','surface']){
        await evaluate(`document.querySelector('#mode-${mode}').click();document.querySelector('#hero-time').value=0;document.querySelector('#hero-time').dispatchEvent(new Event('input'));document.querySelector('#hero-speed').value=48;document.querySelector('#hero-speed').dispatchEvent(new Event('change'))`);
        const before=await inspect(),beforeTime=await evaluate('performance.now()');
        await evaluate("document.querySelector('#hero-play').click()");await sleep(5000);
        await evaluate("document.querySelector('#hero-pause').click()");
        const after=await inspect(),elapsedMs=await evaluate('performance.now()')-beforeTime,frames=after.renderedFrames-before.renderedFrames;
        assert(frames>0&&after.time>before.time,mode+' active playback must render and advance actual time');
        report.activePlayback.push({mode,workload:'Full-cache playback,48 actual half-hour samples per real second',elapsedMs,renderedFrameCount:frames,
          renderedFramesPerSecond:frames/(elapsedMs/1000),fromUtc:new Date(before.time*1000).toISOString(),toUtc:new Date(after.time*1000).toISOString(),
          renderer:after.graphics.renderer,trianglesAtEnd:after.triangles,gpuResources:after.gpuResources});
      }
      await evaluate("document.querySelector('#hero-scope-stay').click();document.querySelector('#visual-arrival').value='2027-07-01T06:00:00';document.querySelector('#visual-date-go').click()");
      const searchStarted=await evaluate('performance.now()');await evaluate("document.querySelector('#find-opportunities').click()");
      await until(()=>evaluate("document.querySelector('#landing-opportunities').getAttribute('aria-busy')==='false'&&!document.querySelector('#landing-opportunities').hidden"),'actual 30-day three-or-more-site opportunity search');
      report.opportunitySearch={observedMs:await evaluate('performance.now()')-searchStarted,
        ...await evaluate("({kind:document.querySelector('#landing-opportunities').dataset.kind,conclusion:document.querySelector('#opportunities-status').textContent,basis:document.querySelector('#opportunities-basis').textContent,counts:document.querySelector('#opportunities-counts').textContent,optionCount:document.querySelectorAll('#opportunity-options article').length})")};
      assert(['VISIBILITY_FOUND','NO_JOINT','UNRESOLVED'].includes(report.opportunitySearch.kind));
      report.browserMetrics=(await command('Performance.getMetrics')).metrics;
      report.noUncaughtExceptions=exceptions.length===0;assert.deepEqual(exceptions,[]);
      report.noExternalRequests=requests.every(request=>!/^https?:/.test(request)||request.startsWith(origin+'/'));assert(report.noExternalRequests);
      await evaluate("document.querySelector('#product-compare').click();scrollTo(0,0)");await screenshot('compare');
      evidence.viewports.push(report);
      await writeFile(resolve(work,'report.json'),JSON.stringify(evidence,null,2));
    }catch(error){
      evidence.failures.push({viewport,message:error.stack??String(error),browserLog});
      await writeFile(resolve(work,'report.json'),JSON.stringify(evidence,null,2));throw error;
    }finally{socket?.close();browser.kill();}
  }
  console.log(`Actual annual-data performance evidence: ${work}`);
}finally{server.close();}
