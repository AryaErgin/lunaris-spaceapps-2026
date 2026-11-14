// Planning orchestration only: all visibility classifications remain in engine.mjs.
import {runMission,evaluateStart} from './engine.mjs';

export function resolveAutomaticSchedule(coverage,next,anchor,explicit={}) {
  const changed=anchor&&(next.nominal!==anchor.nominal||next.durationHours!==anchor.durationHours);
  return {
    earliest:changed&&!explicit.earliest?coverage[0]:next.earliest,
    // Keep an automatic range well-formed when no full mission can fit; the
    // evaluator retains the full requested duration and reports missing data.
    latest:changed&&!explicit.latest?Math.max(coverage[0],coverage[1]-next.durationHours*3600):next.latest,
  };
}

export async function findLandingOpportunities(bundle,inputs,{yieldControl=async()=>{},cancelled=()=>false}={}) {
  // Use the engine's existing input/data validation, including unsupported sites.
  evaluateStart(bundle,inputs);
  const requested={...inputs},step=inputs.gridMinutes*60,lastFull=bundle.coverage[1]-inputs.durationHours*3600;
  const first=Math.max(inputs.nominal,inputs.earliest),last=inputs.latest;
  const empty=kind=>({kind,requested,recommended:null,options:[],nearMisses:[],unresolved:[],
    counts:{PASS:0,FAIL:0,INDETERMINATE:0},coverageClipped:false,
    search:{from:first,to:last,gridMinutes:inputs.gridMinutes,sites:bundle.sites.map(s=>s.id),mode:'prelaunch',candidateCount:0}});
  if(first>lastFull||last<bundle.coverage[0]||lastFull<bundle.coverage[0])return empty('NO_DATA');
  if(first>last)return empty('SCHEDULE_EMPTY');
  // Keep the requested grid phase when clipping to the finite evidence domain.
  const from=first+Math.max(0,Math.ceil((bundle.coverage[0]-first)/step-1e-12))*step,to=Math.min(last,lastFull);
  if(from>to)return empty('NO_DATA');
  const planningInputs={...inputs,nominal:from,delayHours:0,latest:to,mode:'prelaunch'};
  if(cancelled())throw new DOMException('Search inputs changed.','AbortError');
  await yieldControl(0,null);
  const result=runMission(bundle,planningInputs),options=new Map(),nearMisses=new Map(),unresolved=new Map();
  let checked=0;
  const slots=result.search.candidateCount/bundle.sites.length;
  for(let index=0;index<slots;index++)for(const site of bundle.sites) {
    const time=Math.min(to,from+index*step);
    if(cancelled())throw new DOMException('Search inputs changed.','AbortError');
    const mission=evaluateStart(bundle,planningInputs,site.id,time);
    if(mission.status==='PASS'&&!options.has(site.id))options.set(site.id,mission);
    else if(mission.status==='INDETERMINATE'&&!unresolved.has(site.id))unresolved.set(site.id,mission);
    else if(mission.status==='FAIL') {
      const failedRules=mission.constraints.filter(c=>c.status==='FAIL'),previous=nearMisses.get(site.id);
      // An explicit, unweighted ordering: fewer broken rules, then earlier UTC.
      if(!previous||failedRules.length<previous.failedRules.length)nearMisses.set(site.id,{mission,failedRules});
    }
    if(++checked%48===0)await yieldControl(checked,result.search.candidateCount);
  }
  const order=(a,b)=>a.start-b.start||Number(b.siteId===result.recommended?.siteId)-Number(a.siteId===result.recommended?.siteId)||a.siteId.localeCompare(b.siteId);
  return {kind:result.recommended?'PASS_FOUND':result.counts.INDETERMINATE?'UNRESOLVED':'NO_PASS',requested,
    recommended:result.recommended,options:[...options.values()].sort(order),
    nearMisses:[...nearMisses.values()].sort((a,b)=>a.failedRules.length-b.failedRules.length||order(a.mission,b.mission)),
    unresolved:[...unresolved.values()].sort(order),counts:result.counts,search:result.search,
    coverageClipped:first<bundle.coverage[0]||last>lastFull,
    basis:'Prelaunch site/date concepts only. All original environmental requirements retained; delay is not applied to this new-arrival search.'};
}
