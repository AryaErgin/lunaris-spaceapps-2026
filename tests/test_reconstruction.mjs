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
import {moonPoint,sceneFrame} from '../web/scene-model.mjs';

// The latest approved design requests a real 0.8 presentation transform on
// fine-pointer desktops >=1201px. getBoundingClientRect reports displayed size:
// a 44 CSS-pixel overlay control therefore measures35.2px. Test that explicit
// 44*--mission-ui-scale contract AND the24px WCAG AA floor. Mobile/tablet,
// globe marker menus and other unscaled controls still require44px.

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
    const ids=['visual-site','visual-arrival','visual-duration','story-title','find-opportunities','explore-site','mode-orbital','mode-surface','night-visibility','focus-earth','focus-sun','focus-terrain','scene-coordinate-caption','marker-legend','story-nominal','story-delayed','story-recovered','hero-play','hero-pause','hero-reset','hero-time','scene-mount','mission-story','scene-transport','story-next'];
    const boxes=Object.fromEntries(ids.map(id=>{const n=id==='marker-legend'?document.querySelector('.mission-marker-legend'):document.getElementById(id);if(!n)return[id,null];const r=n.getBoundingClientRect(),s=getComputedStyle(n),points=[[r.x+r.width/2,r.y+r.height/2],[r.x+r.width/2,r.y+4],[r.x+r.width/2,r.bottom-4],[r.x+4,r.y+r.height/2],[r.right-4,r.y+r.height/2]];return[id,{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,visible:!!n.getClientRects().length&&s.visibility!=='hidden',disabled:n.disabled??false,hit:r.width>0&&r.height>0&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),hitExtent:points.every(([x,y])=>n.contains(document.elementFromPoint(x,y))),font:s.fontFamily,fontSize:s.fontSize}]}));
    const visibleButtons=[...document.querySelectorAll('#experience button,.main-nav button,#tour-start')].filter(n=>{const r=n.getBoundingClientRect();return n.getClientRects().length&&r.top>=0&&r.bottom<=innerHeight&&getComputedStyle(n).visibility!=='hidden'}).map(n=>{const r=n.getBoundingClientRect();return{id:n.id,text:n.textContent.trim(),width:r.width,height:r.height}});
    return{width:innerWidth,clientWidth:document.documentElement.clientWidth,height:innerHeight,missionUiScale:Number(getComputedStyle(document.documentElement).getPropertyValue('--mission-ui-scale'))||1,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,scrollY,boxes,visibleButtons};
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
  // The keyboard skip link has an amber background. Check its real combined
  // focus + pointer-hover state, which the general link hover rule can override.
  await command('Page.bringToFront');
  await evaluate("document.querySelector('.skip').focus()");
  await sleep(100);
  const skipBox=await evaluate("document.querySelector('.skip').getBoundingClientRect().toJSON()");
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:skipBox.x+skipBox.width/2,y:skipBox.y+skipBox.height/2});
  await sleep(150);
  evidence.skipLinkContrast=await evaluate(`(()=>{
    const n=document.querySelector('.skip'),s=getComputedStyle(n);
    const lum=color=>color.match(/[\\d.]+/g).slice(0,3).map(Number).map(c=>c/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
    const a=lum(s.color),b=lum(s.backgroundColor);
    return{hovered:n.matches(':hover'),focused:document.activeElement===n,foreground:s.color,background:s.backgroundColor,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
  })()`);
  gate(evidence.skipLinkContrast.hovered&&evidence.skipLinkContrast.focused&&evidence.skipLinkContrast.ratio>=4.5,'Focused skip link must retain AA contrast while hovered.',evidence.skipLinkContrast);
  await evaluate("document.activeElement.blur();scrollTo(0,0)");
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});
  const cases=[{width:1366,height:768,name:'laptop'},{width:1920,height:1080,name:'desktop'},{width:768,height:1024,name:'tablet-768'},{width:900,height:768,name:'tablet-900'},{width:1024,height:768,name:'tablet-1024'},{width:390,height:844,name:'mobile'},{width:320,height:740,name:'mobile-320'},{width:1366,height:600,name:'short-laptop'},{width:683,height:384,name:'zoom-equivalent'}];
  const inside=(box,v)=>box?.visible&&box.width>0&&box.height>0&&box.x>=-1&&box.right<=v.width+1&&box.y>=-1&&box.bottom<=v.height+1;
  const checkSceneControls=(layout,viewport)=>{
    for(const id of ['mode-orbital','mode-surface','night-visibility','focus-earth','focus-sun','focus-terrain','find-opportunities','explore-site','story-nominal','story-delayed','story-recovered']){
      const box=layout.boxes[id];if(!inside(box,viewport))continue;
      gate(box.hit&&box.hitExtent,viewport.name+': an onscreen scene/action control must be unobscured at center and all four edges: '+id,box);
      const minimum=44*layout.missionUiScale;
      gate(box.width>=minimum-.01&&box.height>=minimum-.01&&box.width>=24&&box.height>=24,
        viewport.name+': overlay target must meet44 CSSpx at the explicitly requested presentation scale and the24px AA floor: '+id,{...box,scale:layout.missionUiScale,minimum});
    }
    for(const captionId of ['scene-coordinate-caption','marker-legend'])for(const id of ['focus-earth','focus-sun','focus-terrain']){
      const action=layout.boxes[id],caption=layout.boxes[captionId];if(!action?.visible||!caption?.visible)continue;
      const overlap=Math.min(action.right,caption.right)-Math.max(action.x,caption.x)>1&&Math.min(action.bottom,caption.bottom)-Math.max(action.y,caption.y)>1;
      gate(!overlap,viewport.name+': camera action must not overlap coordinate caption or marker legend: '+id+' / '+captionId,{action,caption});
    }
  };
  const defaultMission=runMission(bundle,communicationDemo(bundle)).nominal;
  const checkInteractiveTimelines=async viewport=>{
    const unchanged=await evaluate("({arrival:document.querySelector('#visual-arrival').value,duration:document.querySelector('#visual-duration').value,site:document.querySelector('#visual-site').value,result:document.querySelector('#story-title').textContent})");
    const laneStyles=await evaluate(`['sun','earth'].map(channel=>{const n=document.querySelector('.hero-lane[data-channel='+channel+'] .hero-lane-track'),s=n.querySelector('.hero-lane-strip'),r=n.getBoundingClientRect();return{channel,native:n.tagName,caption:n.querySelector('.hero-lane-caption').textContent,label:n.getAttribute('aria-label'),height:r.height,scale:Number(getComputedStyle(document.documentElement).getPropertyValue('--mission-ui-scale'))||1,stripHeight:s.getBoundingClientRect().height,pieces:[...s.querySelectorAll('.timeline-piece')].map(p=>({start:Number(p.dataset.start),end:Number(p.dataset.end),state:p.dataset.state,title:p.title,background:getComputedStyle(p).backgroundColor,pattern:getComputedStyle(p).backgroundImage}))}})`);
    for(const lane of laneStyles){
      assert.equal(lane.native,'BUTTON','Visibility rows must be keyboard-operable native buttons.');
      const minimum=(viewport.width<=740?44:32)*lane.scale;
      assert(lane.height>=minimum-.01&&lane.height>=24,'Timeline targets must retain their explicit32pxdesktop/44pxmobile size and the24pxAA floor.');
      assert(Math.abs(lane.stripHeight-8*lane.scale)<.1,'The visible channel strip must remain8CSSpx inside its larger interaction target.');
      assert.match(lane.label,/Enter inspects the current time/);
      assert.deepEqual(lane.pieces.map(p=>[p.start,p.end,p.state]),defaultMission.timeline[lane.channel]);
      assert(lane.pieces.every(p=>p.title.includes('UTC')),'Every colored interval must expose its actual bounded UTC interval.');
    }
    const sun=laneStyles[0],earth=laneStyles[1],visibleSun=sun.pieces.find(p=>p.state==='visible'),uncertainSun=sun.pieces.find(p=>p.state==='uncertain'),visibleEarth=earth.pieces.find(p=>p.state==='visible');
    assert(visibleSun&&uncertainSun&&visibleEarth,'The nominal witness must demonstrate confirmed, unresolved and full-stay Earth visibility.');
    assert.equal(visibleSun.pattern,'none');assert.match(uncertainSun.pattern,/repeating-linear-gradient/);assert.notEqual(visibleSun.background,visibleEarth.background,'Sun and Earth need distinct channel colors.');
    assert.equal(earth.caption,'Visible for the whole stay');assert.match(sun.caption,/confirmed.*unresolved/);assert.match(sun.caption,/\d+\s+h\s+\d+\s+min\s+confirmed.*\d+\s+h\s+\d+\s+min\s+unresolved/,'Timeline quantities and units must remain separated by readable spaces.');
    const interactions=[];
    for(const [channel,state]of [['sun','uncertain'],['earth','visible']]){
      const selector='.hero-lane[data-channel="'+channel+'"] .hero-lane-track';
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({behavior:'instant',block:'center'})`);await sleep(90);
      await evaluate(`window.__timelineClickEvidence=[];{const n=document.querySelector(${JSON.stringify(selector)});for(const type of ['pointerdown','mousedown','focus','pointerup','mouseup','click'])n.addEventListener(type,event=>window.__timelineClickEvidence.push({type,detail:event.detail,pointerType:event.pointerType,clientX:event.clientX,clientY:event.clientY,trusted:event.isTrusted,rect:n.getBoundingClientRect().toJSON(),scrollY}),{capture:true,once:true})}`);
      const point=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),s=n.querySelector('.hero-lane-strip'),p=s.querySelector('.timeline-${state}'),r=p.getBoundingClientRect(),t=s.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,fraction:(r.x+r.width/2-t.x)/t.width,strip:t.toJSON(),scrollY,clear:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);
      assert(point.clear,'A real pointer must reach the actual colored '+channel+' interval.');
      await command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
      const afterPress=await evaluate(`({rect:document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON(),strip:document.querySelector(${JSON.stringify(selector)}+' .hero-lane-strip').getBoundingClientRect().toJSON(),scrollY})`);
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
      const stateNow=await evaluate(`({hero:document.querySelector('#hero-time').value,probe:document.querySelector('#probe-slider').value,time:Number(document.querySelector('#scene-mount').dataset.time),horizon:Number(document.querySelector('#local-sky').dataset.time),inspection:document.querySelector('#hero-${channel}-inspection').textContent,hidden:document.querySelector('#hero-${channel}-inspection').hidden,events:window.__timelineClickEvidence,scrollY})`);
      assert.equal(stateNow.hero,stateNow.probe);assert.equal(stateNow.time,stateNow.horizon);assert.equal(stateNow.hidden,false);assert.match(stateNow.inspection,/UTC.*View:/);
      const requested=defaultMission.start+point.fraction*(defaultMission.end-defaultMission.start);
      assert(Math.abs(stateNow.time-requested)<=900.01,'A timeline click must seek the nearest30-minute cached sample: '+JSON.stringify({channel,state,point,afterPress,requested,stateNow}));
      assert(bundle.sites.find(s=>s.id===unchanged.site).geometry.some(row=>row[0]===stateNow.time));
      assert.equal((await inspect()).time,stateNow.time);
      await screenshot('timeline-'+channel+'-'+viewport.name);interactions.push({channel,state,requestedTime:requested,...stateNow});
      await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      assert.equal(Number(await evaluate("document.querySelector('#scene-mount').dataset.time")),stateNow.time,'Enter inspects the current time without moving the mission clock.');
      await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      assert.equal(await evaluate(`document.querySelector('#hero-${channel}-inspection').hidden`),true);
    }
    assert.deepEqual(await evaluate("({arrival:document.querySelector('#visual-arrival').value,duration:document.querySelector('#visual-duration').value,site:document.querySelector('#visual-site').value,result:document.querySelector('#story-title').textContent})"),unchanged,'Visibility timeline inspection must preserve the evaluated arrival, duration, site and environmental conclusion.');
    evidence.interactiveTimelines??=[];evidence.interactiveTimelines.push({viewport:[viewport.width,viewport.height],styles:laneStyles,interactions,missionUnchanged:true});
    await click('#hero-reset');
  };
  for(const viewport of cases){
    const previousFrame=await inspect();
    await command('Emulation.setDeviceMetricsOverride',{width:viewport.width,height:viewport.height,deviceScaleFactor:1,mobile:false});
    await evaluate('scrollTo(0,0)');await sleep(300);
    const canvasSize=await evaluate("[document.querySelector('#scene-mount').clientWidth,document.querySelector('#scene-mount').clientHeight]");
    if(previousFrame.camera.canvasSize.some((value,index)=>value!==canvasSize[index]))await until(async()=>{const frame=await inspect(),live=await evaluate("[document.querySelector('#scene-mount').clientWidth,document.querySelector('#scene-mount').clientHeight]");return frame.renderedFrames>previousFrame.renderedFrames&&frame.camera.canvasSize.every((value,index)=>value===live[index]);},viewport.name+' must paint the resized visible Moon canvas');
    const layout=await metrics();evidence.viewports.push({...viewport,...layout});
    evidence.viewports.at(-1).sceneFrame=await inspect();
    await screenshot('mission-'+viewport.name);
    if(['desktop','mobile'].includes(viewport.name))await screenshot('mission-'+viewport.name+'-full',true);
    gate(layout.scrollWidth<=layout.clientWidth,viewport.name+': no horizontal page overflow.',layout.scrollWidth);
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
      for(const id of controlIds){const b=layout.boxes[id],minimum=44*layout.missionUiScale;gate(b?.width>=minimum-.01&&b?.height>=minimum-.01&&b.width>=24&&b.height>=24,viewport.name+': primary target must meet44 CSSpx at the approved overlay scale: '+id,{...b,scale:layout.missionUiScale,minimum});}
      for(let a=0;a<controlIds.length;a++)for(let b=a+1;b<controlIds.length;b++){
        const x=layout.boxes[controlIds[a]],y=layout.boxes[controlIds[b]];
        const overlap=x?.visible&&y?.visible&&Math.min(x.right,y.right)-Math.max(x.x,y.x)>1&&Math.min(x.bottom,y.bottom)-Math.max(x.y,y.y)>1;
        gate(!overlap,viewport.name+': controls must not overlap: '+controlIds[a]+' / '+controlIds[b],{x,y});
      }
    }
    if(!baseline&&!layoutOnly&&['laptop','mobile','mobile-320'].includes(viewport.name))await checkInteractiveTimelines(viewport);
  }
  if(!baseline&&!layoutOnly){
    await command('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false});
    await evaluate("document.querySelector('#product-explore').click();scrollTo(0,0)");
    evidence.terrainMarkerSelections=[];
    for(const target of bundle.sites){
      await click('#reset-orbit');
      await until(async()=>{const frame=await inspect();return frame.mode==='orbital'&&frame.terrainCluster?.visible&&frame.terrainCluster.ids.length===bundle.sites.length&&frame.camera.position.every((n,i)=>Math.abs(n-frame.camera.overviewPosition[i])<1e-5);},'cold overview exposes all '+bundle.sites.length+' geographical study points');
      const frame=await inspect();assert.equal(frame.terrainMarkers.length,bundle.sites.length);
      assert.deepEqual([...frame.terrainCluster.ids].sort(),bundle.sites.map(s=>s.id).sort());
      for(const marker of frame.terrainMarkers){
        const site=bundle.sites.find(s=>s.id===marker.id);assert(site);assert.equal(marker.lat,site.lat);assert.equal(marker.lon,site.lon);
        const expectedPosition=moonPoint(site.lat,site.lon,1.008);
        // Chrome and Node libm can differ in their last trig-result bits. This
        // eight-ULP absolute floor is about3nm at lunar radius, not a terrain or
        // ephemeris tolerance; the input coordinates remain exact comparisons.
        assert(marker.position.every((value,i)=>Math.abs(value-expectedPosition[i])<=8*Number.EPSILON*Math.max(1,Math.abs(expectedPosition[i]))),'Study-point labels must not relocate their actual Moon-fixed pins.');
        assert.equal(marker.visible,true,'Every terrain-aware point must be in the cold overview frustum.');
        assert(marker.position.reduce((sum,p,i)=>sum+p*(frame.camera.position[i]-p),0)>0,'Every selectable cold-start study pin must face the actual camera.');
      }
      await click('.mission-terrain-cluster>summary');
      const choices=await evaluate("[...document.querySelectorAll('.mission-terrain-choices button')].map(n=>{const r=n.getBoundingClientRect();return{id:n.dataset.terrainSite,text:n.textContent,width:r.width,height:r.height}})");
      assert.equal(choices.length,bundle.sites.length);
      for(const site of bundle.sites){const choice=choices.find(c=>c.id===site.id);assert(choice?.text.includes(site.name));assert(choice.width>=44&&choice.height>=44,'Unscaled study-point choices retain44px targets despite desktop overlay scaling.');}
      if(evidence.terrainMarkerSelections.length===0)await screenshot('all-study-point-chooser-desktop');
      await click(`.mission-terrain-choices button[data-terrain-site="${target.id}"]`);
      await until(async()=>{const state=await inspect();return state.siteId===target.id;},'globe choice synchronizes '+target.id);
      assert.equal(await evaluate("document.querySelector('#visual-site').value"),target.id);assert.equal(await evaluate("document.querySelector('#site').value"),target.id);
      evidence.terrainMarkerSelections.push({siteId:target.id,coordinates:[target.lat,target.lon],realPointerSelection:true});
    }
    await evaluate("document.querySelector('#visual-site').value='de-gerlache-rim';document.querySelector('#visual-site').dispatchEvent(new Event('change'))");
    await until(async()=>(await inspect()).siteId==='de-gerlache-rim','default study point restored before demonstration');
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
      gate(layout.scrollWidth<=layout.clientWidth,viewport.name+': surface toolbar with Night assist ON must not overflow horizontally.',layout.scrollWidth);
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
      gate(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),viewport.name+': Compare must not overflow horizontally.');
      await click('#product-analyst');await screenshot('advanced-'+viewport.name);
      gate(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),viewport.name+': Advanced must not overflow horizontally.');
      await click('#product-explore');
    }
    await command('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
    await click('#product-compare');await screenshot('compare-desktop');await click('#product-analyst');await screenshot('advanced-desktop');
    await click('#product-explore');
    const terrainPlan=()=>evaluate("JSON.stringify({fields:[...document.querySelectorAll('#mission-form input,#mission-form select')].map(n=>[n.id,n.value,n.checked]),compact:['visual-site','visual-arrival','visual-duration'].map(id=>[id,document.querySelector('#'+id).value]),requirements:document.querySelector('#apply-requirements').checked,start:document.querySelector('#mission-story').dataset.start})");
    const chooseContext=async(index,expected)=>{
      await click('#any-site-select');
      for(const key of ['Home',...Array(index).fill('ArrowDown'),'Enter']){
        const code=key==='Home'?36:key==='ArrowDown'?40:13;
        await command('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code});
        await command('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code});
      }
      await until(()=>evaluate(`document.querySelector('#any-site-select').value===${JSON.stringify(expected)}`),'native context-location selection '+expected);
    };
    const captureContextSection=async name=>{
      const clip=await evaluate("(()=>{const r=document.querySelector('#any-site').getBoundingClientRect();return{x:r.x,y:r.y+scrollY,width:r.width,height:r.height,scale:1}})()");
      const result=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip});
      await writeFile(resolve(work,name+'-section.png'),Buffer.from(result.data,'base64'));
    };
    evidence.levelHorizonExplorer=[];
    for(const viewport of [{width:1366,height:768,name:'desktop'},{width:390,height:844,name:'mobile'},{width:320,height:740,name:'mobile-320'}]){
      await command('Emulation.setDeviceMetricsOverride',{width:viewport.width,height:viewport.height,deviceScaleFactor:1,mobile:false});
      const beforeContext=await terrainPlan();
      await click('#product-compare');await click('#compare-more-sites');
      await until(()=>evaluate("document.querySelector('#any-site').open"),'Compare opens real level-horizon explorer');
      for(const [id,index,lat,lon]of [['apollo-11',0,.67416,23.47314],['change-4',8,-45.4446,177.5991]]){
        await chooseContext(index,id);
        await evaluate("document.querySelector('.any-site-controls').scrollIntoView({behavior:'instant',block:'center'})");await sleep(120);
        const data=await evaluate(`(()=>{const q=s=>document.querySelector(s);return{selected:q('#any-site-select').value,latitude:Number(q('#any-site-lat').value),longitude:Number(q('#any-site-lon').value),time:Number(q('#any-site-result').dataset.time),text:q('#any-site-result').textContent,qualification:q('.any-site-note').textContent,hasStatus:!!q('#any-site-result .status'),bodies:[...document.querySelectorAll('#any-site-result .any-site-body')].map(n=>({...n.dataset})),paths:[...document.querySelectorAll('#any-site-chart path')].map(n=>({className:n.getAttribute('class'),fill:getComputedStyle(n).fill,stroke:getComputedStyle(n).stroke,points:n.getAttribute('d').length})),controls:['any-site-select','any-site-lat','any-site-lon'].map(id=>{const n=document.getElementById(id),r=n.getBoundingClientRect();return{id,rect:r.toJSON(),clear:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}}),overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth}})()`);
        assert.equal(data.selected,id);assert.equal(data.latitude,lat);assert.equal(data.longitude,lon);assert(Number.isFinite(data.time)&&data.time>0);
        assert.match(data.qualification,/Level-horizon geometry only/);assert.equal(data.hasStatus,false);assert.doesNotMatch(data.text,/\b(?:PASS|FAIL|INDETERMINATE)\b/,'Context directions must not masquerade as a terrain-aware mission decision.');
        assert.deepEqual(data.bodies.map(b=>b.body),['sun','earth']);
        for(const body of data.bodies){assert(Number.isFinite(Number(body.azimuth)));assert(Number.isFinite(Number(body.elevation)));}
        assert.equal(data.paths.length,4,'The explorer must draw Sun and Earth for the selected context and the study-point comparison.');
        for(const path of data.paths){assert.equal(path.fill,'none','Elevation curves must never become opaque filled polygons.');assert.notEqual(path.stroke,'none');assert(path.points>100);}
        data.axisClearance=await evaluate(`(()=>{const left=document.querySelector('#any-site-chart').getBoundingClientRect().left;return[...document.querySelectorAll('.any-site-axis')].map(n=>{const range=document.createRange();range.selectNodeContents(n);return{text:n.textContent,clearance:left-range.getBoundingClientRect().right}})})()`);
        assert(data.axisClearance.every(axis=>axis.clearance>=4),'Elevation labels must remain outside the plotted Sun/Earth curves with readable separation.');
        data.dateAxisAlignment=await evaluate(`(()=>{const plot=document.querySelector('#any-site-chart').getBoundingClientRect(),first=document.querySelector('.any-site-days>span:first-child').getBoundingClientRect(),last=document.querySelector('.any-site-days>span:last-child').getBoundingClientRect();return{start:Math.abs(first.left-plot.left),end:Math.abs(last.right-plot.right)}})()`);
        assert(data.dateAxisAlignment.start<=1&&data.dateAxisAlignment.end<=1,'Date labels must align with the actual chart range after reserving elevation-label space.');
        assert(data.controls.every(c=>c.clear&&c.rect.height>=44),'Location and coordinate controls must be readable, inside the page and unobscured.');assert.equal(data.overflow,false);
        assert.equal(await terrainPlan(),beforeContext,'Apollo/international context selection must preserve every terrain-aware mission input and decision identity.');
        await screenshot('anysite-'+id+'-'+viewport.name);await captureContextSection('anysite-'+id+'-'+viewport.name);
        evidence.levelHorizonExplorer.push({viewport:[viewport.width,viewport.height],...data,terrainMissionUnchanged:true});
      }
    }
    // Pause actual animation callbacks, as well as scene intersection. Explicit
    // resize paints remain permitted; they must not be needed to complete an
    // animation-dependent mode change or update a derived obstruction annotation.
    const observerFixture=await command('Page.addScriptToEvaluateOnNewDocument',{source:`window.__lunarisPausedRaf={requested:0,callbacks:0,queue:[]};window.requestAnimationFrame=callback=>{const state=window.__lunarisPausedRaf;state.requested++;state.queue.push(()=>{state.callbacks++;callback(performance.now())});return state.requested};window.cancelAnimationFrame=()=>{};window.IntersectionObserver=class PausedSceneObserver{constructor(callback){this.callback=callback}observe(target){queueMicrotask(()=>this.callback([{isIntersecting:false,target}],this))}unobserve(){}disconnect(){}};`});
    try{
      await command('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false});
      await command('Page.reload');
      await until(()=>evaluate("!!document.querySelector('#export:not([disabled])')"),'paused-renderer fixture science ready');
      await until(async()=>(await inspect())?.webgl==='ready','paused-renderer fixture WebGL loaded');
      const initialFrame=await inspect();
      const pausedRaf=()=>evaluate("({requested:window.__lunarisPausedRaf.requested,callbacks:window.__lunarisPausedRaf.callbacks})");
      assert((await pausedRaf()).requested>0,'The fixture must intercept real animation-frame requests.');assert.equal((await pausedRaf()).callbacks,0,'No intercepted animation callback may run.');
      await click('#mode-surface');
      const requestedAt=Date.now();await until(async()=>(await inspect()).mode==='surface','surface transition with rendering paused',20);
      const completedMs=Date.now()-requestedAt;assert(completedMs<=2000,'Surface entry must complete within two seconds even when intersection gating pauses RAF.');
      const completed=await inspect();assert.equal((await pausedRaf()).callbacks,0);
      const pausedSite=bundle.sites.find(site=>site.id===completed.siteId);
      const blockedIndex=pausedSite.geometry.findIndex(row=>row[0]<bundle.coverage[1]&&sceneFrame(pausedSite,row,bundle.coverage).states.earth==='blocked');
      assert(blockedIndex>=0,'The real cache must contain an Earth-blocked sample for this regression.');
      await evaluate(`document.querySelector('#time-scope').value='coverage';document.querySelector('#time-scope').dispatchEvent(new Event('change'));document.querySelector('#hero-time').value=${blockedIndex};document.querySelector('#hero-time').dispatchEvent(new Event('input'));document.querySelector('#focus-earth').click()`);
      const blockedFrame=await inspect(),annotationHidden=await evaluate("document.querySelector('.mission-terrain-obstruction').hidden");
      assert.equal(blockedFrame.earth.state,'blocked');assert.equal(blockedFrame.earth.visible,false);assert.equal(annotationHidden,false,'A blocked-Earth directional explanation must update even when animation callbacks cannot run.');assert.equal((await pausedRaf()).callbacks,0);
      evidence.pausedRendererEarthBlock={index:blockedIndex,time:blockedFrame.time,state:blockedFrame.earth.state,bodyVisible:blockedFrame.earth.visible,annotationHidden,renderedFrames:blockedFrame.renderedFrames,animationCallbacks:0};
      await screenshot('paused-renderer-earth-obstruction');
      await click('#mode-orbital');assert.equal((await inspect()).mode,'orbital');
      await click('#mode-surface');await click('#mode-orbital');await sleep(1100);
      const canceled=await inspect();assert.equal(canceled.mode,'orbital','A superseded surface timer must not override the latest orbital view request.');
      const finalRaf=await pausedRaf();assert.equal(finalRaf.callbacks,0);
      evidence.pausedRendererTransition={initialRenderedFrames:initialFrame.renderedFrames,renderedFrames:completed.renderedFrames,animationRequests:finalRaf.requested,animationCallbacks:finalRaf.callbacks,completedMs,firstMode:completed.mode,latestIntentMode:canceled.mode,cancellationWaitMs:1100};
      await screenshot('paused-renderer-latest-orbital-intent');
    }finally{
      await command('Page.removeScriptToEvaluateOnNewDocument',{identifier:observerFixture.identifier});
      await command('Page.reload');
    }
    await until(async()=>{const frame=await inspect();return frame?.webgl==='ready'&&frame.renderedFrames>0&&frame.moon.textured;},'real IntersectionObserver and Moon renderer restored');
    await screenshot('restored-real-renderer');
  }
  gate(evidence.exceptions.length===0,'No uncaught JavaScript exceptions.',evidence.exceptions);
  evidence.browser=await command('Browser.getVersion');
  await writeFile(resolve(work,'verification.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log((baseline?'Baseline recorded':'Reconstruction browser gates executed')+': '+evidence.failedGates.length+' failed layout/font gates. Evidence: '+work);
  if(!baseline)assert.deepEqual(evidence.failedGates,[],'Design acceptance gates failed; inspect verification.json and actual screenshots.');
}catch(error){await recordFailure?.().catch(()=>{});console.error(error);throw error;}
finally{socket?.close();browser.kill();server.close();}
