import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createSiteRegistry,resolveLocation,NOTABLE_SITES} from '../web/site-registry.mjs';
import {createAnalysisContext,summarizeLevelWindow} from '../web/site-analysis.mjs';
import {evaluateStart,runMission} from '../web/engine.mjs';
import {communicationDemo} from '../web/overview.mjs';
const bundle=JSON.parse(await readFile(new URL('../web/data/bundle.json',import.meta.url),'utf8'));
const inputs=communicationDemo(bundle);
const context=createAnalysisContext(bundle);
const terrainIds=bundle.sites.map(s=>s.id);

test('unified registry discovers every curated location without modifying the terrain bundle',()=>{
  const ids=bundle.sites.map(s=>s.id),registry=createSiteRegistry(bundle);
  assert.equal(registry.length,ids.length+9);
  assert.equal(new Set(registry.map(s=>s.id)).size,registry.length);
  assert.deepEqual(bundle.sites.map(s=>s.id),ids);
  for(const original of NOTABLE_SITES){
    const site=registry.find(s=>s.id===original.id);
    assert.equal(site.lat,original.lat);assert.equal(site.lon,original.lon);
    assert.equal(site.capability,'geometry-only');
    assert.equal(site.capabilities.missionEvaluation,false);
    assert.equal(site.terrainCoverage,null);
    assert.deepEqual(site.geometryCoverage,bundle.coverage);
    assert(site.coordinateStatus&&site.sourceFrame&&site.coordinateEvidence.length);
    assert.equal(site.predictionPeriodIsHistoricalReconstruction,false);
  }
  for(const site of registry.filter(s=>terrainIds.includes(s.id))){
    assert.equal(site.capability,'terrain-aware');
    assert.equal(site.capabilities.missionEvaluation,true);
    assert.deepEqual(site.terrainCoverage,bundle.coverage);
  }
  const expanded={...bundle,sites:[...bundle.sites,{...bundle.sites[0],id:'future-evidence-point'}]};
  assert.equal(createSiteRegistry(expanded).length,registry.length+1);
});

test('exact coordinates match modulo longitude; proximity and invalid coordinates never grant terrain',()=>{
  const site=bundle.sites[0];
  assert.equal(resolveLocation(bundle,{lat:site.lat,lon:site.lon-360}).id,site.id);
  assert.equal(resolveLocation(bundle,{lat:site.lat+1e-6,lon:site.lon}).capability,'geometry-only');
  assert.equal(resolveLocation(bundle,{lat:0,lon:360}).longitudeEast360,0);
  assert.equal(resolveLocation(bundle,{lat:0,lon:-180}).longitudeEast360,180);
  for(const coordinate of [{lat:91,lon:0},{lat:0,lon:361},{lat:NaN,lon:0},{lat:0,lon:'12'}])
    assert.throws(()=>resolveLocation(bundle,coordinate),/coordinate/i);
  assert.throws(()=>resolveLocation(bundle,'no-such-site'),/site/i);
});

test('permissive requirements cannot produce terrain mission verdicts for any geometry-only location',()=>{
  for(const site of NOTABLE_SITES){
    const report=context.analyzeSite({siteId:site.id,time:inputs.nominal,range:[inputs.nominal,inputs.nominal+12*3600],
      inputs:{...inputs,maxSunHours:1000,maxEarthHours:1000,minJointHours:null,minContinuousJointHours:null}});
    assert.equal(report.analysisMode,'geometry-only');
    assert.equal(report.supportStatus,'UNSUPPORTED');
    assert.equal(report.decision,null);assert.equal(report.terrainMetrics,null);
    assert(report.reasonCodes.includes('TERRAIN_NOT_AVAILABLE'));
    assert(report.levelGeometry.sun);assert(report.levelGeometry.earth);
    assert.equal(report.levelGeometry.scope,'Approximate level-horizon geometry; no terrain visibility or mission feasibility.');
    assert.throws(()=>context.replan({inputs:{...inputs,siteId:site.id}}),/terrain/i);
  }
});

test('terrain dispatch exactly preserves direct engine decisions, comparisons and demo recovery',()=>{
  const compared=context.compareSites({siteIds:[...terrainIds,'apollo-11','change-4'],time:inputs.nominal,
    range:[inputs.nominal,inputs.nominal+inputs.durationHours*3600],inputs});
  assert.equal(compared.rows.length,terrainIds.length+2);
  for(const row of compared.rows.filter(r=>terrainIds.includes(r.site.id))){
    assert.deepEqual(row.decision,evaluateStart(bundle,inputs,row.site.id));
    assert.equal(row.eligibleForTerrainComparison,true);
  }
  for(const row of compared.rows.filter(r=>!terrainIds.includes(r.site.id)))assert.equal(row.decision,null);
  assert.deepEqual(context.replan({inputs}),runMission(bundle,inputs));
  assert.deepEqual(compared.sharedWindow,[inputs.nominal,inputs.nominal+inputs.durationHours*3600]);
  assert.throws(()=>context.analyzeSite({siteId:terrainIds[0],range:[inputs.nominal,inputs.nominal+86400],inputs}),/same.*window/i);
});

test('level-horizon duration estimates use clipped interpolation, with explicit missing time and sample brackets',()=>{
  const series=[{time:0,sun:-2,earth:5},{time:1800,sun:2,earth:5},{time:3600,sun:2,earth:5}];
  const report=summarizeLevelWindow(series,'sun',300,3000,{cadenceSeconds:1800});
  assert.equal(report.aboveLevelSecondsEstimate,2100);
  assert.equal(report.belowLevelSecondsEstimate,600);
  assert.equal(report.unknownSeconds,0);
  assert.deepEqual(report.crossingEstimates,[{kind:'rises',timeEstimate:900,sampleBracket:[0,1800]}]);
  assert.equal(summarizeLevelWindow(series,'sun',-600,4200,{cadenceSeconds:1800}).unknownSeconds,1200);
  assert.equal(summarizeLevelWindow([{time:0,sun:2},{time:3600,sun:-2}],'sun',0,3600,{cadenceSeconds:1800}).unknownSeconds,3600);
  assert.equal(summarizeLevelWindow([{time:0,sun:2},{time:1800,sun:null}],'sun',0,1800,{cadenceSeconds:1800}).unknownSeconds,1800);
  assert.throws(()=>summarizeLevelWindow(series,'sun',0,Infinity),/finite/i);
});

test('seasonal/far-side geometry remains exploratory, and incomplete cached coverage is never extrapolated',()=>{
  const report=context.analyzeSite({siteId:'change-4',time:bundle.coverage[0],range:bundle.coverage});
  assert.equal(report.levelGeometry.earth.aboveLevelSecondsEstimate,0);
  assert.equal(report.levelGeometry.earth.unknownSeconds,0);
  assert(report.levelGeometry.sun.crossingEstimates.length>20);
  assert.equal(report.decision,null);
  const outside=context.analyzeSite({siteId:'apollo-11',time:bundle.coverage[1]+1,
    range:[bundle.coverage[1]-3600,bundle.coverage[1]+3600]});
  assert.equal(outside.coverageStatus,'INCOMPLETE');
  assert.equal(outside.sky,null);
  assert.equal(outside.levelGeometry.sun.unknownSeconds,3600);
  const before=context.analyzeSite({siteId:'apollo-11',time:Date.parse('1969-07-20T20:17:00Z')/1000,
    range:[0,3600]});
  assert.equal(before.coverageStatus,'INCOMPLETE');assert.equal(before.sky,null);
  assert.equal(before.levelGeometry.sun.unknownSeconds,3600);
});

test('damaged terrain metadata, missing timelines, and duplicate identities fail closed',()=>{
  const damaged={...bundle,sites:[{...bundle.sites[0],terrain:undefined}]};
  assert.equal(createSiteRegistry(damaged).find(s=>s.id===terrainIds[0]).capability,'geometry-only');
  const missing={...bundle,sites:[{...bundle.sites[0],sun:undefined}]};
  assert.equal(createAnalysisContext(missing).analyzeSite({siteId:terrainIds[0],inputs}).decision,null);
  assert.throws(()=>createSiteRegistry({...bundle,sites:[bundle.sites[0],bundle.sites[0]]}),/duplicate/i);
  assert.throws(()=>createSiteRegistry({...bundle,sites:[{...bundle.sites[0],id:'apollo-11'}]}),/collision/i);
  assert.throws(()=>createSiteRegistry({...bundle,coverage:[1,1]}),/coverage/i);
});

test('returned catalog metadata and sampled series cannot mutate future scientific reports',()=>{
  const options={siteId:'apollo-11',range:[inputs.nominal,inputs.nominal+3600],includeSeries:true};
  const original=context.analyzeSite(options),before=structuredClone(original);
  for(const row of original.levelGeometry.series)row.sun=90;
  original.site.coordinateEvidence[0].url='https://invalid.example/';
  original.site.terrainAssessment.regional.pixelsPerDegree=1;
  const after=context.analyzeSite(options);
  assert.deepEqual(after,before);
  assert.notEqual(createSiteRegistry(bundle).find(s=>s.id==='apollo-11').coordinateEvidence[0].url,'https://invalid.example/');
});

test('partial terrain metadata and frame/radius mismatch cannot retain terrain capability',()=>{
  for(const [level,field] of [['coarse','local'],['coarse','regional'],['fine','local'],['fine','regional']]){
    const site=structuredClone(bundle.sites.find(s=>s.id===inputs.siteId));delete site.terrain[level][field];
    const damaged={...bundle,sites:[site]};
    assert.equal(createSiteRegistry(damaged)[0].capability,'geometry-only',`${level}.${field}`);
    assert.equal(createAnalysisContext(damaged).analyzeSite({siteId:site.id,inputs}).decision,null);
  }
  for(const patch of [{workingFrame:'IAU_MOON'},{referenceRadiusM:6371000},{heightM:5}]){
    const site={...bundle.sites[0],...patch};
    assert.equal(createSiteRegistry({...bundle,sites:[site]})[0].capability,'geometry-only');
  }
});

test('geometry-only requirement comparisons use the same input validation as terrain decisions',()=>{
  for(const patch of [{maxSunHours:-1},{maxSunHours:NaN},{mode:'garbage'},{gridMinutes:0},{delayHours:-72}]){
    const invalid={...inputs,...patch};
    assert.throws(()=>context.analyzeSite({siteId:'apollo-11',inputs:invalid}));
    assert.throws(()=>context.compareSites({siteIds:['apollo-11','apollo-12'],inputs:invalid}));
  }
});

test('nonfinite observer radius or missing outer-ring source cannot advertise terrain support',()=>{
  const base=structuredClone(bundle.sites[0]);
  base.terrain.coarse.observerRadiusM=NaN;
  assert.equal(createSiteRegistry({...bundle,sites:[base]})[0].capability,'geometry-only');
  const expanded=structuredClone(bundle);const site=expanded.sites[0];
  expanded.manifest.files.push({filename:'outer.tif',sha256:'a'.repeat(64)});
  for(const level of ['coarse','fine'])site.terrain[level].outerRegional={...site.terrain[level].regional,
    filename:'outer.tif',spacingM:240,activeInnerM:180000,activeOuterM:240000};
  assert.equal(createSiteRegistry(expanded)[0].capability,'terrain-aware');
  const missing=structuredClone(expanded);delete missing.sites[0].terrain.fine.outerRegional;
  assert.equal(createSiteRegistry(missing)[0].capability,'geometry-only');
  const unpinned=structuredClone(expanded);unpinned.manifest.files=unpinned.manifest.files.filter(r=>r.filename!=='outer.tif');
  assert.equal(createSiteRegistry(unpinned)[0].capability,'geometry-only');
});
