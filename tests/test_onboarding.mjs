// Real-browser onboarding regression. Run separately from the GPU experience suite.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';

const root=process.cwd(),work=resolve(root,'progress',`onboarding-${Date.now()}`);
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
const profile=resolve(work,'chrome-profile');
const browser=spawn(process.env.LUNARIS_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--no-first-run',
  '--disable-extensions','--disable-background-networking','--use-angle=swiftshader','--enable-unsafe-swiftshader','about:blank'
],{stdio:['ignore','ignore','pipe']});
let browserLog='';browser.stderr.on('data',chunk=>{browserLog=(browserLog+chunk).slice(-2000);});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label='browser prerequisite',attempts=300){
  for(let i=0;i<attempts;i++){const value=await fn().catch(()=>null);if(value)return value;await sleep(100);}
  throw Error(label+' timed out. '+browserLog);
}
let socket,recordFailure;
try{
  const port=(await until(()=>readFile(resolve(profile,'DevToolsActivePort'),'utf8'))).split(/\r?\n/)[0];
  const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await once(socket,'open');
  let id=0;const pending=new Map(),exceptions=[],requests=[];
  socket.addEventListener('message',({data})=>{
    const message=JSON.parse(data);
    if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text);
    if(message.method==='Network.requestWillBeSent')requests.push(message.params.request.url);
    if(pending.has(message.id)){pending.get(message.id)(message);pending.delete(message.id);}
  });
  const command=(method,params={})=>new Promise((resolveCommand,reject)=>{
    const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout '+method));},30000);
    pending.set(key,message=>{clearTimeout(timer);message.error?reject(Error(JSON.stringify(message.error))):resolveCommand(message.result);});
    socket.send(JSON.stringify({id:key,method,params}));
  });
  const evaluate=async expression=>{
    const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
    return result.result.value;
  };
  const screenshot=async name=>{
    const result=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(resolve(work,name+'.png'),Buffer.from(result.data,'base64'));
  };
  recordFailure=async()=>{
    await screenshot('failure');
    const state=await evaluate("(()=>{const p=document.querySelector('#quick-tour'),n=document.querySelector('.quick-tour-next'),r=n?.getBoundingClientRect();return {step:p?.dataset.step,title:document.querySelector('#quick-tour-title')?.textContent,description:document.querySelector('#quick-tour-description')?.textContent,feedback:document.querySelector('#quick-tour-feedback')?.textContent,next:n?.textContent,panelRect:p?.getBoundingClientRect().toJSON(),panelStyle:p?{left:p.style.left,top:p.style.top,display:getComputedStyle(p).display,visibility:getComputedStyle(p).visibility,position:getComputedStyle(p).position}:null,parents:p?[...function*(el){for(;el;el=el.parentElement)yield el.id||el.tagName}(p)]:[],actionRect:r?.toJSON(),hit:r?document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.outerHTML.slice(0,250):null,scene:Object.assign({},document.querySelector('#scene-mount')?.dataset),scrollY,viewport:[innerWidth,innerHeight],active:document.activeElement?.id}})()");
    await writeFile(resolve(work,'failure.json'),JSON.stringify(state,null,2));console.error(state);
  };
  const click=async selector=>{
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({behavior:'instant',block:'nearest'})`);
    await sleep(100);
    const point=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,clear:!n.disabled&&r.width>0&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=document.documentElement.clientWidth+1&&n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};})()`);
    if(!point.clear)await screenshot('obscured-'+selector.replace(/[^a-z0-9]/gi,'-'));
    assert(point.clear,selector+' must be visible and unobscured.');
    await command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
  };
  const plan=()=>evaluate("JSON.stringify(Object.fromEntries(['visual-site','visual-arrival','visual-duration','max-sun','max-earth','min-total','min-continuous','earliest','latest','grid'].map(id=>[id,document.getElementById(id)?.value])))");
  const step=()=>evaluate("document.querySelector('#quick-tour')?.dataset.step");
  const next=async()=>{
    await until(()=>evaluate("!document.querySelector('.quick-tour-next').disabled"),'enabled guide action');
    await click('.quick-tour-next');await sleep(100);
    await until(()=>evaluate("document.querySelector('#quick-tour').hidden||document.querySelector('#quick-tour').getAttribute('aria-busy')!=='true'"),'completed guide action');
  };
  const visit=async target=>{
    for(let tries=0;tries<40;tries++){
      if(await step()===target)return;
      await next();
      const stalled=await evaluate("(()=>{const p=document.querySelector('#quick-tour'),f=document.querySelector('#quick-tour-feedback');return p.getAttribute('aria-busy')!=='true'&&p.dataset.step!=='opportunities'&&p.dataset.inspected!==p.dataset.step&&!f.hidden?f.textContent:null})()");
      if(stalled)throw Error('Guided action could not advance: '+stalled);
    }
    throw Error(`Could not reach ${target}; at ${await step()}`);
  };
  const ready=()=>until(()=>evaluate("!!document.querySelector('#export:not([disabled])')"),'science ready');
  const visibleTour=()=>evaluate("!document.querySelector('#quick-tour').hidden&&document.querySelector('#quick-tour').getClientRects().length>0");
  const desktop={width:1366,height:768,deviceScaleFactor:1,mobile:false};
  await command('Page.enable');await command('Runtime.enable');await command('Network.enable');
  await command('Emulation.setDeviceMetricsOverride',desktop);await command('Page.navigate',{url});
  await ready();await until(visibleTour,'first-visit onboarding offer');
  assert.equal(await step(),'welcome');
  const coldPlan=await plan();await screenshot('first-visit-desktop');
  await click('.quick-tour-close');
  assert(await evaluate("localStorage.getItem('lunaris:onboarding:v2')!==null"),'Dismissing the offer must be remembered.');
  assert.equal(await plan(),coldPlan,'Offering or dismissing onboarding must not change mission inputs.');
  await command('Page.reload');await ready();await sleep(400);
  assert(await evaluate("document.querySelector('#quick-tour').hidden"),'A dismissed first-visit offer must not interrupt on reload.');

  // Replay with a real custom plan: no implicit preset load, including Back and exit.
  await evaluate("document.querySelector('#visual-arrival').value='2026-11-18T06:00:00';document.querySelector('#visual-duration').value='24';document.querySelector('#visual-arrival').dispatchEvent(new Event('change'));document.querySelector('#visual-duration').dispatchEvent(new Event('change'))");
  const chosenPlan=await plan();
  await click('#tour-start');await visit('demo-consent');
  assert.equal(await plan(),chosenPlan,'Explaining controls must not replace a visitor’s plan.');
  await screenshot('demonstration-consent-desktop');
  await click('#quick-tour-keep-plan');
  await until(async()=>await step()==='compare','keep-plan comparison route');
  assert.equal(await plan(),chosenPlan,'Declining the example must preserve all mission inputs.');
  await click('.quick-tour-back');
  assert.equal(await step(),'demo-consent','Back after keeping the visitor plan must return to consent, not invent an unloaded recovery.');
  await click('#quick-tour-keep-plan');
  await click('.quick-tour-close');assert.equal(await plan(),chosenPlan);

  // The explicit demonstration is driven by real application actions and results.
  await click('#tour-start');await visit('demo-consent');await click('#start-delay-demo');
  await until(async()=>await step()==='nominal','consented example');
  await until(()=>evaluate("document.querySelector('#story-status').textContent==='PASS'"),'original PASS');
  assert.equal(await evaluate("document.querySelector('#visual-duration').value"),'12');
  assert.match(await evaluate("document.querySelector('#story-joint').textContent"),/7 h 53 min 52 s/);
  await screenshot('original-pass-desktop');
  await visit('delay');
  await until(()=>evaluate("document.querySelector('#story-status').textContent==='FAIL'&&document.querySelector('#rescue-transition').hidden"),'delayed FAIL');
  assert.match(await evaluate("document.querySelector('#story-explanation').textContent"),/12 hours.*7 hours.*5 hours too long/);
  await screenshot('delayed-fail-desktop');
  await visit('recovery');
  await until(()=>evaluate("document.querySelector('#story-status').textContent==='PASS'&&document.querySelector('#story-date').textContent.includes('17 Nov')"),'recovered PASS');
  assert.match(await evaluate("document.querySelector('#story-joint').textContent"),/12 d 21 h/);
  const recoveredPlan=await plan();await screenshot('recovered-pass-desktop');
  await click('.quick-tour-back');await next();
  assert.equal(await plan(),recoveredPlan,'Back/Next through completed explanation must not replay the delay or reset recovered inputs.');
  await visit('compare');
  assert(await evaluate("!document.querySelector('#compare-workspace').hidden"));
  await evaluate("document.querySelector('#comparison-arrival-B').value='2026-11-19T06:00:00';document.querySelector('#comparison-arrival-B').dispatchEvent(new Event('change'))");
  await screenshot('compare-desktop');
  await visit('opportunities');
  await next();
  await until(()=>evaluate("!document.querySelector('#landing-opportunities').hidden&&!['SEARCHING','ERROR',''].includes(document.querySelector('#landing-opportunities').dataset.kind||'')"),'independent opportunity search');
  await screenshot('opportunities-desktop');
  await visit('locations');
  assert(await evaluate("document.querySelector('#any-site').open"));
  await evaluate("document.querySelector('#any-site-select').value='apollo-11';document.querySelector('#any-site-select').dispatchEvent(new Event('change'))");
  assert.match(await evaluate("document.querySelector('#any-site-result').textContent"),/Apollo 11/);
  await screenshot('other-locations-desktop');
  await visit('advanced');
  assert(await evaluate("!document.querySelector('#top').hidden"));await screenshot('advanced-desktop');
  await visit('finish');await next();
  assert(await evaluate("document.querySelector('#quick-tour').hidden&&!document.querySelector('.quick-tour-target')"));
  await click('#tour-start');await click('#quick-tour-restore');
  await until(()=>evaluate("document.querySelector('#quick-tour').hidden"),'saved plan restored');
  assert(await evaluate("document.querySelector('#quick-tour').hidden"),'Restoring the saved plan must close the tour.');
  assert.equal(await plan(),chosenPlan,'Restoring the saved plan must recover the exact pre-demonstration mission and search inputs.');

  // Globe context markers are real selection controls, not terrain-aware study sites.
  await evaluate("document.querySelector('#product-explore').click();document.querySelector('#mode-orbital').click();document.querySelector('#reset-orbit').click()");
  await until(()=>evaluate("document.querySelectorAll('.mission-context-marker').length===9"),'curated orbital markers');
  const beforeContext=await plan();
  await until(()=>evaluate("document.querySelector('.mission-context-marker[data-context-site=\"apollo-11\"]')?.getClientRects().length>0"),'near-side Apollo marker');
  await click('.mission-context-marker[data-context-site="apollo-11"]');
  await until(()=>evaluate("document.querySelector('#any-site-select').value==='apollo-11'"),'marker synchronizes level-horizon explorer');
  assert.equal(await plan(),beforeContext,'A historical marker must not change or borrow a terrain-aware mission.');
  assert.match(await evaluate("document.querySelector('#any-site-result').textContent"),/Apollo 11/);
  assert(await evaluate("document.querySelector('#any-site').textContent.includes('Level-horizon geometry only')"));
  await screenshot('orbital-apollo-context');
  await evaluate("document.querySelector('#any-site-select').value='change-4';document.querySelector('#any-site-select').dispatchEvent(new Event('change'))");
  await until(()=>evaluate("import('/web/app.mjs').then(m=>m.inspectExperience()?.contextSiteId==='change-4')"),'far-side context selection');
  await evaluate("document.querySelector('#scene-mount').scrollIntoView({behavior:'instant',block:'start'})");
  await until(()=>evaluate("document.querySelector('.mission-context-marker[data-context-site=\"change-4\"]')?.getClientRects().length>0"),'far-side context marker after camera focus');
  await until(()=>evaluate("document.querySelector('.mission-context-marker[data-context-site=\"apollo-11\"]').hidden"),'opposite-side marker after camera transition');
  assert(await evaluate("document.querySelector('.mission-context-marker[data-context-site=\"apollo-11\"]').hidden"),'Opposite-side markers must be hidden behind the globe.');
  await screenshot('orbital-international-context');
  await evaluate("document.querySelector('#any-site-lat').value='10';document.querySelector('#any-site-lat').dispatchEvent(new Event('input'))");
  await until(()=>evaluate("import('/web/app.mjs').then(m=>m.inspectExperience()?.contextSiteId===null)"),'custom coordinate clears context selection');
  assert.equal(await plan(),beforeContext,'Custom level-horizon exploration must preserve the terrain-aware mission.');

  // Mobile, reduced-motion, keyboard close, and repeated visit behavior.
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:840,deviceScaleFactor:1,mobile:false});
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await evaluate("document.querySelector('#product-explore').click()");await click('#tour-start');
  await visit('site');await screenshot('site-mobile');
  await evaluate("document.querySelector('#visual-site').focus()");
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert(await evaluate("document.activeElement.matches('.quick-tour-close')"),'Tab from the highlighted control must reach tour navigation.');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',modifiers:8,windowsVirtualKeyCode:9});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',modifiers:8,windowsVirtualKeyCode:9});
  assert.equal(await evaluate('document.activeElement.id'),'visual-site','Shift+Tab must return to the actual highlighted control.');
  await visit('playback');await screenshot('playback-mobile');
  await visit('demo-consent');await screenshot('consent-mobile');
  await click('#quick-tour-keep-plan');await until(async()=>await step()==='compare');
  await screenshot('compare-mobile');
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'Mobile onboarding must not create horizontal overflow.');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert(await evaluate("document.querySelector('#quick-tour').hidden&&document.activeElement.id==='tour-start'"),'Escape must close the guide and restore focus.');

  // No-WebGL path must provide actionable alternatives rather than disabling Next.
  await command('Page.addScriptToEvaluateOnNewDocument',{source:"const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /webgl/i.test(type)?null:original.call(this,type,...args)}"});
  await command('Page.reload');await ready();await click('#tour-start');await visit('views');
  await screenshot('fallback-mobile');await visit('demo-consent');await next();
  await visit('delay');await until(()=>evaluate("document.querySelector('#story-status').textContent==='FAIL'"),'fallback delayed evidence');
  await visit('recovery');await until(()=>evaluate("document.querySelector('#story-status').textContent==='PASS'"),'fallback recovery evidence');
  await click('.quick-tour-close');
  assert.deepEqual(exceptions,[],'Onboarding must not throw uncaught JavaScript errors.');
  assert.deepEqual(requests.filter(request=>request.startsWith('http')&&!request.startsWith(origin+'/')),[],'The tour must retain offline operation.');
  await writeFile(resolve(work,'verification.json'),JSON.stringify({viewports:[[1366,768],[390,840]],firstVisitOffer:true,rememberedDismissal:true,replay:true,customInputsPreserved:true,consentRequired:true,declinePreservesPlan:true,actualMissionStates:['PASS','FAIL','PASS'],independentOpportunitySearch:true,keyboardEscape:true,reducedMotion:true,noWebGL:true,noExternalRuntimeRequests:true,humanComprehensionTest:false,browser:await command('Browser.getVersion')},null,2));
  console.log(`Onboarding browser regression passed. Evidence: ${work}`);
}catch(error){
  await recordFailure?.().catch(()=>{});
  console.error(error);throw error;
}finally{socket?.close();browser.kill();server.close();}
