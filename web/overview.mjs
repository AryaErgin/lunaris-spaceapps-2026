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
