// Planning orchestration only: all visibility classifications remain in engine.mjs.
import {runMission,evaluateStart} from './engine.mjs';
import {missionMetrics} from './operations.mjs';

export function resolveAutomaticSchedule(coverage,next,anchor,explicit={}) {
  const changed=anchor&&(next.nominal!==anchor.nominal||next.durationHours!==anchor.durationHours);
  return {
    earliest:changed&&!explicit.earliest?coverage[0]:next.earliest,
    // Keep an automatic range well-formed when no full mission can fit; the
    // evaluator retains the full requested duration and reports missing data.
    latest:changed&&!explicit.latest?Math.max(coverage[0],coverage[1]-next.durationHours*3600):next.latest,
  };
}

export async function findLandingOpportunities(bundle,inputs,{yieldControl=async()=>{},cancelled=()=>false,environmentOnly=false,searchWindowDays,searchRange,collectAll=false}={}) {
  if(searchWindowDays!==undefined&&(!Number.isFinite(searchWindowDays)||searchWindowDays<=0))throw Error('The candidate search window must be positive finite days.');
  if(searchRange&&(![searchRange.from,searchRange.to].every(time=>Number.isFinite(time)&&Number.isFinite(new Date(time*1000).getTime()))||searchRange.from>searchRange.to))throw Error('Choose a valid From and To UTC range, with To at or after From.');
  if(collectAll&&!searchRange)throw Error('Choose an explicit UTC range to list every confirmed sampled start.');
  // Use the engine's existing input/data validation, including unsupported sites.
  evaluateStart(bundle,inputs);
  const requested={...inputs},step=inputs.gridMinutes*60,lastFull=bundle.coverage[1]-inputs.durationHours*3600;
  const first=Math.max(searchRange?.from??inputs.nominal,inputs.earliest),last=Math.min(searchRange?.to??inputs.latest,inputs.latest);
  const rangeMetadata=searchRange?{requestedRange:{...searchRange},collection:collectAll?'all-confirmed-starts':'best-per-site'}:{};
  const empty=kind=>({kind,requested,recommended:null,options:[],nearMisses:[],unresolved:[],
    ...(collectAll?{allOptions:[]}:{}),
    counts:environmentOnly?{WITH_JOINT:0,UNRESOLVED:0,NO_JOINT:0}:{PASS:0,FAIL:0,INDETERMINATE:0},coverageClipped:false,requirementsApplied:!environmentOnly,
    search:{from:first,to:last,gridMinutes:inputs.gridMinutes,sites:bundle.sites.map(s=>s.id),mode:'prelaunch',candidateCount:0,...rangeMetadata}});
  // Distinguish an unsupported requested date from an excluded allowed schedule.
  if(searchRange){
    if(searchRange.from>lastFull||searchRange.to<bundle.coverage[0]||lastFull<bundle.coverage[0])return empty('NO_DATA');
    if(first>last)return empty('SCHEDULE_EMPTY');
  }
  if(first>lastFull||last<bundle.coverage[0]||lastFull<bundle.coverage[0])return empty('NO_DATA');
  if(first>last)return empty('SCHEDULE_EMPTY');
  // Keep the requested grid phase when clipping to the finite evidence domain.
  const from=first+Math.max(0,Math.ceil((bundle.coverage[0]-first)/step-1e-12))*step,to=Math.min(last,lastFull);
  if(from>to)return empty(searchRange?'GRID_EMPTY':'NO_DATA');
  const planningInputs={...inputs,nominal:from,delayHours:0,latest:to,mode:'prelaunch'};
  if(cancelled())throw new DOMException('Search inputs changed.','AbortError');
  await yieldControl(0,null);
  const searchOptions=searchRange||searchWindowDays===undefined?{}:{searchEnd:Math.min(to,from+searchWindowDays*86400)};
  const result=runMission(bundle,planningInputs,searchOptions),options=new Map(),nearMisses=new Map(),unresolved=new Map(),allOptions=[];
  const environmentCounts={WITH_JOINT:0,UNRESOLVED:0,NO_JOINT:0};
  let checked=0;
  const slots=result.search.candidateCount/bundle.sites.length;
  for(let index=0;index<slots;index++)for(const site of bundle.sites) {
    const time=Math.min(to,from+index*step);
    if(cancelled())throw new DOMException('Search inputs changed.','AbortError');
    const mission=evaluateStart(bundle,planningInputs,site.id,time);
    if(environmentOnly){
      const metrics=missionMetrics(mission,site),range=metrics.joint.visibleRangeSeconds;
      const state=range[0]>0?'WITH_JOINT':range[1]>0?'UNRESOLVED':'NO_JOINT';environmentCounts[state]++;
      const previous=options.get(site.id);
      const view={siteId:site.id,start:mission.start,end:mission.end,metrics,timeline:mission.timeline};
      if(!previous||range[0]>previous.metrics.joint.visibleRangeSeconds[0])options.set(site.id,view);
      if(collectAll&&range[0]>0)allOptions.push(view);
    }
    else if(mission.status==='PASS'){
      if(!options.has(site.id))options.set(site.id,mission);
      if(collectAll)allOptions.push(mission);
    }
    else if(mission.status==='INDETERMINATE'&&!unresolved.has(site.id))unresolved.set(site.id,mission);
    else if(mission.status==='FAIL') {
      const failedRules=mission.constraints.filter(c=>c.status==='FAIL'),previous=nearMisses.get(site.id);
      // An explicit, unweighted ordering: fewer broken rules, then earlier UTC.
      if(!previous||failedRules.length<previous.failedRules.length)nearMisses.set(site.id,{mission,failedRules});
    }
    if(++checked%48===0)await yieldControl(checked,result.search.candidateCount);
  }
  const order=(a,b)=>a.start-b.start||Number(b.siteId===result.recommended?.siteId)-Number(a.siteId===result.recommended?.siteId)||a.siteId.localeCompare(b.siteId);
  if(environmentOnly){
    const measured=[...options.values()].sort((a,b)=>b.metrics.joint.visibleRangeSeconds[0]-a.metrics.joint.visibleRangeSeconds[0]||a.start-b.start||Number(b.siteId===inputs.siteId)-Number(a.siteId===inputs.siteId)||a.siteId.localeCompare(b.siteId));
    const recommended=measured[0]?.metrics.joint.visibleRangeSeconds[0]>0?measured[0]:null;
    return {kind:recommended?'VISIBILITY_FOUND':environmentCounts.UNRESOLVED?'UNRESOLVED':'NO_JOINT',requirementsApplied:false,requested,
      recommended,options:measured,nearMisses:[],unresolved:[],counts:environmentCounts,coverageClipped:first<bundle.coverage[0]||last>lastFull,
      ...(collectAll?{allOptions:allOptions.sort(order)}:{}),
      search:{...result.search,...rangeMetadata,tieBreak:'More confirmed joint time, then earlier UTC, selected study point, then site ID.'},
      basis:'Environmental measurements only. Per site: greatest lower-bound Sun-and-Earth overlap, then earliest checked start. No mission requirements or mission PASS/FAIL applied.'};
  }
  return {kind:result.recommended?'PASS_FOUND':result.counts.INDETERMINATE?'UNRESOLVED':'NO_PASS',requested,
    requirementsApplied:true,
    recommended:result.recommended,options:[...options.values()].sort(order),
    nearMisses:[...nearMisses.values()].sort((a,b)=>a.failedRules.length-b.failedRules.length||order(a.mission,b.mission)),
    unresolved:[...unresolved.values()].sort(order),counts:result.counts,search:{...result.search,...rangeMetadata},
    ...(collectAll?{allOptions:allOptions.sort(order)}:{}),
    coverageClipped:first<bundle.coverage[0]||last>lastFull,
    basis:'Prelaunch site/date concepts only. All original environmental requirements retained; delay is not applied to this new-arrival search.'};
}

export async function findVisibilityOpportunities(bundle,inputs,options={}) {
  // The existing engine API requires blocked-time caps. Full-window caps and no
  // joint limits merely materialize its intervals; their verdicts are discarded.
  const neutral={...environmentInputs(inputs),delayHours:0,mode:'prelaunch'};
  const report=await findLandingOpportunities(bundle,neutral,{...options,environmentOnly:true});
  report.requested=Object.fromEntries(['siteId','nominal','durationHours','earliest','latest','gridMinutes'].map(key=>[key,inputs[key]]));
  return report;
}

export function environmentInputs(inputs){
  return {...inputs,maxSunHours:inputs.durationHours,maxEarthHours:inputs.durationHours,minJointHours:null,minContinuousJointHours:null};
}

export function makeEnvironmentRecord(bundle,mission,{releaseSha=null}={}){
  const site=bundle.sites.find(s=>s.id===mission.siteId);
  if(!site)throw Error('No supported site for this environmental record.');
  return structuredClone({record_type:'environment-evidence',record_version:'1.0',requirements_applied:false,
    application_release_sha:releaseSha,bundle_payload_sha256:bundle.manifest?.bundleSha256??null,
    data_generator_commit:bundle.manifest?.engineCommit??null,
    site:{id:site.id,name:site.name,latitude_north_deg:site.lat,longitude_east_deg:site.lon,observer_height_m:site.heightM,ground_elevation_m:site.groundM,source:site.source},
    start_utc:new Date(mission.start*1000).toISOString(),end_utc:new Date(mission.end*1000).toISOString(),
    measurements:missionMetrics(mission,site),timelines:mission.timeline,
    provenance:{frame:bundle.manifest?.frame,files:bundle.manifest?.files,visibilityDefinitions:bundle.manifest?.visibilityDefinitions},
    ai_use:'OpenAI Codex and Anthropic Claude assisted project research, implementation, tests and writing. No runtime AI. Current human contributions are recorded in attribution.json.',
    scope:'Center-visibility geometry only, with bounded and unresolved intervals. No mission feasibility verdict, power, RF-link closure, landing safety or trajectory claim.'});
}
