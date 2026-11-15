// Manual exhaustive actual-data search regression; intentionally outside *.test.mjs.
// Run after annual data are generated: node tests/test_extended_planning_grid.mjs
// No raw NASA assets, dataset writes, deployment, or changed mission requirements.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {runMission,evaluateStart} from '../web/engine.mjs';

const HOUR=3600,utc=text=>Date.parse(text)/1000,iso=time=>new Date(time*1000).toISOString();
const expectedCoverage=[utc('2026-11-01T00:00:00Z'),utc('2028-01-01T00:00:00Z')];
const root=process.cwd(),bytes=await readFile(resolve(root,'web/data/bundle.json')),bundle=JSON.parse(bytes);
assert.deepEqual(bundle.coverage,expectedCoverage,'Actual 426-day data required; November fallback is not extended search evidence.');
const digest=value=>createHash('sha256').update(value).digest('hex');
const codeFiles=['web/engine.mjs','web/overview.mjs','web/search-scope.mjs','science/extended.py','tests/test_extended_planning_grid.mjs'];
const codeSha256=Object.fromEntries(await Promise.all(codeFiles.map(async name=>[name,digest(await readFile(resolve(root,name)))])));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
const work=resolve(root,'progress',`extended-planning-grid-${Date.now()}`),started=performance.now();
await mkdir(work,{recursive:true});
const evidence={status:'RUNNING',startedUtc:new Date().toISOString(),node:process.version,
  repository:{branch:git('branch','--show-current'),head:git('rev-parse','HEAD')},
  data:{fileSha256:digest(bytes),payloadSha256:bundle.manifest.bundleSha256,bytes:bytes.length,coverageUtc:bundle.coverage.map(iso)},
  codeSha256,sites:bundle.sites.map(site=>({id:site.id,latitudeNorthDeg:site.lat,longitudeEastDeg:site.lon,observerHeightM:site.heightM,groundM:site.groundM})),
  requirements:{durationHours:12,maxSunHours:7,maxEarthHours:2,minJointHours:6,minContinuousJointHours:2,
    origin:'Illustrative mission assumptions; not NASA or spacecraft specifications.'},
  scope:'Independent explicit evaluateStart enumeration compared with runMission search orchestration. This checks counts, actual UTC grid, earliest confirmed recommendation and declared tie policy; it is not independent physical-model validation or a safe-landing/trajectory claim.',
  schedule:{earliestUtc:iso(bundle.coverage[0]),latestUtc:iso(bundle.coverage[1]-12*HOUR)},
  gridMinutes:60,delaysHours:[0,72],monthly:[],prelaunchTies:[],explicitEvaluationCount:0,failures:[]};
const checkpoint=()=>writeFile(resolve(work,'report.json'),JSON.stringify(evidence,null,2));
const requirements=evidence.requirements;
const planSummary=mission=>mission?{siteId:mission.siteId,startUtc:iso(mission.start),endUtc:iso(mission.end),status:mission.status,
  conservativeMarginHours:mission.constraints.map(rule=>[rule.id,rule.marginRange[0]])}:null;
const counts=plans=>Object.fromEntries(['PASS','FAIL','INDETERMINATE'].map(status=>[status,plans.filter(plan=>plan.status===status).length]));

// Independent selection by successive semantic filters, not the production sort.
function preferredPass(plans,selectedSite){
  let options=plans.filter(plan=>plan.status==='PASS');if(!options.length)return null;
  const first=Math.min(...options.map(plan=>plan.start));options=options.filter(plan=>plan.start===first);
  if(options.some(plan=>plan.siteId===selectedSite))options=options.filter(plan=>plan.siteId===selectedSite);
  for(let index=0;index<options[0].constraints.length;index++){
    const best=Math.max(...options.map(plan=>plan.constraints[index].marginRange[0]));
    options=options.filter(plan=>plan.constraints[index].marginRange[0]===best);
  }
  return options.sort((a,b)=>a.siteId<b.siteId?-1:a.siteId>b.siteId?1:0)[0];
}

function explicit(inputs,siteIds,to){
  const first=Math.max(inputs.nominal+inputs.delayHours*HOUR,inputs.earliest),plans=[];
  for(let time=first;time<=to;time+=HOUR)for(const siteId of siteIds){
    const mission=evaluateStart(bundle,inputs,siteId,time);
    assert.equal(mission.start,time);assert.equal(mission.end,time+12*HOUR,'Month display/search bounds must never shorten the mission.');
    assert.deepEqual(mission.constraints.map(rule=>[rule.id,rule.threshold]),
      [['max_sun_block',7],['max_earth_block',2],['min_joint_total',6],['min_joint_continuous',2]]);
    plans.push(mission);evidence.explicitEvaluationCount++;
  }
  return plans;
}

function checkSearch(inputs,siteIds,to,plans){
  const original=structuredClone(inputs),result=runMission(bundle,inputs,{searchEnd:to});
  assert.deepEqual(inputs,original,'Candidate-only scope must not edit the hard mission inputs.');
  assert.deepEqual(result.counts,counts(plans));assert.equal(result.search.candidateCount,plans.length);
  assert(plans.length<10000,'Each month is deliberately below the existing enumeration guard.');
  assert.deepEqual(result.search.sites,siteIds);assert.equal(result.search.gridMinutes,60);
  assert.equal(result.search.from,Math.max(inputs.nominal+inputs.delayHours*HOUR,inputs.earliest));
  assert.equal(result.search.to,to);assert.equal(result.search.firstStart,plans[0]?.start??null);
  assert.equal(result.search.lastStart,plans.at(-1)?.start??null);
  if(to<inputs.latest){assert.equal(result.search.windowLimited,true);assert.equal(result.search.requestedTo,inputs.latest);}
  assert.deepEqual(result.nominal,evaluateStart(bundle,inputs,inputs.siteId,inputs.nominal));
  assert.deepEqual(result.delayed,evaluateStart(bundle,inputs,inputs.siteId,inputs.nominal+inputs.delayHours*HOUR));
  const expected=preferredPass(plans,inputs.siteId);assert.deepEqual(result.recommended,expected);
  for(const alternative of result.alternatives){
    assert.equal(alternative.status,'PASS');
    assert(plans.some(plan=>plan.siteId===alternative.siteId&&plan.start===alternative.start),'Every alternative must be an actual enumerated candidate.');
    assert.deepEqual(alternative,evaluateStart(bundle,inputs,alternative.siteId,alternative.start));
  }
  return result;
}

try{
  for(let month=0;month<14;month++){
    // Date.UTC carries months beyond December into the next year explicitly.
    const from=Date.UTC(2026,10+month,1)/1000,monthEnd=Date.UTC(2026,11+month,1)/1000;
    const to=Math.min(monthEnd-HOUR,bundle.coverage[1]-12*HOUR);
    const monthInputs={nominal:from,durationHours:requirements.durationHours,delayHours:0,
      maxSunHours:requirements.maxSunHours,maxEarthHours:requirements.maxEarthHours,
      minJointHours:requirements.minJointHours,minContinuousJointHours:requirements.minContinuousJointHours,
      earliest:bundle.coverage[0],latest:bundle.coverage[1]-12*HOUR,gridMinutes:60,mode:'same-site'};
    for(const site of bundle.sites)for(const delayHours of [0,72]){
      const inputs={...monthInputs,siteId:site.id,delayHours},plans=explicit(inputs,[site.id],to),result=checkSearch(inputs,[site.id],to,plans);
      if(monthEnd<bundle.coverage[1])assert(plans.at(-1).end>monthEnd,'Last starts must retain the 12-hour mission across a month seam.');
      evidence.monthly.push({siteId:site.id,calendarMonth:iso(from).slice(0,7),nominalUtc:iso(from),delayHours,
        searchedUtc:[iso(result.search.from),iso(result.search.to)],lastSampledStartUtc:iso(result.search.lastStart),
        candidateCount:result.search.candidateCount,counts:result.counts,firstConfirmedPass:planSummary(result.recommended),
        noPassMeaning:result.recommended?null:result.counts.INDETERMINATE?'No confirmed pass; some sampled starts remain unresolved.':'Every sampled start failed the unchanged requirements.',
        crossesMonthSeam:plans.at(-1).end>monthEnd});
    }
    // Independently enumerate all sites together, then exercise simultaneous-site
    // ties for every possible preferred study point.
    const allInputs={...monthInputs,siteId:bundle.sites[0].id,mode:'prelaunch'},all=explicit(allInputs,bundle.sites.map(site=>site.id),to);
    for(const preferred of bundle.sites){
      const inputs={...allInputs,siteId:preferred.id},result=checkSearch(inputs,bundle.sites.map(site=>site.id),to,all);
      const first=result.recommended?.start;
      evidence.prelaunchTies.push({calendarMonth:iso(from).slice(0,7),preferredSiteId:preferred.id,candidateCount:result.search.candidateCount,
        counts:result.counts,firstConfirmedPass:planSummary(result.recommended),
        tiedEarliestSiteIds:first===undefined?[]:all.filter(plan=>plan.status==='PASS'&&plan.start===first).map(plan=>plan.siteId)});
    }
    await checkpoint();console.log(`Checked ${iso(from).slice(0,7)}: ${bundle.sites.length} sites, hourly original/72-hour delayed starts, prelaunch ties.`);
  }
  assert.equal(evidence.monthly.length,14*bundle.sites.length*2);assert.equal(evidence.prelaunchTies.length,14*bundle.sites.length);
  evidence.status='PASS';evidence.completedUtc=new Date().toISOString();evidence.elapsedSeconds=(performance.now()-started)/1000;
  await checkpoint();console.log(`Extended planning grid PASS: ${evidence.explicitEvaluationCount} explicit mission evaluations. Evidence: ${work}`);
}catch(error){
  evidence.status='FAIL';evidence.failures.push(error.stack??String(error));evidence.elapsedSeconds=(performance.now()-started)/1000;
  await checkpoint();throw error;
}
