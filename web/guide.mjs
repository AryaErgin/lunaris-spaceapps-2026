// Optional, non-modal guide through real controls. It never resets mission inputs.
export const GUIDE_STEPS=Object.freeze([
  {title:'Choose a place and time',description:'Choose a study point, arrival and duration, then use this plan.',workspace:'explore',selectors:['#visual-site','#visual-arrival','#visual-duration']},
  {title:'Explore the surface',description:'Open the surface and look around the lunar horizon.',workspace:'explore',selectors:['#explore-site']},
  {title:'Compare two options',description:'Change either option’s site or arrival to see the difference.',workspace:'compare',selectors:['#comparison-site-A','#comparison-arrival-A','#comparison-site-B','#comparison-arrival-B']},
  {title:'Find an opportunity',description:'Search with your current Mission arrival, duration and any enabled requirements.',workspace:'explore',selectors:['#find-opportunities']}
]);

export function initQuickTour(doc=document){
  const trigger=doc.getElementById('tour-start');
  if(!trigger||doc.getElementById('quick-tour'))return;
  const win=doc.defaultView;
  const node=(tag,className,text)=>{const n=doc.createElement(tag);n.className=className;if(text)n.textContent=text;return n;};
  const panel=node('section','quick-tour');panel.id='quick-tour';panel.hidden=true;
  panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','false');
  panel.setAttribute('aria-labelledby','quick-tour-title');panel.setAttribute('aria-describedby','quick-tour-description');
  const top=node('div','quick-tour-top'),progress=node('span','quick-tour-progress'),close=node('button','quick-tour-close','Skip tour');
  close.type='button';close.setAttribute('aria-label','Close guided walkthrough');top.append(progress,close);
  const title=node('h2',''),description=node('p','');title.id='quick-tour-title';description.id='quick-tour-description';
  const actions=node('div','quick-tour-actions'),previous=node('button','quick-tour-back','Back'),next=node('button','quick-tour-next');
  previous.type=next.type='button';actions.append(previous,next);panel.append(top,title,description,actions);doc.body.append(panel);
  let current=-1,targets=[],positionRequest=0;
  const visible=n=>n&&!n.disabled&&n.getClientRects().length>0;
  const setText=(n,value)=>{if(n.textContent!==value)n.textContent=value;};
  function clear(){for(const n of targets)n.classList.remove('quick-tour-target');targets=[];}
  function finish(){
    clear();panel.hidden=true;current=-1;trigger.setAttribute('aria-expanded','false');
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
    const ready=visible(doc.getElementById('visual-site'))||!doc.getElementById('visual-site')?.disabled;
    if(trigger.disabled===ready)trigger.disabled=!ready;
    if(current<0)return;
    // A graphics failure may switch to Advanced while the guide is open.
    if(!panel.hidden&&!panel.getClientRects().length){
      doc.body.append(panel);
      if(doc.activeElement===doc.body||!visible(doc.activeElement))next.focus({preventScroll:true});
    }
    const step=GUIDE_STEPS[current],found=step.selectors.map(s=>doc.querySelector(s)).filter(visible);
    if(found.length!==targets.length||found.some((n,i)=>n!==targets[i])){clear();targets=found;for(const n of targets)n.classList.add('quick-tour-target');}
    const mount=doc.getElementById('scene-mount');
    const inSurface=doc.getElementById('experience')?.dataset.mode==='surface';
    const unavailable=['unavailable','lost'].includes(mount?.dataset.webgl)||mount?.dataset.terrainStatus==='unavailable';
    const surface=inSurface&&mount?.dataset.terrainStatus==='ready';
    const search=doc.getElementById('landing-opportunities');
    const busy=search?.getAttribute('aria-busy')==='true';
    const searched=search&&!search.hidden&&search.dataset.kind&&!['SEARCHING','ERROR'].includes(search.dataset.kind)&&!busy;
    const label=current===0?'Use this plan':current===1?(surface||unavailable?'Compare options':inSurface?'Loading terrain…':'Open the surface'):current===2?'Find opportunities':searched?'Finish tour':busy?'Searching…':search?.dataset.kind==='ERROR'?'Retry search':'Search opportunities';
    setText(next,label);
    const blocked=current===1&&!unavailable&&(inSurface&&!surface||Boolean(doc.getElementById('explore-site')?.disabled))||current===3&&busy;
    if(next.disabled!==blocked)next.disabled=blocked;
    if(current===1&&surface)setText(description,'Drag to look around, then compare your options.');
    else if(current===1&&unavailable)setText(description,'Surface graphics are unavailable. Continue with the calculated comparisons.');
    else if(current===3&&searched)setText(description,'The search is finished. Read the result, or finish the tour.');
    requestPosition();
  }
  function show(index){
    if(index<0||index>=GUIDE_STEPS.length)return finish();
    clear();current=index;const step=GUIDE_STEPS[index];
    doc.getElementById('product-'+step.workspace)?.click();
    setText(progress,`STEP ${index+1} OF ${GUIDE_STEPS.length}`);setText(title,step.title);setText(description,step.description);
    previous.hidden=index===0;panel.hidden=false;trigger.setAttribute('aria-expanded','true');
    const slot=index===0?doc.querySelector('.scene-site-picker'):index===2?doc.getElementById('option-comparison'):doc.getElementById('mission-actions');
    slot?.after(panel);refresh();
    const first=targets[0];first?.scrollIntoView({behavior:'instant',block:'start',inline:'nearest'});
    (first??close).focus({preventScroll:true});position();
  }
  trigger.setAttribute('aria-controls',panel.id);trigger.setAttribute('aria-expanded','false');
  trigger.addEventListener('click',()=>show(0));previous.addEventListener('click',()=>show(current-1));close.addEventListener('click',finish);
  next.addEventListener('click',()=>{
    if(current===0){
      for(const id of ['visual-site','visual-arrival','visual-duration']){const field=doc.getElementById(id);if(field&&!field.reportValidity())return;}
      doc.getElementById('visual-date-go')?.click();
      const field=doc.getElementById('visual-arrival');if(!field?.value||!field.checkValidity())return;
      const plan=doc.getElementById('mission-story');
      if(Number(plan?.dataset.start)!==Date.parse(field.value+'Z')/1000||doc.getElementById('story-status')?.textContent==='STALE')return;
      show(1);
    }else if(current===1){
      if(doc.getElementById('experience')?.dataset.mode==='surface'||['unavailable','lost'].includes(doc.getElementById('scene-mount')?.dataset.webgl))show(2);
      else{doc.getElementById('product-explore')?.click();doc.getElementById('explore-site')?.click();}
    }else if(current===2)show(3);
    else if(current===3){
      const search=doc.getElementById('landing-opportunities');
      if(search&&!search.hidden&&search.dataset.kind&&!['SEARCHING','ERROR'].includes(search.dataset.kind)&&search.getAttribute('aria-busy')!=='true')finish();
      else doc.getElementById('find-opportunities')?.click();
    }
    refresh();
  });
  doc.addEventListener('keydown',e=>{if(current>=0&&e.key==='Escape'){e.preventDefault();finish();}});
  const observer=new win.MutationObserver(refresh);
  observer.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-mode','data-webgl','data-terrain-status','data-workspace','data-kind','aria-busy','disabled','hidden']});
  win.addEventListener('resize',requestPosition);win.addEventListener('scroll',requestPosition,{passive:true});refresh();
  return {start:()=>show(0),close:finish};
}

if(typeof document!=='undefined'){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>initQuickTour(),{once:true});
  else initQuickTour();
}
