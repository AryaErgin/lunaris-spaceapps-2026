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
export function nextVisibilityEvents(timeline, instant, coverage) {
  const result={loss:null,reacquisition:null,censored:false,coverageEnd:coverage[1]};
  if(instant<coverage[0] || instant>=coverage[1]) return {...result,censored:true};
  let previous=null, previousEnd=null, cursor=instant;
  for(const [a,b,state] of timeline) {
    if(b<=instant) continue;
    if(a>=coverage[1]) break;
    if(a>cursor || state==='unknown') { result.censored=true; break; }
    if(state==='visible' || state==='blocked') {
      if(previous && previous!==state) {
        const key=state==='blocked' ? 'loss' : 'reacquisition';
        if(!result[key]) result[key]=[Math.max(instant,previousEnd),a];
      }
      previous=state; previousEnd=b;
    }
    cursor=Math.min(b,coverage[1]);
    if(result.loss && result.reacquisition) break;
  }
  if(!result.loss || !result.reacquisition) result.censored=true;
  return result;
}
import {runMission} from './engine.mjs';
export function compareSites(bundle, inputs) {
 return bundle.sites.map(site=>{
  const result=runMission(bundle,{...inputs,siteId:site.id,mode:'same-site'});
  return {siteId:site.id,name:site.name,nominal:result.nominal,delayed:result.delayed};
 });
}
export function communicationDemo(bundle) {
 return {...bundle.demo,maxEarthHours:2,minJointHours:6,minContinuousJointHours:2,
  earliest:bundle.coverage[0],latest:bundle.coverage[1]-bundle.demo.durationHours*3600,mode:'same-site'};
}

// Enclose matching first transitions from retained, coarse and fine caches.
// Missing correspondence is not evidence of a precisely timed event.
export function refinedEvents(site,channel,instant,coverage) {
 const timelines=[site[channel],site.refinementIntervals?.[channel]?.coarse,site.refinementIntervals?.[channel]?.fine];
 const results=timelines.map(t=>nextVisibilityEvents(t??[],instant,coverage));
 const out={loss:null,reacquisition:null,censored:true,coverageEnd:coverage[1],basis:'retained/coarse/fine event enclosure',unresolved:[]};
 for(const key of ['loss','reacquisition']) {
  if(results.every(r=>r[key])) {
   out[key]=[Math.min(...results.map(r=>r[key][0])),Math.max(...results.map(r=>r[key][1]))];
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
