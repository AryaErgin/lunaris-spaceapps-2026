// Capability-gated adapter for the frontend. Scientific decisions stay in engine.mjs.
import {createSiteRegistry,resolveLocation,normalizeLongitudeEast} from './site-registry.mjs';
import {referenceDirections,skyAt,EARTH_DIRECTION_TOLERANCE_DEG} from './anysite.mjs';
import {evaluateStart,runMission} from './engine.mjs';
import {missionMetrics} from './operations.mjs';
import {environmentInputs} from './opportunities.mjs';
const HOUR=3600;
const SCOPE='Approximate level-horizon geometry; no terrain visibility or mission feasibility.';
function windowCheck(start,end){
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw Error('A finite increasing UTC window is required.');
}
/** Integrate only a piecewise-linear elevation approximation, never terrain visibility. */
export function summarizeLevelWindow(series,key,start,end,{cadenceSeconds=1800}={}){
  windowCheck(start,end);
  if(!['sun','earth'].includes(key)||!Number.isFinite(cadenceSeconds)||cadenceSeconds<=0)throw Error('Invalid level-geometry channel or cadence.');
  let above=0,below=0,known=0,min=null,max=null,previous=-Infinity;
  const crossingEstimates=[];
  for(const row of series){
    if(!Number.isFinite(row.time)||row.time<=previous)throw Error('Geometry samples must be ordered with unique finite times.');
    previous=row.time;
    if(row.time>=start&&row.time<=end&&Number.isFinite(row[key])){
      min=min===null?row[key]:Math.min(min,row[key]);max=max===null?row[key]:Math.max(max,row[key]);
    }
  }
  for(let i=1;i<series.length;i++){
    const a=series[i-1],b=series[i],lo=Math.max(start,a.time),hi=Math.min(end,b.time);
    if(hi<=lo||b.time-a.time>cadenceSeconds||!Number.isFinite(a[key])||!Number.isFinite(b[key]))continue;
    const value=t=>a[key]+(b[key]-a[key])*(t-a.time)/(b.time-a.time);
    const p=value(lo),q=value(hi),duration=hi-lo;
    known+=duration;
    if(p>0&&q>0)above+=duration;
    else if(p<=0&&q<=0)below+=duration;
    else{
      const root=lo-p/(q-p)*duration;
      above+=p>0?root-lo:hi-root;below+=p>0?hi-root:root-lo;
    }
    if((a[key]>0)!==(b[key]>0)){
      const root=a.time+a[key]/(a[key]-b[key])*(b.time-a.time);
      if(root>=start&&root<end&&!crossingEstimates.some(c=>c.timeEstimate===root))
        crossingEstimates.push({kind:a[key]>0?'sets':'rises',timeEstimate:root,sampleBracket:[a.time,b.time]});
    }
  }
  return {aboveLevelSecondsEstimate:above,belowLevelSecondsEstimate:below,unknownSeconds:Math.max(0,end-start-known),
    minimumSampleElevationDeg:min,maximumSampleElevationDeg:max,crossingEstimates,cadenceSeconds,
    basis:'Piecewise-linear sampled elevation above a zero-degree level horizon. Crossing brackets are sample intervals, not certified root enclosures. Narrow events between samples may be missed.'};
}
/** The caller treats the loaded scientific bundle as immutable for this context's lifetime. */
export function createAnalysisContext(bundle){
  const registry=createSiteRegistry(bundle),seriesCache=new Map();
  function seriesFor(site){
    const key=`${site.lat}:${normalizeLongitudeEast(site.lon)}`;
    if(seriesCache.has(key))return seriesCache.get(key);
    const reference=referenceDirections(bundle),series=reference.rows.map(row=>{
      const sky=skyAt(row,site.lat,site.lon);
      return {time:row.time,sun:sky?.sun.elevation??null,earth:sky?.earth.elevation??null};
    });
    const output={series,cadenceSeconds:reference.cadenceSeconds??1800,referenceSite:reference.referenceSite};
    if(seriesCache.size>=32)seriesCache.delete(seriesCache.keys().next().value);
    seriesCache.set(key,output);return output;
  }
  function analyzeSite({siteId,coordinates,time,range,inputs,includeSeries=false}={}){
    const site=resolveLocation(bundle,coordinates??siteId??inputs?.siteId);
    const from=inputs?.nominal??range?.[0]??bundle.coverage[0];
    const end=inputs?from+inputs.durationHours*HOUR:range?.[1]??bundle.coverage[1];
    windowCheck(from,end);
    if(range&&(range[0]!==from||range[1]!==end))throw Error('Comparison and requirements must use the same mission window.');
    time??=from;
    if(!Number.isFinite(time))throw Error('The requested UTC time must be finite.');
    const data=seriesFor(site),reference=referenceDirections(bundle);
    let low=0,high=reference.rows.length;
    while(low<high){const mid=(low+high)>>>1;if(reference.rows[mid].time<=time)low=mid+1;else high=mid;}
    const row=reference.rows[low-1];
    const candidate=time>=bundle.coverage[0]&&time<bundle.coverage[1]&&row&&time-row.time<data.cadenceSeconds?skyAt(row,site.lat,site.lon):null;
    const sky=candidate?{...candidate,requestedTime:time,sampleTime:row.time,sampleAgeSeconds:time-row.time}:null;
    const coverageStatus=from>=bundle.coverage[0]&&end<=bundle.coverage[1]?'COMPLETE':'INCOMPLETE';
    const terrain=site.capabilities.missionEvaluation;
    const modelInputs=inputs??environmentInputs({siteId:site.id,nominal:from,durationHours:(end-from)/HOUR,
      earliest:bundle.coverage[0],latest:Math.max(bundle.coverage[0],bundle.coverage[1]-(end-from)),delayHours:0,gridMinutes:60,mode:'same-site'});
    const evaluated=terrain?evaluateStart(bundle,modelInputs,site.id,from):null;
    return {site,analysisMode:site.capability,supportStatus:terrain?'SUPPORTED':'UNSUPPORTED',
      reasonCodes:terrain?[]:['TERRAIN_NOT_AVAILABLE'],eligibleForTerrainComparison:terrain,
      requestedWindow:[from,end],coverageStatus,sky,
      geometryApproximation:{sunDirectionToleranceDeg:.01,earthDirectionToleranceDeg:EARTH_DIRECTION_TOLERANCE_DEG,
        cadenceSeconds:data.cadenceSeconds,referenceSite:data.referenceSite,
        scope:'Sampled implementation tolerances, not a physical accuracy guarantee or event-time bound. Mean Earth range; zero-altitude reference sphere at this coordinate.'},
      levelGeometry:{scope:SCOPE,sun:summarizeLevelWindow(data.series,'sun',from,end,data),
        earth:summarizeLevelWindow(data.series,'earth',from,end,data),...(includeSeries?{series:data.series.filter(r=>r.time>=from&&r.time<=end)}:{})},
      decision:inputs&&terrain?evaluated:null,
      terrainMetrics:terrain?missionMetrics(evaluated,bundle.sites.find(s=>s.id===site.id)):null};
  }
  function compareSites({siteIds=registry.map(s=>s.id),time,range,inputs}={}){
    if(!Array.isArray(siteIds)||!siteIds.length||new Set(siteIds).size!==siteIds.length)throw Error('Comparison requires distinct site identities.');
    const rows=siteIds.map(siteId=>analyzeSite({siteId,time,range,inputs}));
    return {rows,sharedWindow:rows[0].requestedWindow,requirementsApplied:Boolean(inputs),
      basis:'All rows use identical UTC windows and supplied requirements. Level geometry and terrain evidence are different models and must not be ranked as equivalent mission verdicts.'};
  }
  function replan({inputs,searchEnd}={}){
    const selected=resolveLocation(bundle,inputs?.siteId);
    if(!selected.capabilities.recoverySearch)throw Error('Terrain evidence is required for mission evaluation and recovery search.');
    const supported=new Set(registry.filter(s=>s.capabilities.recoverySearch).map(s=>s.id));
    return runMission({...bundle,sites:bundle.sites.filter(s=>supported.has(s.id))},inputs,{searchEnd});
  }
  return {listSites:()=>structuredClone(registry),analyzeSite,compareSites,replan};
}
