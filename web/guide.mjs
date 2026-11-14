// First-visit, skippable guide through the actual LUNARIS workflow.
// It never labels level-horizon geometry as terrain-aware feasibility.
export const GUIDE_STEPS=Object.freeze([
  {title:'1. Set the mission',description:'Choose one of three terrain-modeled south-pole study points, a UTC arrival in November 2026 and the hours you plan to stay. These define the mission you are inspecting.',workspace:'explore',selectors:['#visual-site','#visual-arrival','#visual-duration']},
  {title:'2. Read the Sun and Earth results',description:'Sun in view and Earth in view are separate geometric conditions. The headline shows confirmed time with both at once. A sunset bracket means the terrain evidence cannot give an exact crossing time.',workspace:'explore',selectors:['#story-title','#story-durations','#hero-visibility']},
  {title:'3. See why terrain matters',description:'Explore surface shows NASA LOLA-derived slopes and the Sun and Earth directions from this study point. A hidden Sun can make the scene dark; Night assist is artificial light for inspection, not sunlight.',workspace:'explore',selectors:['#explore-site','#mode-surface']},
  {title:'4. Move the lunar clock',description:'This stay plays the mission; Whole month shows the November cycle at 24 hours per second. The timeline changes the viewed instant, not your chosen arrival or the scientific decision.',workspace:'explore',selectors:['#hero-scope-month','#hero-play','#hero-time']},
  {title:'5. Explore other lunar locations',description:'Choose an Apollo, CLPS or other mission site, or enter coordinates. The Sun and Earth bearings and elevation chart use a level horizon only: without terrain, these are NOT mission visibility or feasibility results.',workspace:'explore',selectors:['#any-site-select','#any-site-lat','#any-site-lon','#any-site-result']},
  {title:'6. Compare two plans',description:'Compare keeps the duration and chosen requirements fixed while you change each study site or arrival independently. The summary explains the difference; only the three study points have terrain-aware decisions.',workspace:'compare',selectors:['#comparison-site-A','#comparison-arrival-A','#comparison-site-B','#comparison-arrival-B']},
  {title:'7. Search for landing opportunities',description:'Find landing opportunities scans supported site/date starts. With no mission limits it ranks confirmed Sun-and-Earth overlap; with requirements enabled it reports passing, failing and unresolved starts.',workspace:'explore',selectors:['#find-opportunities','#landing-opportunities']},
  {title:'8. Try a real delay scenario',description:'Now load the audited illustrative 12-hour mission and apply a 72-hour landing delay. This replaces the current example inputs; it does not change the scientific data. The resulting decisions are calculated, not scripted verdicts.',workspace:'explore',selectors:['#delay-shortcut','#story-next','#story-status']},
  {title:'9. Inspect the failure',description:'After the delay the mission fails its sunlight limit: a confirmed 12-hour outage exceeds the illustrative 7-hour maximum by 5 hours. Earth visibility alone is unresolved, so we do not invent an Earth blackout.',workspace:'explore',selectors:['#story-status','#story-explanation','#decision-evidence']},
  {title:'10. See the recovered mission',description:'The next confirmed passing start on the hourly search grid is November 17 at 03:00 UTC. The original four requirements stay fixed. Earlier uncertain starts do not prove an earlier physical window impossible.',workspace:'explore',selectors:['#story-status','#recovery-choice','#story-joint']},
  {title:'11. Understand what the result means',description:'A PASS proves only the chosen visibility constraints within this November cache and terrain model. It does not establish solar power, a working radio link or landing safety. Advanced contains detailed evidence, sources and sensitivity cases.',workspace:'explore',selectors:['#decision-evidence','#product-analyst']}
]);
const SEEN_KEY='lunaris:first-visit-tour:v2';

export function initQuickTour(doc=document){
  const trigger=doc.getElementById('tour-start');
  if(!trigger||doc.getElementById('quick-tour'))return;
  const win=doc.defaultView;
  const node=(tag,className,value)=>{const n=doc.createElement(tag);n.className=className;if(value)n.textContent=value;return n;};
  const panel=node('section','quick-tour');panel.id='quick-tour';panel.hidden=true;
  panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','false');
  panel.setAttribute('aria-labelledby','quick-tour-title');panel.setAttribute('aria-describedby','quick-tour-description');
  const top=node('div','quick-tour-top'),progress=node('span','quick-tour-progress'),close=node('button','quick-tour-close','Skip guide');
  close.type='button';close.setAttribute('aria-label','Skip guided walkthrough');top.append(progress,close);
  const title=node('h2',''),description=node('p','');title.id='quick-tour-title';description.id='quick-tour-description';
  const actions=node('div','quick-tour-actions'),previous=node('button','quick-tour-back','Back'),next=node('button','quick-tour-next');
  previous.type=next.type='button';actions.append(previous,next);panel.append(top,title,description,actions);doc.body.append(panel);
  let current=-1,targets=[],positionRequest=0,pendingPhase=null,autoPending=true;
  try{autoPending=win.localStorage.getItem(SEEN_KEY)!=='seen';}catch{}
  const visible=n=>n&&!n.disabled&&n.getClientRects().length>0;
  const setText=(n,value)=>{if(n.textContent!==value)n.textContent=value;};
  const phase=name=>doc.getElementById('story-'+name)?.getAttribute('aria-pressed')==='true';
  const searched=()=>{const n=doc.getElementById('landing-opportunities');return n&&!n.hidden&&n.dataset.kind&&!['SEARCHING','ERROR'].includes(n.dataset.kind)&&n.getAttribute('aria-busy')!=='true';};
  function clear(){for(const n of targets)n.classList.remove('quick-tour-target');targets=[];}
  function finish(){
    clear();panel.hidden=true;current=-1;pendingPhase=null;trigger.setAttribute('aria-expanded','false');
    (visible(trigger)?trigger:doc.getElementById('product-explore'))?.focus();
  }
  function position(){
    positionRequest=0;if(panel.hidden)return;
    const margin=12,w=panel.offsetWidth,h=panel.offsetHeight,width=doc.documentElement.clientWidth,height=win.innerHeight;
    const corners=[[width-w-margin,height-h-margin],[margin,height-h-margin],[width-w-margin,margin],[margin,margin]];
    const rects=targets.map(n=>n.getBoundingClientRect());
    const overlap=([x,y])=>rects.reduce((sum,r)=>sum+Math.max(0,Math.min(x+w,r.right)-Math.max(x,r.left))*Math.max(0,Math.min(y+h,r.bottom)-Math.max(y,r.top)),0);
    const best=corners.map(p=>({p,score:overlap(p)})).sort((a,b)=>a.score-b.score)[0].p;
    panel.style.left=Math.max(margin,best[0])+'px';panel.style.top=Math.max(margin,best[1])+'px';panel.style.right='auto';panel.style.bottom='auto';
  }
  function requestPosition(){if(!positionRequest&&!panel.hidden)positionRequest=win.requestAnimationFrame(position);}
  function refresh(){
    const ready=visible(doc.getElementById('visual-site'));
    if(trigger.disabled===ready)trigger.disabled=!ready;
    if(autoPending&&ready){
      autoPending=false;
      try{win.localStorage.setItem(SEEN_KEY,'seen');}catch{}
      win.setTimeout(()=>{if(current<0)show(0);},0);
    }
    if(current<0)return;
    if(pendingPhase&&phase(pendingPhase)){
      const expected=current,waiting=pendingPhase;pendingPhase=null;
      win.setTimeout(()=>{if(current===expected&&phase(waiting))show(expected+1);},0);
      return;
    }
    const step=GUIDE_STEPS[current],found=step.selectors.map(s=>doc.querySelector(s)).filter(visible);
    if(found.length!==targets.length||found.some((n,i)=>n!==targets[i])){clear();targets=found;for(const n of targets)n.classList.add('quick-tour-target');}
    const mount=doc.getElementById('scene-mount'),inSurface=doc.getElementById('experience')?.dataset.mode==='surface';
    const unavailable=['unavailable','lost'].includes(mount?.dataset.webgl)||mount?.dataset.terrainStatus==='unavailable';
    const surface=inSurface&&mount?.dataset.terrainStatus==='ready';
    const search=doc.getElementById('landing-opportunities'),busy=search?.getAttribute('aria-busy')==='true';
    const labels=['Use this plan','Explore the surface','Open the surface','Show the other locations','Compare plans','Find opportunities',
      searched()?'Try landing delay':busy?'Searching…':search?.dataset.kind==='ERROR'?'Retry search':'Search opportunities',
      'Load example and simulate delay','Find a confirmed recovery','Review the limits','Finish guide'];
    if(current===2)labels[2]=surface||unavailable?'Show time playback':inSurface?'Loading terrain…':'Open the surface';
    if(pendingPhase)labels[current]='Updating the mission…';
    setText(next,labels[current]);
    next.disabled=Boolean(pendingPhase)||(current===2&&!unavailable&&(inSurface&&!surface||Boolean(doc.getElementById('explore-site')?.disabled)))||(current===6&&busy);
    if(current===2&&surface)setText(description,'Drag the NASA LOLA surface to inspect the horizon, then continue. Sun and Earth centers are terrain-gated; Night assist is explicitly artificial.');
    else if(current===2&&unavailable)setText(description,'3D terrain is unavailable here. LUNARIS retains its 2D calculated visibility results; continue with time playback.');
    else if(current===6&&searched())setText(description,'The opportunity search has finished. Compare the supported site/date options below, then proceed to the delay demonstration.');
    else if(current===6&&search?.dataset.kind==='ERROR')setText(description,'The search could not run with these inputs. Correct the schedule or grid in Advanced, then retry. No results are invented.');
    requestPosition();
  }
  function show(index){
    if(index<0||index>=GUIDE_STEPS.length)return finish();
    clear();current=index;pendingPhase=null;
    const step=GUIDE_STEPS[index],tab=doc.getElementById('product-'+step.workspace);
    // Avoid resetting the currently active workspace as a side effect of first-visit onboarding.
    if(tab&&tab.getAttribute('aria-pressed')!=='true')tab.click();
    if(index===4){const sites=doc.getElementById('any-site');if(sites)sites.open=true;}
    setText(progress,'STEP '+(index+1)+' OF '+GUIDE_STEPS.length);
    setText(title,step.title);setText(description,step.description);
    previous.hidden=index===0;panel.hidden=false;trigger.setAttribute('aria-expanded','true');
    doc.body.append(panel);refresh();
    const first=targets[0];first?.scrollIntoView({behavior:'instant',block:'center',inline:'nearest'});
    (first??close).focus({preventScroll:true});position();
  }
  trigger.setAttribute('aria-controls',panel.id);trigger.setAttribute('aria-expanded','false');
  trigger.addEventListener('click',()=>{autoPending=false;show(0);});
  previous.addEventListener('click',()=>{
    if(current===9)doc.getElementById('story-delayed')?.click();
    if(current===8)doc.getElementById('story-nominal')?.click();
    show(current-1);
  });
  close.addEventListener('click',finish);
  next.addEventListener('click',()=>{
    if(pendingPhase)return;
    if(current===0){
      for(const id of ['visual-site','visual-arrival','visual-duration']){const field=doc.getElementById(id);if(field&&!field.reportValidity())return;}
      doc.getElementById('visual-date-go')?.click();
      const field=doc.getElementById('visual-arrival'),plan=doc.getElementById('mission-story');
      if(!field?.value||!field.checkValidity()||Number(plan?.dataset.start)!==Date.parse(field.value+'Z')/1000||doc.getElementById('story-status')?.textContent==='STALE')return;
      show(1);
    }else if(current===2){
      const mount=doc.getElementById('scene-mount'),inSurface=doc.getElementById('experience')?.dataset.mode==='surface';
      if(inSurface||['unavailable','lost'].includes(mount?.dataset.webgl))show(3);
      else{doc.getElementById('product-explore')?.click();doc.getElementById('explore-site')?.click();}
    }else if(current===3){
      doc.getElementById('hero-pause')?.click();show(4);
    }else if(current===6){
      if(searched())show(7);
      else doc.getElementById('find-opportunities')?.click();
    }else if(current===7){
      doc.getElementById('delay-shortcut')?.click();
      if(!phase('nominal'))doc.getElementById('story-nominal')?.click();
      pendingPhase='delayed';
      doc.getElementById('story-next')?.click();refresh();
    }else if(current===8){
      if(phase('recommended')){show(9);return;}
      pendingPhase='recommended';doc.getElementById('story-next')?.click();refresh();
    }else show(current+1);
  });
  doc.addEventListener('keydown',e=>{if(current>=0&&e.key==='Escape'){e.preventDefault();finish();}});
  const observer=new win.MutationObserver(refresh);
  observer.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-mode','data-webgl','data-terrain-status','data-workspace','data-kind','aria-busy','aria-pressed','disabled','hidden']});
  win.addEventListener('resize',requestPosition);win.addEventListener('scroll',requestPosition,{passive:true});refresh();
  return {start:()=>show(0),close:finish};
}
if(typeof document!=='undefined'){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>initQuickTour(),{once:true});
  else initQuickTour();
}
