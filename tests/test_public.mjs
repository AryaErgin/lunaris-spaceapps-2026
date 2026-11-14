import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const url=process.argv[2]??'https://aryaergin.github.io/lunaris-spaceapps-2026/';
const expectedSha=process.argv[3];
const work=resolve('progress',`public-${Date.now()}`);await mkdir(work,{recursive:true});
const release=await fetch(new URL('release.json',url)).then(r=>{assert.equal(r.status,200);return r.json();});
if(expectedSha)assert.equal(release.application_release_sha,expectedSha);
const bundle=await fetch(new URL('data/bundle.json',url)).then(r=>{assert.equal(r.status,200);return r.json();});
assert.equal(bundle.sites.length,3);
assert.equal((await fetch(new URL('data/terrain-atlas.png',url))).status,200);
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
  let id=0;const callbacks=new Map(),errors=[];
  socket.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(callbacks.has(m.id)){callbacks.get(m.id)(m);callbacks.delete(m.id);}});
  const command=(method,params={})=>new Promise((ok,no)=>{const key=++id;callbacks.set(key,m=>m.error?no(Error(JSON.stringify(m.error))):ok(m.result));socket.send(JSON.stringify({id:key,method,params}));});
  const evaluate=async(expression,userGesture=false)=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
  const screenshot=async name=>{const r=await command('Page.captureScreenshot',{format:'png'});await writeFile(resolve(work,name+'.png'),Buffer.from(r.data,'base64'));};
  await command('Page.enable');await command('Runtime.enable');await command('Network.enable');
  await command('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false});
  await command('Page.navigate',{url});await until(()=>evaluate("!!document.querySelector('#export:not([disabled])')"));
  assert.equal(await evaluate('location.href'),url,'Public app must not redirect to authentication.');
  const guided=await evaluate("!!document.querySelector('#story-next')");
  if(await evaluate("document.querySelector('#apply-requirements')?.checked===false")){
    assert(await evaluate("document.querySelector('#story-status').hidden&&document.querySelector('#environment-overview').childElementCount>0"));
    await screenshot('anonymous-environment-desktop');
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
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:840,deviceScaleFactor:1,mobile:false});
  await evaluate('scrollTo(0,0)');await screenshot('anonymous-mobile');
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await command('Page.addScriptToEvaluateOnNewDocument',{source:"const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /webgl/i.test(type)?null:original.call(this,type,...args)}"});
  await command('Page.navigate',{url});await until(()=>evaluate("!!document.querySelector('#export:not([disabled])')"));
  if(guided)await until(()=>evaluate("document.querySelector('#scene-status').textContent.includes('3D graphics unavailable')"));
  await screenshot('anonymous-no-webgl');assert.deepEqual(errors,[]);
  await command('Page.navigate',{url:new URL('demo.html',url).href});
  await until(()=>evaluate("document.querySelector('video')?.readyState>=1"));
  const video=await evaluate("(()=>{const v=document.querySelector('video');return {duration:v.duration,width:v.videoWidth,height:v.videoHeight}})()");
  assert.equal(video.duration,29);assert.deepEqual([video.width,video.height],[1366,900]);
  await evaluate("document.querySelector('video').play()",true);
  await until(()=>evaluate("document.querySelector('video').currentTime>0.15"));
  await evaluate("document.querySelector('video').pause();document.querySelector('video').currentTime=27");
  await until(()=>evaluate("!document.querySelector('video').seeking&&document.querySelector('video').readyState>=2"));
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
  await screenshot('anonymous-demo-mobile');assert.deepEqual(errors,[]);
  const version=await command('Browser.getVersion');
  await writeFile(resolve(work,'verification.json'),JSON.stringify({url,release,states,anonymous:true,demo:video,viewports:[[1366,768],[390,840]],browser:version,physicalSecondDevice:false},null,2));
  console.log(`Public anonymous deployment verified: ${url} SHA ${release.application_release_sha}; JSON/PNG, refresh, PASS/FAIL/PASS, downloaded certificates, mobile emulation and JavaScript-without-WebGL passed. Evidence: ${work}`);
}finally{socket?.close();browser.kill();}
