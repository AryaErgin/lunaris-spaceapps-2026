// A non-modal tour of real controls. Only the explicit demo consent loads a preset.
export const ONBOARDING_KEY='lunaris:onboarding:v2';
export function shouldOfferOnboarding(storage){try{return storage?.getItem(ONBOARDING_KEY)===null;}catch{return false;}}
export function markOnboardingOffered(storage){try{storage?.setItem(ONBOARDING_KEY,'offered');}catch{/* Replay works without browser storage. */}}
export const GUIDE_STEPS=Object.freeze([
  {id:'welcome',title:'Your lunar mission, explained',description:'Take a hands-on tour: choose a place and time, then see how a landing delay changes the mission. Your plan stays unchanged until you give permission.',workspace:'explore',selectors:['#tour-start']},
  {id:'site',title:'Choose where to explore',description:'This selector and the gold Moon markers choose a supported study point. Each has its own NASA terrain horizon; a study point is not an approved landing pad.',workspace:'explore',selectors:['#visual-site']},
  {id:'date',title:'Choose arrival and duration',description:'Arrival starts your evaluated period. Hours sets its length. Changes recalculate the result. Cached dates are shown beside Arrival; missing coverage stays unknown.',workspace:'explore',selectors:['#visual-arrival','#visual-duration']},
  {id:'views',title:'Step onto the Moon',description:'Orbital view shows the location. Surface view opens its NASA LOLA terrain. Drag to look around; scroll or pinch to zoom. Next opens the actual surface.',workspace:'explore',selectors:['#mode-surface','#mode-orbital']},
  {id:'geometry',title:'Look toward Sun and Earth',description:'Look at Earth or Sun aims the camera along the calculated direction. A hidden center stays hidden behind terrain; an uncertain crossing has no exact countdown.',workspace:'explore',selectors:['#focus-earth','#focus-sun']},
  {id:'playback',title:'Move the view clock',description:'Play, pause or scrub to watch the sky change. This view clock does not change arrival. Positions use 30-minute samples; smooth motion is a display aid.',workspace:'explore',selectors:['#hero-play','#hero-time']},
  {id:'visibility',title:'How long are both visible?',description:'The main result summarizes confirmed Sun and Earth time together. Open the durations to inspect each body, outages and unresolved bounds. Next opens these details.',workspace:'explore',selectors:['#environment-overview','#story-title']},
  {id:'requirements',title:'A result needs your rules',description:'Optional requirements compare those durations with your chosen limits. PASS proves only these geometric rules, not power, a working radio link or landing safety.',workspace:'explore',selectors:['#apply-requirements','#mission-requirements-editor']},
  {id:'demo-consent',title:'Try a real landing delay?',description:'With your permission, load the 12-hour de Gerlache example and its illustrative requirements. This replaces the current plan; you can restore it afterward.',workspace:'explore',selectors:['#start-delay-demo']},
  {id:'nominal',title:'Original arrival: confirmed PASS',description:'Read the calculated result and four requirements. Next performs the real 72-hour delay while keeping the same site, duration and limits.',workspace:'explore',selectors:['#story-delayed','#story-status']},
  {id:'delay',title:'72 hours later: sunlight lost',description:'Terrain blocks the Sun for 12 hours, exceeding the 7-hour limit by 5 hours. Next searches later starts at this same site without changing the rules.',workspace:'explore',selectors:['#story-next','#story-witness']},
  {id:'recovery',title:'A later window, with a cost',description:'Inspect the recovered date, waiting cost and proof below. It is the earliest confirmed hourly start; earlier uncertain starts are not proven failures.',workspace:'explore',selectors:['#story-joint','#recovery-choice']},
  {id:'compare',title:'Compare independent options',description:'Each card has its own site and arrival; duration and requirements are shared. Compare confirmed overlap, then View this option to explore that plan.',workspace:'compare',selectors:['#comparison-site-A','#comparison-arrival-A','#comparison-site-B','#comparison-arrival-B']},
  {id:'opportunities',title:'Find opportunities before launch',description:'This separate search checks the supported study points within a displayed search window. It keeps your duration and any enabled requirements. Next runs the real search.',workspace:'explore',selectors:['#find-opportunities']},
  {id:'locations',title:'Explore other lunar locations',description:'Cyan diamond markers and this catalog open Apollo, CLPS or international locations. These use a level horizon only: no terrain visibility or mission PASS is calculated.',workspace:'explore',selectors:['#any-site-select','#any-site-lat','#any-site-lon']},
  {id:'advanced',title:'Inspect the science',description:'Open these questions for methods and limits, or the tools for horizons, timelines, sources, sensitivity and decision records. Next opens the existing tools.',workspace:'analyst',selectors:['#analysis-tools']},
  {id:'finish',title:'Ready to explore independently',description:'Choose a site and arrival, inspect the sky, compare or search. To repeat the delay story, choose Try a 72-hour delay. Your saved plan can be restored below.',workspace:'explore',selectors:['#explore-site','#find-opportunities']}
]);

export function initQuickTour(doc=document){
  const trigger=doc.getElementById('tour-start');
  if(!trigger||doc.getElementById('quick-tour'))return;
  const win=doc.defaultView,$=id=>doc.getElementById(id);
  const node=(tag,className,text)=>{const n=doc.createElement(tag);n.className=className;if(text)n.textContent=text;return n;};
  const panel=node('section','quick-tour');panel.id='quick-tour';panel.hidden=true;
  panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','false');
  panel.setAttribute('aria-labelledby','quick-tour-title');panel.setAttribute('aria-describedby','quick-tour-description');
  const top=node('div','quick-tour-top'),progress=node('span','quick-tour-progress'),close=node('button','quick-tour-close','Skip');
  close.type='button';close.setAttribute('aria-label','Close guided walkthrough');top.append(progress,close);
  const title=node('h2',''),description=node('p',''),feedback=node('p','quick-tour-feedback');
  title.id='quick-tour-title';description.id='quick-tour-description';feedback.id='quick-tour-feedback';feedback.setAttribute('role','status');feedback.hidden=true;
  const actions=node('div','quick-tour-actions'),previous=node('button','quick-tour-back','Back'),next=node('button','quick-tour-next','Next');
  const keep=node('button','quick-tour-keep','Keep my plan'),restore=node('button','quick-tour-restore','Restore my plan & exit');
  keep.id='quick-tour-keep-plan';restore.id='quick-tour-restore';keep.hidden=restore.hidden=true;
  for(const button of [previous,next,close,keep,restore])button.type='button';
  const content=node('div','quick-tour-content'),footer=node('div','quick-tour-footer');
  content.tabIndex=0;content.setAttribute('aria-label','Walkthrough explanation');
  content.append(title,description,feedback);actions.append(previous,next);footer.append(actions,keep,restore);
  panel.append(top,content,footer);doc.body.append(panel);
  let current=-1,targets=[],positionRequest=0,busy=false,snapshot=null,demoLoaded=false,demoIdentity=null,offered=false,operation=0;
  const visible=n=>n&&!n.disabled&&n.getClientRects().length>0;
  const setText=(n,value)=>{if(n.textContent!==value)n.textContent=value;};
  const setProp=(n,key,value)=>{if(n[key]!==value)n[key]=value;};
  const stepId=()=>GUIDE_STEPS[current]?.id;
  const click=id=>{const control=$(id);if(!control||control.disabled)return false;control.click();return true;};
  const pause=()=>{click('hero-pause');click('sky-pause');};
  const wait=ms=>new Promise(resolve=>win.setTimeout(resolve,ms));
  async function until(fn){for(let i=0;i<200;i++){if(fn())return true;await wait(80);}return false;}
  function clear(){for(const n of targets)n.classList.remove('quick-tour-target');targets=[];}
  function finish(){++operation;pause();clear();panel.hidden=true;panel.setAttribute('aria-busy','false');current=-1;busy=false;trigger.setAttribute('aria-expanded','false');(visible(trigger)?trigger:$('product-explore'))?.focus();}
  function note(text){setText(feedback,text);feedback.hidden=!text;}
  function position(){
    positionRequest=0;if(panel.hidden)return;
    const margin=12,w=panel.offsetWidth,h=panel.offsetHeight,width=doc.documentElement.clientWidth,height=win.innerHeight;
    const corners=[{x:width-w-margin,y:height-h-margin,bottom:true},{x:margin,y:height-h-margin,bottom:true},{x:width-w-margin,y:margin,bottom:false},{x:margin,y:margin,bottom:false}];
    const rects=targets.slice(0,2).map(n=>n.getBoundingClientRect());
    const overlap=({x,y})=>rects.reduce((sum,r)=>sum+Math.max(0,Math.min(x+w,r.right)-Math.max(x,r.left))*Math.max(0,Math.min(y+h,r.bottom)-Math.max(y,r.top)),0);
    const best=corners.map(p=>({p,score:overlap(p)})).sort((a,b)=>a.score-b.score)[0].p;
    // Anchor to a viewport edge instead of caching an absolute top. Feedback,
    // translated labels or the restore action can grow the panel before the
    // next animation frame; bottom anchoring keeps Next on screen immediately.
    panel.style.left=Math.max(margin,best.x)+'px';panel.style.right='auto';
    panel.style.top=best.bottom?'auto':margin+'px';panel.style.bottom=best.bottom?margin+'px':'auto';
  }
  function requestPosition(){if(!positionRequest&&!panel.hidden)positionRequest=win.requestAnimationFrame(position);}
  function graphicsUnavailable(){return ['unavailable','lost'].includes($('scene-mount')?.dataset.webgl)||$('scene-mount')?.dataset.terrainStatus==='unavailable';}
  function reveal(n){for(let p=n?.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;}
  function refresh(){
    const ready=Boolean($('visual-site')&&!$('visual-site').disabled);
    if(trigger.disabled===ready)trigger.disabled=!ready;
    if(ready&&!offered){offered=true;let storage;try{storage=win.localStorage;}catch{/* private mode */}
      if(shouldOfferOnboarding(storage)){markOnboardingOffered(storage);if(current<0)show(0,true);}}
    if(current<0)return;
    // Graphics loss can route the application to Advanced during any step.
    if(!panel.getClientRects().length)doc.body.append(panel);
    const id=stepId(),step=GUIDE_STEPS[current];
    let found=(id==='opportunities'&&panel.dataset.searched==='done'?[$('opportunities-status'),$('opportunity-options')]:step.selectors.map(s=>doc.querySelector(s))).filter(visible);
    if(id==='advanced')found=[doc.querySelector('#analysis-tools > summary')].filter(visible);
    if(id==='visibility')found=[doc.querySelector('#environment-overview summary')??$('decision-evidence'),$('story-title')].filter(visible);
    if(graphicsUnavailable()&&['views','geometry','playback'].includes(id)){
      if($('top').hidden)click('product-analyst');
      if(!$('analysis-tools').open)$('analysis-tools').open=true;
      found=(id==='playback'?['sky-play','probe-slider']:['view-sun','view-earth']).map($).filter(visible);
      setText(description,id==='playback'?'3D is unavailable. Play or scrub the same calculated sky in this accessible chart. Arrival stays unchanged.':'3D is unavailable. Use the Sun and Earth controls on the scientific horizon chart; the calculations are unchanged.');
    }
    if(demoLoaded&&['nominal','delay','recovery'].includes(id)){
      const status=$('story-status')?.textContent??'Not evaluated';
      setText(title,`${{nominal:'Original arrival',delay:'After the landing delay',recovery:'Recommended start'}[id]}: ${status}`);
      const instructions={nominal:'Next applies the 72-hour delay with the same rules.',delay:'Next searches later starts at this same site.',recovery:'Read the waiting cost and hourly-grid qualification below. Next opens Compare.'};
      setText(description,`${$('story-explanation')?.textContent??'Read the actual result below.'} ${instructions[id]}`);
    }
    if(found.length!==targets.length||found.some((n,i)=>n!==targets[i])){clear();targets=found;for(const n of targets)n.classList.add('quick-tour-target');}
    if(!busy){
      const labels={welcome:'Start tour',views:graphicsUnavailable()?'Use scientific chart':'Open the surface',geometry:'Look at Earth, then Next',playback:'Play, pause, then Next',visibility:'Open visibility details',requirements:'Next', 'demo-consent':'Load 12-hour example',nominal:'Simulate 72-hour delay',delay:'Find next confirmed window',recovery:'Compare options',opportunities:'Search opportunities',advanced:'Open calculation tools',finish:'Finish tour'};
      setText(next,panel.dataset.inspected===id||id==='opportunities'&&panel.dataset.searched==='done'?'Next':labels[id]??'Next');
    }
    setProp(next,'disabled',busy);setProp(previous,'disabled',busy);setProp(keep,'hidden',id!=='demo-consent');setProp(keep,'disabled',busy);
    setProp(restore,'hidden',!snapshot);setProp(restore,'disabled',busy);
    requestPosition();
  }
  function show(index,automatic=false){
    if(index<0||index>=GUIDE_STEPS.length)return finish();
    pause();clear();delete panel.dataset.inspected;current=index;busy=false;const step=GUIDE_STEPS[index];panel.dataset.step=step.id;panel.hidden=false;panel.setAttribute('aria-busy','false');note('');
    click('product-'+step.workspace);
    if(['requirements','demo-consent'].includes(step.id))$('mission-options').open=true;
    if(step.id==='locations')$('any-site').open=true;
    if(graphicsUnavailable()&&['views','geometry','playback'].includes(step.id)){click('product-analyst');$('analysis-tools').open=true;}
    // Back selects the already evaluated demonstration stage; it never reloads a preset or repeats a search.
    if(demoLoaded&&['nominal','delay','recovery'].includes(step.id))click({nominal:'story-nominal',delay:'story-delayed',recovery:'story-recovered'}[step.id]);
    setText(progress,`STEP ${index+1} OF ${GUIDE_STEPS.length}`);setText(title,step.title);setText(description,step.description);content.scrollTop=0;
    previous.hidden=index===0;trigger.setAttribute('aria-expanded','true');
    for(const selector of step.selectors)reveal(doc.querySelector(selector));
    doc.body.append(panel);refresh();
    const first=targets[0];first?.scrollIntoView({behavior:'instant',block:'center',inline:'nearest'});
    // Keep the fixed panel at body level: closed disclosures and CSS containing
    // blocks must never clip or reposition it. Tab bridges to its navigation below.
    if(automatic)next.focus({preventScroll:true});
    else {first?.focus({preventScroll:true});if(doc.activeElement!==first)next.focus({preventScroll:true});}
    position();
  }
  async function advance(){
    if(busy||current<0)return;
    const id=stepId(),ticket=++operation;busy=true;panel.setAttribute('aria-busy','true');note('');setText(next,'Working…');refresh();
    let destination=current+1;
    try{
      if(id==='date'){
        for(const key of ['visual-arrival','visual-duration'])if(!$(key).reportValidity())return;
        click('visual-date-go');if($('story-status')?.textContent==='STALE')return note('Choose an arrival and positive duration that can be evaluated.');
      }else if(id==='views'&&!graphicsUnavailable()){
        click('mode-surface');
        if(!await until(()=>$('scene-mount')?.dataset.terrainStatus==='ready'||graphicsUnavailable()))note('Terrain could not load. The scientific chart remains available in Advanced.');
      }else if(id==='geometry'){click(graphicsUnavailable()?'view-earth':'focus-earth');}
      else if(id==='playback'){
        click(graphicsUnavailable()?'sky-play':'hero-play');await wait(1200);if(ticket!==operation)return;pause();
      }else if(id==='visibility'){
        const details=doc.querySelector('#environment-overview details');if(details)details.open=true;
        else if(!$('decision-evidence').hidden)$('decision-evidence').scrollIntoView({block:'start'});
        panel.dataset.inspected=id;note('These durations belong to your selected arrival and duration. Next continues to optional mission rules.');return;
      }else if(id==='demo-consent'){
        const app=await import('./app.mjs');snapshot=app.captureOnboardingPlan();
        if(!snapshot)throw Error('The application data is not ready. Keep your plan and continue to Compare.');
        click('start-delay-demo');demoLoaded=true;demoIdentity=JSON.stringify(app.captureOnboardingPlan().fields);
      }else if(id==='nominal'||id==='delay'){
        if(!demoLoaded){note('The demonstration was not loaded. Keep your plan and continue to Compare.');return;}
        const app=await import('./app.mjs');
        if(JSON.stringify(app.captureOnboardingPlan().fields)!==demoIdentity){
          demoLoaded=false;show(GUIDE_STEPS.findIndex(s=>s.id==='demo-consent'));
          note('You changed the plan. Keep your edits, or explicitly reload the example before continuing its delay story.');return;
        }
        const from=id==='nominal'?'nominal':'delayed',target=id==='nominal'?'delayed':'recommended';
        const targetButton='story-'+(target==='recommended'?'recovered':target);
        // Inspect the intended stage before advancing, using the existing evaluated result.
        if($(targetButton)?.getAttribute('aria-pressed')!=='true'){click('story-'+from);click(id==='nominal'?'story-delayed':'story-next');}
        if(!await until(()=>$(targetButton)?.getAttribute('aria-pressed')==='true'&&$('rescue-transition')?.hidden))throw Error('This calculation is not ready. Retry, or Skip to keep using the application.');
      }else if(id==='opportunities'){
        click('find-opportunities');
        if(!await until(()=>$('landing-opportunities')?.getAttribute('aria-busy')==='false'))throw Error('The search is still running. Retry when it finishes.');
        const search=$('landing-opportunities');
        if(search.dataset.kind==='ERROR'){note($('opportunities-status').textContent+' Adjust the allowed dates or grid in Advanced, then retry.');return;}
        setText(description,$('opportunities-status').textContent);note('Search complete. The options are highlighted below; Next continues to other lunar locations.');
        destination=current;panel.dataset.searched='true';
      }else if(id==='advanced'){
        $('analysis-tools').open=true;panel.dataset.inspected=id;
        note('The scientific tools are now open. Inspect the plots, sources or export, then choose Next to return to Mission.');return;
      }
      if(ticket!==operation)return;
      if(id==='opportunities'&&panel.dataset.searched==='done'){delete panel.dataset.searched;destination=current+1;}
      if(destination===current){
        panel.dataset.searched='done';
        clear();targets=[$('opportunity-options'),$('opportunities-status')].filter(visible);for(const n of targets)n.classList.add('quick-tour-target');
        targets[0]?.scrollIntoView({block:'start',behavior:'instant'});
      }else show(destination);
    }catch(error){if(ticket===operation)note(error.message);}
    finally{if(ticket===operation){busy=false;panel.setAttribute('aria-busy','false');refresh();if(panel.dataset.searched==='done')setText(next,'Next');}}
  }
  trigger.setAttribute('aria-controls',panel.id);trigger.setAttribute('aria-expanded','false');
  trigger.addEventListener('click',()=>{demoLoaded=false;demoIdentity=null;show(0);});previous.addEventListener('click',()=>{delete panel.dataset.searched;show(stepId()==='compare'&&!demoLoaded?GUIDE_STEPS.findIndex(s=>s.id==='demo-consent'):current-1);});close.addEventListener('click',finish);
  next.addEventListener('click',()=>{if(panel.dataset.inspected===stepId()||stepId()==='opportunities'&&panel.dataset.searched==='done'){delete panel.dataset.searched;show(current+1);}else void advance();});
  keep.addEventListener('click',()=>{demoLoaded=false;demoIdentity=null;show(GUIDE_STEPS.findIndex(s=>s.id==='compare'));});
  // The highlighted preset button and tour Next share the same consent path.
  // Capture the current plan before its existing application handler can replace it.
  doc.addEventListener('click',event=>{
    if(stepId()==='demo-consent'&&!busy&&event.target.closest?.('#start-delay-demo')){
      event.preventDefault();event.stopImmediatePropagation();void advance();
    }
  },true);
  restore.addEventListener('click',async()=>{if(!snapshot||busy)return;busy=true;refresh();try{const app=await import('./app.mjs');if(app.restoreOnboardingPlan(snapshot)){snapshot=null;demoLoaded=false;finish();}else note('Your saved plan could not be restored. The current plan is unchanged.');}finally{busy=false;refresh();}});
  doc.addEventListener('keydown',e=>{
    if(current<0)return;
    if(e.key==='Escape'){e.preventDefault();finish();}
    else if(e.key==='Tab'&&!e.shiftKey&&doc.activeElement===targets.at(-1)){e.preventDefault();close.focus({preventScroll:true});}
    else if(e.key==='Tab'&&e.shiftKey&&doc.activeElement===close&&targets.length){e.preventDefault();targets.at(-1).focus({preventScroll:true});}
  });
  const observer=new win.MutationObserver(refresh);
  observer.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-mode','data-webgl','data-terrain-status','data-workspace','data-kind','aria-busy','disabled','hidden']});
  win.addEventListener('resize',requestPosition);win.addEventListener('scroll',requestPosition,{passive:true});refresh();
  return {start:()=>show(0),close:finish};
}
if(typeof document!=='undefined'){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>initQuickTour(),{once:true});
  else initQuickTour();
}
