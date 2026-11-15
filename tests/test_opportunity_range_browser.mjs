// Real-data opportunity-range/pagination regression. No app/data substitution.
// node tests/test_opportunity_range_browser.mjs
// Evidence stays ignored under .operator; no public deployment is checked.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {evaluateStart} from '../web/engine.mjs';
import {missionMetrics} from '../web/operations.mjs';

const root=process.cwd(),work=resolve(root,'.operator',`opportunity-range-browser-${Date.now()}-${process.pid}`);
await mkdir(work,{recursive:true});
const bundle=JSON.parse(await readFile(resolve(root,'web/data/bundle.json'),'utf8'));
const evidence={work,scope:'Actual local packaged data; desktop Chrome CSS viewport emulation, not physical phones or a deployed release.',viewports:[]};
const pause=ms=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms));
const utc=value=>Date.parse(value+'Z')/1000;
const inputTime=value=>new Date(value*1000).toISOString().slice(0,16);
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.json':'application/json','.css':'text/css','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg'};
const server=createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=resolve(root,`.${pathname.endsWith('/')?pathname+'index.html':pathname}`);
  if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
  try{res.setHeader('Content-Type',mime[extname(file)]??'application/octet-stream');res.end(await readFile(file));}
  catch{res.writeHead(404).end();}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const url=`http://127.0.0.1:${server.address().port}/web/`;
async function until(fn,label,timeout=60000){
  const start=Date.now();
  while(Date.now()-start<timeout){if(await fn())return;await pause(75);}
  throw Error('Timed out: '+label);
}
function canonicalInputs(saved){
  const fields=saved.fields,number=id=>fields[id]===''?null:Number(fields[id]);
  return {siteId:fields.site,nominal:utc(fields.nominal),durationHours:number('duration'),delayHours:number('delay'),
    maxSunHours:number('max-sun'),maxEarthHours:number('max-earth'),minJointHours:number('min-total'),minContinuousJointHours:number('min-continuous'),
    earliest:utc(fields.earliest),latest:utc(fields.latest),gridMinutes:number('grid'),mode:saved.prelaunch?'prelaunch':'same-site'};
}
function independentCards(inputs,from,to,{requirements=false}={}){
  // Enumerate direct authoritative evaluations independently of the new
  // collectAll orchestration and pagination helpers. No score or UI verdict.
  const cards=[];
  for(let time=Math.max(from,inputs.earliest);time<=Math.min(to,inputs.latest);time+=3600){
    for(const site of bundle.sites){
      const mission=evaluateStart(bundle,inputs,site.id,time);
      const confirmed=missionMetrics(mission,site).joint.visibleRangeSeconds[0];
      if(requirements?mission.status==='PASS':confirmed>0)cards.push({site:site.id,start:String(time),status:requirements?'PASS':'ENVIRONMENT'});
    }
  }
  return cards;
}
let browser,socket;
try{
  for(const width of [1366,390,320]){
    const record={width,exceptions:[],pages:[]};evidence.viewports.push(record);
    const profile=resolve(work,'profile-'+width);
    browser=spawn(process.env.LUNARIS_CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe',[
      '--headless=new','--remote-debugging-port=0','--no-first-run','--disable-extensions','--disable-background-networking',
      `--user-data-dir=${profile}`,'--use-angle=swiftshader','--enable-unsafe-swiftshader','about:blank'
    ],{stdio:['ignore','ignore','pipe'],windowsHide:true});
    await until(async()=>{try{return(await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).length>0;}catch{return false;}},'Chrome startup');
    const port=(await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];
    const tabs=await fetch(`http://127.0.0.1:${port}/json/list`).then(response=>response.json());
    socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await once(socket,'open');
    let next=0;const pending=new Map();
    socket.addEventListener('message',({data})=>{
      const message=JSON.parse(data);
      if(message.method==='Runtime.exceptionThrown')record.exceptions.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text);
      const callback=pending.get(message.id);
      if(callback){pending.delete(message.id);message.error?callback.reject(Error(JSON.stringify(message.error))):callback.resolve(message.result);}
    });
    const command=(method,params={})=>new Promise((resolveResult,reject)=>{
      const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},60000);
      pending.set(id,{resolve:value=>{clearTimeout(timer);resolveResult(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      socket.send(JSON.stringify({id,method,params}));
    });
    const evaluate=async expression=>{
      const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
      if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
      return result.result.value;
    };
    const capture=async name=>{
      const result=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      await writeFile(resolve(work,`${width}-${name}.png`),Buffer.from(result.data,'base64'));
    };
    const click=async selector=>{
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await pause(60);
      const point=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,clear:!n.disabled&&r.width>0&&r.top>=0&&r.bottom<=innerHeight&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);
      assert(point.clear,selector+' must be reachable by an actual pointer.');
      await command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
    };
    const plan=()=>evaluate("import('/web/app.mjs').then(m=>m.captureOnboardingPlan())");
    const state=()=>evaluate(`(()=>{
      const root=document.querySelector('#landing-opportunities'),cards=document.querySelector('#opportunity-options');
      return {kind:root.dataset.kind,busy:root.getAttribute('aria-busy'),candidates:Number(root.dataset.candidates??0),
        status:document.querySelector('#opportunities-status').textContent,cards:[...cards.children].map(n=>({...n.dataset})),data:{...cards.dataset},
        page:document.querySelector('#opportunity-page-status').textContent,nextDisabled:document.querySelector('#opportunity-next').disabled,
        previousDisabled:document.querySelector('#opportunity-previous').disabled,pagerHidden:document.querySelector('#opportunity-pagination').hidden,
        scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth};
    })()`);
    const rangeFields=async(from,to,grid=60)=>evaluate(`(()=>{
      for(const[id,value]of ${JSON.stringify([['opportunity-from',from],['opportunity-to',to],['opportunity-grid',String(grid)]])}){
        const n=document.getElementById(id);n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}));
      }
    })()`);
    const searchRange=async(from,to,grid=60)=>{
      await rangeFields(from,to,grid);await click('#opportunity-search-range');
      await until(async()=>(await state()).busy==='false','range completion');return state();
    };
    const showSearch=async()=>{await click('#find-opportunities');await until(async()=>(await state()).busy==='false','ordinary opportunity search');};
    const setSchedule=async(earliest,latest)=>{
      await click('#opportunity-limits');
      await evaluate(`(()=>{for(const[id,value]of ${JSON.stringify([['earliest',earliest],['latest',latest]])}){
        const n=document.getElementById(id);n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}));
      }document.querySelector('#mission-form').requestSubmit();})()`);
      await until(()=>evaluate("!document.querySelector('#export').disabled"),'updated schedule evaluation');
      await click('#product-explore');await showSearch();
    };
    const restore=async saved=>{
      await evaluate(`import('/web/app.mjs').then(m=>m.restoreOnboardingPlan(${JSON.stringify(saved)}))`);await showSearch();
    };
    await command('Runtime.enable');await command('Page.enable');await command('Page.bringToFront');
    await command('Emulation.setDeviceMetricsOverride',{width,height:840,deviceScaleFactor:1,mobile:false});
    await command('Page.navigate',{url});
    await until(()=>evaluate("!!document.querySelector('#export:not([disabled])')"),'real science ready');
    await evaluate("document.querySelector('.quick-tour-close')?.click()");
    const original=await plan();await showSearch();record.default=await state();
    const from='2027-08-01T00:00',to='2027-08-02T00:00';
    const automatic={...canonicalInputs(original),earliest:bundle.coverage[0],latest:bundle.coverage[1]-Number(original.fields.duration)*3600};
    const expected=independentCards(automatic,utc(from),utc(to));
    let actual=await searchRange(from,to);
    assert.equal(actual.kind,'VISIBILITY_FOUND');assert(expected.length>10,'Real witness must span multiple desktop/mobile pages.');
    assert.equal(Number(actual.data.total),expected.length);assert.equal(Number(actual.data.pageSize),width<=740?5:10);
    assert.deepEqual(await plan(),original,'Search must not overwrite the inspected mission, its schedule or requirement assumptions.');
    const all=[];
    while(true){
      actual=await state();assert(actual.cards.length<=Number(actual.data.pageSize));
      assert(actual.scrollWidth<=actual.clientWidth,'No horizontal page overflow, including the stable scrollbar gutter.');
      const grid=await evaluate("getComputedStyle(document.querySelector('#opportunity-options')).gridTemplateColumns.split(' ').length");
      assert.equal(grid,width<=740?1:2,'Desktop has two columns; narrow screens have one.');
      all.push(...actual.cards);record.pages.push({data:actual.data,count:actual.cards.length,status:actual.page});
      if(actual.nextDisabled)break;
      await click('#opportunity-next');await pause(40);
      const pager=await evaluate("(()=>{const p=document.querySelector('#opportunity-pagination').getBoundingClientRect(),c=document.querySelector('#opportunity-options').getBoundingClientRect();return{pagerBottom:p.bottom,cardsTop:c.top}})()");
      assert(pager.pagerBottom<=pager.cardsTop,'The page control must precede the new cards, not strand the first options above the viewport.');
    }
    const identity=card=>`${card.start}/${card.site}/${card.status}`;
    assert.deepEqual(all.map(identity).sort(),expected.map(identity).sort(),'Every displayed card must be a distinct directly evaluated confirmed opportunity.');
    assert.equal(new Set(all.map(identity)).size,all.length,'Pagination must not repeat a candidate.');
    assert(all.every((card,index)=>index===0||Number(card.start)>=Number(all[index-1].start)),'All pages must remain in chronological order.');
    assert.deepEqual(await plan(),original,'Changing pages must not change the scene mission or certificate identity.');
    record.confirmedCards=all.length;
    await click('#opportunity-previous');
    await evaluate("document.querySelector('#opportunity-next').focus()");
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    assert((await state()).nextDisabled,'Native keyboard Enter must advance to the last page.');record.keyboardNext=true;
    await capture('last-page');
    await click('#opportunity-previous');await evaluate("document.querySelector('#opportunity-pagination').scrollIntoView({block:'start',behavior:'instant'})");await capture('page-and-cards');

    record.noData=await searchRange('2026-01-01T00:00','2026-01-02T00:00');
    assert.equal(record.noData.kind,'NO_DATA');assert.equal(record.noData.cards.length,0);assert(record.noData.pagerHidden);
    await searchRange(from,to);await rangeFields('2027-08-03T00:00',to);
    record.stale=await state();assert.equal(record.stale.kind,'STALE');assert.equal(record.stale.cards.length,0);assert(record.stale.pagerHidden);
    await rangeFields('2027-08-01T00:00','2027-08-31T00:00');
    await evaluate(`(()=>{document.querySelector('#opportunity-range-form').requestSubmit();setTimeout(()=>{
      const n=document.querySelector('#opportunity-to');n.value='2027-08-30T00:00';n.dispatchEvent(new Event('input',{bubbles:true}));
    },1);})()`);
    await pause(800);record.cancelled=await state();
    assert.equal(record.cancelled.kind,'STALE');assert.equal(record.cancelled.cards.length,0);assert.deepEqual(await plan(),original);

    await setSchedule('2027-08-01T06:00','2027-08-01T08:00');
    const limited=await plan(),limitedInputs=canonicalInputs(limited);
    record.scheduleIntersection=await searchRange(from,to);
    assert.equal(record.scheduleIntersection.candidates,3*bundle.sites.length,'Only starts within explicit schedule bounds may be evaluated.');
    const expectedPassing=independentCards(limitedInputs,utc(from),utc(to),{requirements:true});
    assert.deepEqual(record.scheduleIntersection.cards.map(identity).sort(),expectedPassing.map(identity).sort(),'Requirement-mode cards must be genuine PASS decisions.');
    assert.deepEqual(await plan(),limited,'Explicit scheduling constraints must be retained.');
    record.scheduleEmpty=await searchRange('2027-08-03T00:00','2027-08-04T00:00');
    assert.equal(record.scheduleEmpty.kind,'SCHEDULE_EMPTY');assert.match(record.scheduleEmpty.status,/scheduling exclusion/);assert.equal(record.scheduleEmpty.cards.length,0);
    await setSchedule('2026-10-31T00:00','2026-11-03T00:00');
    record.gridEmpty=await searchRange('2026-10-31T23:30','2026-11-01T00:10');
    assert.equal(record.gridEmpty.kind,'GRID_EMPTY');assert.equal(record.gridEmpty.candidates,0);assert.match(record.gridEmpty.status,/smaller interval|widen/);assert.equal(record.gridEmpty.cards.length,0);

    await restore(original);
    const lastStart=bundle.coverage[1]-Number(original.fields.duration)*3600;
    record.lastFullMission=await searchRange(inputTime(lastStart),inputTime(lastStart));
    assert.equal(record.lastFullMission.candidates,bundle.sites.length,'A full mission ending exactly at the exclusive cache end is supported.');
    record.afterLastMission=await searchRange(inputTime(lastStart+60),inputTime(lastStart+60));
    assert.equal(record.afterLastMission.kind,'NO_DATA');assert.equal(record.afterLastMission.cards.length,0);
    record.guard=await searchRange(inputTime(bundle.coverage[0]),inputTime(lastStart));
    assert.equal(record.guard.kind,'ERROR');assert.match(record.guard.status,/10000 site\/start pairs/);assert.equal(record.guard.cards.length,0);
    assert.deepEqual(await plan(),original,'Error handling must not alter the inspected mission.');
    assert.deepEqual(record.exceptions,[],'No uncaught application exception is permitted.');
    console.log(`PASS ${width}px: ${all.length} confirmed cards, ${record.pages.length} pages; schedule/grid/cache/cancellation/keyboard/identity checked.`);
    socket.close();socket=null;browser.kill();browser=null;
  }
  evidence.status='PASS';
}catch(error){evidence.status='FAIL';evidence.error=error.stack;throw error;}
finally{
  await writeFile(resolve(work,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  socket?.close();browser?.kill();server.close();console.log('Evidence: '+work);
}
