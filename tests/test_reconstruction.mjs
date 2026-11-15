// Product-layout regression, distinct from scientific and onboarding suites.
// --baseline records the starting design and its failed acceptance gates without
// claiming they pass. Normal mode enforces the cinematic composition contract.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {runMission} from '../web/engine.mjs';
import {communicationDemo} from '../web/overview.mjs';

const baseline=process.argv.includes('--baseline');
const layoutOnly=process.argv.includes('--layout-only');
const root=process.cwd(),work=resolve(root,'.operator',`reconstruction-${baseline?'before':'after'}-${Date.now()}-${process.pid}`);
await mkdir(work,{recursive:true});
const bundle=JSON.parse(await readFile(resolve(root,'web/data/bundle.json'),'utf8'));
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.jpg':'image/jpeg','.png':'image/png','.woff2':'font/woff2'};
const server=createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const path=resolve(root,`.${pathname.endsWith('/')?pathname+'index.html':pathname}`);
  if(!path.startsWith(root+sep))return res.writeHead(403).end();
  try{res.setHeader('Content-Type',mime[extname(path)]??'application/octet-stream');res.end(await readFile(path));}
  catch{res.writeHead(404).end();}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`,url=origin+'/web/';
const profile=resolve(work,'chrome-profile');
const browser=spawn(process.env.LUNARIS_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--no-first-run',
  '--disable-extensions','--disable-background-networking','--use-angle=swiftshader','--enable-unsafe-swiftshader','about:blank'
],{stdio:['ignore','ignore','pipe']});
let browserLog='',socket,recordFailure;
browser.stderr.on('data',chunk=>{browserLog=(browserLog+chunk).slice(-1600);});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label='browser prerequisite',attempts=300){
  for(let i=0;i<attempts;i++){const value=await fn().catch(()=>null);if(value)return value;await sleep(100);}
  throw Error(label+' timed out. '+browserLog);
}
const evidence={baseline,layoutOnly,viewports:[],failedGates:[],fontEvidence:[],missionStates:[],exceptions:[],limitations:['Mobile and 200% checks use CSS viewport emulation, not physical phones or native browser zoom.','Software WebGL renders the same assets; its frame rate does not represent hardware GPU performance.','Automated usability checks are not an uncoached human-comprehension study.']};
function gate(condition,message,details){if(!condition)evidence.failedGates.push({message,details});}
try{
  const port=(await until(()=>readFile(resolve(profile,'DevToolsActivePort'),'utf8'))).split(/\r?\n/)[0];
  const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await once(socket,'open');
  let id=0;const pending=new Map();
  socket.addEventListener('message',({data})=>{
    const message=JSON.parse(data);
    if(message.method==='Runtime.exceptionThrown')evidence.exceptions.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text);
    if(pending.has(message.id)){pending.get(message.id)(message);pending.delete(message.id);}
  });
  const command=(method,params={})=>new Promise((ok,no)=>{
    const key=++id,timer=setTimeout(()=>{pending.delete(key);no(Error('CDP timeout '+method));},30000);
    pending.set(key,m=>{clearTimeout(timer);m.error?no(Error(JSON.stringify(m.error))):ok(m.result);});
    socket.send(JSON.stringify({id:key,method,params}));
  });
  const evaluate=async expression=>{
    const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
    return result.result.value;
  };
  const inspect=()=>evaluate("import('/web/app.mjs').then(m=>m.inspectExperience())");
  const screenshot=async(name,full=false)=>{
    let clip;
    if(full){const {cssContentSize}=await command('Page.getLayoutMetrics');clip={x:0,y:0,width:cssContentSize.width,height:Math.min(cssContentSize.height,14000),scale:1};}
    const result=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:full,...(clip?{clip}:{})});
    await writeFile(resolve(work,name+'.png'),Buffer.from(result.data,'base64'));
  };
  recordFailure=async()=>{
    evidence.failureScene=await inspect().catch(()=>null);
    evidence.failureDom=await evaluate("({scene:{...document.querySelector('#scene-mount').dataset},status:document.querySelector('#scene-status').textContent,viewButtons:[...document.querySelectorAll('.scene-mode-switch button')].map(n=>({id:n.id,pressed:n.getAttribute('aria-pressed'),disabled:n.disabled}))})").catch(()=>null);
    await screenshot('failure').catch(()=>{});await writeFile(resolve(work,'verification.json'),JSON.stringify(evidence,null,2));
  };
  const metrics=()=>evaluate(`(()=>{
    const ids=['visual-site','visual-arrival','visual-duration','story-title','find-opportunities','explore-site','mode-orbital','mode-surface','night-visibility','focus-earth','focus-sun','focus-terrain','scene-coordinate-caption','hero-play','hero-pause','hero-reset','hero-time','scene-mount','mission-story','scene-transport','story-next'];
    const boxes=Object.fromEntries(ids.map(id=>{const n=document.getElementById(id);if(!n)return[id,null];const r=n.getBoundingClientRect(),s=getComputedStyle(n),points=[[r.x+r.width/2,r.y+r.height/2],[r.x+r.width/2,r.y+4],[r.x+r.width/2,r.bottom-4],[r.x+4,r.y+r.height/2],[r.right-4,r.y+r.height/2]];return[id,{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,visible:!!n.getClientRects().length&&s.visibility!=='hidden',disabled:n.disabled??false,hit:r.width>0&&r.height>0&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),hitExtent:points.every(([x,y])=>n.contains(document.elementFromPoint(x,y))),font:s.fontFamily,fontSize:s.fontSize}]}));
    const visibleButtons=[...document.querySelectorAll('#experience button,.main-nav button,#tour-start')].filter(n=>{const r=n.getBoundingClientRect();return n.getClientRects().length&&r.top>=0&&r.bottom<=innerHeight&&getComputedStyle(n).visibility!=='hidden'}).map(n=>{const r=n.getBoundingClientRect();return{id:n.id,text:n.textContent.trim(),width:r.width,height:r.height}});
    return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,scrollY,boxes,visibleButtons};
  })()`);
  const click=async selector=>{
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({behavior:'instant',block:'center'})`);await sleep(90);
    const point=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,rect:r.toJSON(),scrollY,viewport:[innerWidth,innerHeight],hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.tagName,clear:!n.disabled&&r.width>0&&r.top>=0&&r.bottom<=innerHeight&&r.x>=0&&r.right<=innerWidth&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);
    assert(point.clear,selector+' must be visible and unobscured for a real pointer action: '+JSON.stringify(point));
    await command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
  };
  await command('Page.enable');await command('Runtime.enable');await command('DOM.enable');await command('CSS.enable');
  await command('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false});
  await command('Page.navigate',{url});
  await until(()=>evaluate("!!document.querySelector('#export:not([disabled])')"),'science initialized');
  await until(async()=>{const state=await inspect();return state?.webgl==='ready'&&state.moon.textured&&state.renderedFrames>0;},'actual textured Moon frame');
  await until(()=>evaluate("!!document.querySelector('#quick-tour')"),'first-visit offer');
  await evaluate("document.querySelector('.quick-tour-close').click();scrollTo(0,0)");
  await evaluate('document.fonts.ready');
  for(const [selector,family] of [['#experience-title','Space Grotesk'],['.hero-support','Inter'],['#hero-time-label','IBM Plex Mono']]){
    const documentNode=await command('DOM.getDocument');
    const node=await command('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector});
    const actual=node.nodeId?await command('CSS.getPlatformFontsForNode',{nodeId:node.nodeId}):{fonts:[]};
    const css=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n?{family:getComputedStyle(n).fontFamily,text:n.textContent,loaded:document.fonts.check('16px "'+${JSON.stringify(family)}+'"')}:null})()`);
    evidence.fontEvidence.push({selector,expected:family,css,actual:actual.fonts});
    gate(css?.loaded&&css.family.includes(family),'Self-hosted required font must be loaded and assigned: '+family,css);
    gate(actual.fonts.some(font=>font.familyName.replaceAll(' ','').includes(family.replaceAll(' ',''))&&font.isCustomFont),'Browser must actually paint '+family+' from a font asset.',actual.fonts);
  }
  evidence.contrast=await evaluate(`(()=>{
    const probe=document.createElement('span');probe.hidden=true;document.body.append(probe);
    const rgb=token=>{probe.style.color='var('+token+')';return getComputedStyle(probe).color.match(/[\\d.]+/g).slice(0,3).map(Number)};
    const lum=channels=>channels.map(c=>c/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
    const rows=[];for(const foreground of ['--color-text','--color-text-secondary','--color-text-muted'])for(const background of ['--color-bg','--color-surface','--color-surface-elevated']){const a=lum(rgb(foreground)),b=lum(rgb(background));rows.push({foreground,background,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)})}
    probe.remove();return rows;
  })()`);
  for(const row of evidence.contrast)gate(row.ratio>=4.5,'Ordinary text semantic color pair must reach WCAG AA4.5:1.',row);
  const cases=[{width:1366,height:768,name:'laptop'},{width:1920,height:1080,name:'desktop'},{width:768,height:1024,name:'tablet-768'},{width:900,height:768,name:'tablet-900'},{width:1024,height:768,name:'tablet-1024'},{width:390,height:844,name:'mobile'},{width:320,height:740,name:'mobile-320'},{width:1366,height:600,name:'short-laptop'},{width:683,height:384,name:'zoom-equivalent'}];
  const inside=(box,v)=>box?.visible&&box.width>0&&box.height>0&&box.x>=-1&&box.right<=v.width+1&&box.y>=-1&&box.bottom<=v.height+1;
  const checkSceneControls=(layout,viewport)=>{
    for(const id of ['mode-orbital','mode-surface','night-visibility','focus-earth','focus-sun','focus-terrain','find-opportunities','explore-site']){
      const box=layout.boxes[id];if(!inside(box,viewport))continue;
      gate(box.hit&&box.hitExtent,viewport.name+': an onscreen scene/action control must be unobscured at center and all four edges: '+id,box);
      gate(box.width>=44&&box.height>=44,viewport.name+': scene/action target must be at least44px: '+id,box);
    }
    const caption=layout.boxes['scene-coordinate-caption'];
    for(const id of ['focus-earth','focus-sun','focus-terrain']){
      const action=layout.boxes[id];if(!action?.visible||!caption?.visible)continue;
      const overlap=Math.min(action.right,caption.right)-Math.max(action.x,caption.x)>1&&Math.min(action.bottom,caption.bottom)-Math.max(action.y,caption.y)>1;
      gate(!overlap,viewport.name+': camera action must not overlap selected-coordinate caption: '+id,{action,caption});
    }
  };
  for(const viewport of cases){
    await command('Emulation.setDeviceMetricsOverride',{width:viewport.width,height:viewport.height,deviceScaleFactor:1,mobile:false});
    await evaluate('scrollTo(0,0)');await sleep(300);
    const layout=await metrics();evidence.viewports.push({...viewport,...layout});
    await screenshot('mission-'+viewport.name);
    if(['desktop','mobile'].includes(viewport.name))await screenshot('mission-'+viewport.name+'-full',true);
    gate(layout.scrollWidth<=viewport.width,viewport.name+': no horizontal page overflow.',layout.scrollWidth);
    checkSceneControls(layout,viewport);
    if(['laptop','desktop'].includes(viewport.name)){
      for(const id of ['visual-site','visual-arrival','visual-duration','story-title','find-opportunities','explore-site']){
        gate(inside(layout.boxes[id],viewport),viewport.name+': essential mission element must be visible without scrolling: '+id,layout.boxes[id]);
        if(!['story-title'].includes(id))gate(layout.boxes[id]?.hit,viewport.name+': essential control must not be covered: '+id,layout.boxes[id]);
      }
      const scene=layout.boxes['scene-mount'];
      gate(scene?.width>=viewport.width*.8&&scene.height>=viewport.height*.55,viewport.name+': Moon scene must form the dominant full-width environment, not a middle-column widget.',scene);
      const inputTops=['visual-site','visual-arrival','visual-duration'].map(id=>layout.boxes[id]?.y);
      gate(inputTops.every(Number.isFinite)&&Math.max(...inputTops)-Math.min(...inputTops)<=1,
        viewport.name+': landing site, arrival and duration inputs must share one aligned row.',inputTops);
      const transport=layout.boxes['scene-transport'];
      gate(inside(transport,viewport),viewport.name+': timeline transport must be integrated into the visible scene.',transport);
      const controlIds=['visual-site','visual-arrival','visual-duration','find-opportunities','explore-site','mode-orbital','mode-surface','hero-play','hero-pause'];
      for(const id of controlIds){const b=layout.boxes[id];gate(b?.width>=44&&b?.height>=44,viewport.name+': primary target must be at least44px: '+id,b);}
      for(let a=0;a<controlIds.length;a++)for(let b=a+1;b<controlIds.length;b++){
        const x=layout.boxes[controlIds[a]],y=layout.boxes[controlIds[b]];
        const overlap=x?.visible&&y?.visible&&Math.min(x.right,y.right)-Math.max(x.x,y.x)>1&&Math.min(x.bottom,y.bottom)-Math.max(x.y,y.y)>1;
        gate(!overlap,viewport.name+': controls must not overlap: '+controlIds[a]+' / '+controlIds[b],{x,y});
      }
    }
  }
  if(!baseline&&!layoutOnly){
    await command('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false});
    await evaluate("document.querySelector('#product-explore').click();scrollTo(0,0)");
    await click('#mode-surface');await until(async()=>(await inspect()).mode==='surface','surface view');
    await screenshot('surface-desktop');
    await click('#mode-orbital');await until(async()=>(await inspect()).mode==='orbital','orbital view');
    const before=(await inspect()).time;await click('#hero-play');
    await until(async()=>(await inspect()).time!==before,'view clock motion');await click('#hero-pause');
    const paused=(await inspect()).time;await sleep(350);assert.equal((await inspect()).time,paused,'Pause must stop actual scene time.');
    await click('#hero-reset');await until(async()=>(await inspect()).time===before,'view clock reset');
    await evaluate("document.querySelector('#visual-site').focus()");
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',modifiers:8,windowsVirtualKeyCode:9});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',modifiers:8,windowsVirtualKeyCode:9});
    const focus=await evaluate("({id:document.activeElement.id,outline:getComputedStyle(document.activeElement).outlineStyle,width:getComputedStyle(document.activeElement).outlineWidth})");
    gate(focus.id==='visual-site'&&focus.outline!=='none'&&parseFloat(focus.width)>=2,'Keyboard focus must be visible on landing-site control.',focus);
    if(await evaluate("!document.querySelector('#mission-options').open"))await click('#mission-options>summary');
    await click('#start-delay-demo');
    await until(()=>evaluate("document.querySelector('#story-status').textContent==='PASS'"),'nominal mission PASS');
    await click('#apply-requirements');
    await evaluate("document.querySelector('#visual-arrival').value='2026-01-01T06:00:00';document.querySelector('#visual-arrival').dispatchEvent(new Event('change'))");
    await until(()=>evaluate("document.querySelector('#story-title').textContent==='Outside the available dates'"),'out-of-coverage environmental conclusion');
    evidence.staleUncertainty=await evaluate("({arrival:document.querySelector('#visual-arrival').value,requirements:document.querySelector('#apply-requirements').checked,title:document.querySelector('#story-title').textContent,uncertaintyHidden:document.querySelector('#story-uncertainty').hidden,statusHidden:document.querySelector('#story-status').hidden})");
    assert.equal(evidence.staleUncertainty.requirements,false);assert.equal(evidence.staleUncertainty.uncertaintyHidden,true,'An old demo uncertainty estimate must not survive into an out-of-coverage environmental view.');
    assert.equal(evidence.staleUncertainty.statusHidden,true,'Environment-only coverage feedback must not manufacture a PASS/FAIL status.');
    await screenshot('outside-coverage-no-stale-uncertainty');
    await click('#start-delay-demo');
    await until(()=>evaluate("document.querySelector('#story-status').textContent==='PASS'&&document.querySelector('#apply-requirements').checked"),'nominal preset restored after coverage regression');
    const expected=runMission(bundle,communicationDemo(bundle));
    const readPlan=()=>evaluate("({status:document.querySelector('#story-status').textContent,date:document.querySelector('#story-date').textContent,joint:document.querySelector('#story-joint').textContent,explanation:document.querySelector('#story-explanation').textContent})");
    const checkTimelinePieces=async stage=>{
      const pieces=await evaluate(`Array.from(document.querySelectorAll('.timeline-piece'),(n,index)=>{const r=n.getBoundingClientRect(),parent=n.parentElement,t=parent.getBoundingClientRect();return{index,track:parent.className,piece:r.toJSON(),bounds:t.toJSON(),visible:n.getClientRects().length>0&&r.height>0&&getComputedStyle(n).visibility!=='hidden'}}).filter(row=>row.visible)`);
      evidence.timelinePieces??=[];evidence.timelinePieces.push({stage,count:pieces.length});
      gate(pieces.length>0,stage+': actual mission timeline pieces must render.');
      for(const {index,track,piece:p,bounds:t}of pieces){
        gate(p.height<=20&&p.x>=t.x-1&&p.y>=t.y-1&&p.right<=t.right+1&&p.bottom<=t.bottom+1,
          stage+': interval piece must stay within its local track and never form a viewport overlay.',{index,track,piece:p,bounds:t});
      }
    };
    await checkTimelinePieces('nominal');
    evidence.missionStates.push(await readPlan());await screenshot('original-pass-desktop');
    assert.equal(expected.nominal.status,'PASS');assert.match(evidence.missionStates[0].joint,/7 h 53 min 52 s/);
    await click('#story-next');
    await until(()=>evaluate("document.querySelector('#story-status').textContent==='FAIL'&&document.querySelector('#rescue-transition').hidden"),'72-hour delay FAIL');
    await checkTimelinePieces('delayed');
    evidence.missionStates.push(await readPlan());await screenshot('delayed-fail-desktop');
    assert.equal(expected.delayed.status,'FAIL');assert.match(evidence.missionStates[1].explanation,/12 hours.*7 hours.*5 hours too long/);
    evidence.tabletNightAssist=[];
    for(const viewport of cases.filter(v=>v.name.startsWith('tablet-'))){
      await command('Emulation.setDeviceMetricsOverride',{width:viewport.width,height:viewport.height,deviceScaleFactor:1,mobile:false});
      await click('#mode-orbital');await until(async()=>(await inspect()).mode==='orbital',viewport.name+' orbital view');
      await click('#mode-surface');await until(async()=>(await inspect()).mode==='surface',viewport.name+' surface view');
      if(await evaluate("document.querySelector('#night-visibility').getAttribute('aria-pressed')!=='true'"))await click('#night-visibility');
      const frame=await inspect();assert.equal(frame.displayLighting.enhancedNight,true);assert.equal(frame.sun.visible,false);assert.equal(frame.sun.directLightIntensity,0,'Artificial tablet night fill must never invent direct sunlight.');
      const layout=await metrics();checkSceneControls(layout,{...viewport,name:viewport.name+' surface/night assist'});
      gate(layout.scrollWidth<=viewport.width,viewport.name+': surface toolbar with Night assist ON must not overflow horizontally.',layout.scrollWidth);
      await screenshot('surface-night-'+viewport.name);evidence.tabletNightAssist.push({viewport:[viewport.width,viewport.height],mode:frame.mode,nightAssist:true,sunVisible:frame.sun.visible,directSunLight:frame.sun.directLightIntensity});
      await click('#night-visibility');
    }
    await command('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false});
    await click('#story-next');
    await until(()=>evaluate("document.querySelector('#story-status').textContent==='PASS'&&document.querySelector('#story-date').textContent.includes('17 Nov')"),'recovery PASS');
    await checkTimelinePieces('recovered');
    evidence.missionStates.push(await readPlan());await screenshot('recovered-pass-desktop');
    assert.equal(expected.recommended.status,'PASS');assert.match(evidence.missionStates[2].joint,/12 d 21 h/);
    for(const viewport of cases.filter(v=>v.name==='mobile'||v.name==='mobile-320')){
      await command('Emulation.setDeviceMetricsOverride',{width:viewport.width,height:viewport.height,deviceScaleFactor:1,mobile:false});
      await evaluate('scrollTo(0,0)');await click('#mode-orbital');await click('#mode-surface');
      await screenshot('surface-'+viewport.name);
      await click('#product-compare');await screenshot('compare-'+viewport.name);await screenshot('compare-'+viewport.name+'-full',true);
      gate(await evaluate('document.documentElement.scrollWidth<=innerWidth'),viewport.name+': Compare must not overflow horizontally.');
      await click('#product-analyst');await screenshot('advanced-'+viewport.name);
      gate(await evaluate('document.documentElement.scrollWidth<=innerWidth'),viewport.name+': Advanced must not overflow horizontally.');
      await click('#product-explore');
    }
    await command('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
    await click('#product-compare');await screenshot('compare-desktop');await click('#product-analyst');await screenshot('advanced-desktop');
    await click('#product-explore');
  }
  gate(evidence.exceptions.length===0,'No uncaught JavaScript exceptions.',evidence.exceptions);
  evidence.browser=await command('Browser.getVersion');
  await writeFile(resolve(work,'verification.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log((baseline?'Baseline recorded':'Reconstruction browser gates executed')+': '+evidence.failedGates.length+' failed layout/font gates. Evidence: '+work);
  if(!baseline)assert.deepEqual(evidence.failedGates,[],'Design acceptance gates failed; inspect verification.json and actual screenshots.');
}catch(error){await recordFailure?.().catch(()=>{});console.error(error);throw error;}
finally{socket?.close();browser.kill();server.close();}
