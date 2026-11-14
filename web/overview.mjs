export function visibilitySummary(timeline, start, end) {
  const seconds = {visible:0,blocked:0,uncertain:0,unknown:0};
  let cursor=start;
  for (const [a,b,state] of timeline) {
    const lo=Math.max(start,a,cursor), hi=Math.min(end,b);
    if (hi<=lo) continue;
    if (lo>cursor) seconds.unknown+=lo-cursor;
    seconds[state in seconds ? state : 'unknown']+=hi-lo;
    cursor=hi;
  }
  if(cursor<end) seconds.unknown+=end-cursor;
  return {seconds,start,end};
}

// Transition ranges are numerical/model brackets, not precise physical event times.
// A coverage gap interrupts inference; a cache edge never implies a future event.
function contiguousSegment(timeline, instant, coverage) {
  let segment=[], previousEnd=null, containsInstant=false;
  for(const [start,end,state] of timeline) {
    const a=Math.max(start,coverage[0]), b=Math.min(end,coverage[1]);
    if(b<=a) continue;
    const qualified=['visible','blocked','uncertain'].includes(state);
    if(!qualified || (previousEnd!==null && a!==previousEnd)) {
      if(containsInstant) return segment;
      segment=[]; previousEnd=null;
    }
    if(!qualified) continue;
    segment.push([a,b,state]); previousEnd=b;
    if(a<=instant && instant<b) containsInstant=true;
  }
  return containsInstant ? segment : [];
}

function transitionEvidence(timeline, instant, coverage) {
  const events={loss:null,reacquisition:null};
  if(instant<coverage[0] || instant>=coverage[1]) return events;
  const episodes=[];
  // Retain resolved history within this contiguous segment. It supplies the
  // predecessor when the probe is already inside an uncertain transition.
  for(const [a,b,state] of contiguousSegment(timeline,instant,coverage)) {
    if(state==='uncertain') continue;
    const previous=episodes.at(-1);
    if(previous?.state===state) previous.runs.push([a,b]);
    else episodes.push({state,runs:[[a,b]]});
  }
  for(let i=1;i<episodes.length;i++) {
    const before=episodes[i-1], after=episodes[i];
    const upper=after.runs[0][0];
    // An exact transition at the probe is already reflected by its new state.
    if(upper<=instant) continue;
    const key=after.state==='blocked' ? 'loss' : 'reacquisition';
    if(!events[key]) events[key]={
      interval:[Math.max(instant,before.runs.at(-1)[1]),upper],
      before:before.runs, after:after.runs,
    };
  }
  return events;
}

export function nextVisibilityEvents(timeline, instant, coverage) {
  const evidence=transitionEvidence(timeline,instant,coverage);
  const loss=evidence.loss?.interval??null, reacquisition=evidence.reacquisition?.interval??null;
  return {loss,reacquisition,censored:!loss||!reacquisition,coverageEnd:coverage[1]};
}
import {runMission} from './engine.mjs';
export function compareSites(bundle, inputs, options={}) {
 return bundle.sites.map(site=>{
  const result=runMission(bundle,{...inputs,siteId:site.id,mode:'same-site'},options);
  return {siteId:site.id,name:site.name,nominal:result.nominal,delayed:result.delayed};
 });
}
export function communicationDemo(bundle) {
 const coverage=bundle.demonstrationCoverage??bundle.coverage;
 return {...bundle.demo,maxEarthHours:2,minJointHours:6,minContinuousJointHours:2,
  earliest:Math.max(bundle.coverage[0],coverage[0]),latest:Math.min(bundle.coverage[1],coverage[1])-bundle.demo.durationHours*3600,mode:'same-site'};
}

// Enclose matching first transitions from retained, coarse and fine caches.
// Missing correspondence is not evidence of a precisely timed event.
function sharedResolvedWitness(runSets) {
 let shared=runSets[0];
 for(const runs of runSets.slice(1)) {
  const next=[];
  let i=0,j=0;
  while(i<shared.length && j<runs.length) {
   const [a,b]=shared[i], [c,d]=runs[j], left=Math.max(a,c), right=Math.min(b,d);
   if(left<right) next.push([left,right]);
   if(b<=d)i++;
   if(d<=b)j++;
  }
  shared=next;
  if(!shared.length)return false;
 }
 return shared.length>0;
}

export function refinedEvents(site,channel,instant,coverage) {
 const timelines=[site[channel],site.refinementIntervals?.[channel]?.coarse,site.refinementIntervals?.[channel]?.fine];
 const results=timelines.map(t=>transitionEvidence(t??[],instant,coverage));
 const out={loss:null,reacquisition:null,censored:true,coverageEnd:coverage[1],basis:'retained/coarse/fine event enclosure',unresolved:[]};
 for(const key of ['loss','reacquisition']) {
  // Require common resolved-state witnesses on both sides of the selected
  // episodes. A short timing separation alone cannot identify the same event.
  const events=results.map(r=>r[key]);
  if(events.every(Boolean) && sharedResolvedWitness(events.map(e=>e.before)) && sharedResolvedWitness(events.map(e=>e.after))) {
   out[key]=[Math.min(...events.map(e=>e.interval[0])),Math.max(...events.map(e=>e.interval[1]))];
   if(out[key][1]-out[key][0]>=120)out.unresolved.push(key);
  }
 }
 out.censored=!out.loss||!out.reacquisition;
 return out;
}
export function skySnapshot(site,sample,mission) {
 const snapshot={time:sample[0],refinement:mission.refinement?.status??'not supplied'};
 for(const [key,az,el,hor] of [['sun',1,2,3],['earth',4,5,6]]) {
  snapshot[key]={azimuth:Number.isFinite(sample[az])?((sample[az]%360)+360)%360:null,
   elevation:Number.isFinite(sample[el])?sample[el]:null,horizon:Number.isFinite(sample[hor])?sample[hor]:null,
   state:mission.timeline?.[key]?.find(([a,b])=>sample[0]>=a&&sample[0]<b)?.[2]??'unknown'};
 }
 return snapshot;
}
