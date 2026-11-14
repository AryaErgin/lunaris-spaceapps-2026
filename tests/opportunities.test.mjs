import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {communicationDemo} from '../web/overview.mjs';
import {evaluateStart} from '../web/engine.mjs';
import {resolveAutomaticSchedule,findLandingOpportunities,findVisibilityOpportunities,makeEnvironmentRecord} from '../web/opportunities.mjs';

const bundle=JSON.parse(await readFile(new URL('../web/data/bundle.json',import.meta.url),'utf8'));
const demo=communicationDemo(bundle),utc=s=>Date.parse(s)/1000;
test('custom arrivals replace only automatic preset bounds and duration changes extend full coverage',()=>{
  const custom={...demo,nominal:utc('2026-11-17T03:00Z'),latest:utc('2026-11-07T06:00Z')};
  assert.deepEqual(resolveAutomaticSchedule(bundle.coverage,custom,{nominal:demo.nominal,durationHours:12},{earliest:false,latest:false}),{earliest:bundle.coverage[0],latest:bundle.coverage[1]-43200});
  const short={...demo,durationHours:6};
  assert.equal(resolveAutomaticSchedule(bundle.coverage,short,demo,{earliest:false,latest:false}).latest,utc('2026-11-30T18:00Z'));
  assert.deepEqual(resolveAutomaticSchedule(bundle.coverage,custom,demo,{earliest:true,latest:true}),{earliest:custom.earliest,latest:custom.latest});
  assert.equal(resolveAutomaticSchedule(bundle.coverage,demo,demo,{earliest:false,latest:false}).latest,demo.latest,'Loading a preset must preserve its original search.');
  const long={...demo,durationHours:800};
  assert.equal(resolveAutomaticSchedule(bundle.coverage,long,demo,{earliest:false,latest:false}).latest,bundle.coverage[0],'An unsupported duration must not create an inverted automatic schedule.');
});
test('opportunity search starts at the requested arrival without borrowing the 72-hour delay or mutating inputs',async()=>{
  const inputs={...demo,nominal:utc('2026-11-17T03:00Z')},snapshot=JSON.stringify(inputs);
  const found=await findLandingOpportunities(bundle,inputs);
  assert.equal(found.kind,'PASS_FOUND');assert.equal(found.recommended.start,inputs.nominal);
  assert.equal(found.recommended.siteId,demo.siteId);assert.equal(found.search.mode,'prelaunch');assert.equal(found.search.sites.length,3);
  assert.deepEqual(found.recommended.constraints,evaluateStart(bundle,inputs,demo.siteId,inputs.nominal).constraints);
  assert.equal(found.counts.PASS+found.counts.FAIL+found.counts.INDETERMINATE,found.search.candidateCount);
  assert.equal(JSON.stringify(inputs),snapshot);assert.equal(inputs.delayHours,72);
});
test('no complete cached mission, an empty schedule, failed candidates and unresolved candidates stay distinct',async()=>{
  const future=await findLandingOpportunities(bundle,{...demo,nominal:utc('2026-12-02T00:00Z')});
  assert.equal(future.kind,'NO_DATA');assert.equal(future.search.candidateCount,0);assert.equal(future.recommended,null);
  const excluded=await findLandingOpportunities(bundle,{...demo,nominal:utc('2026-11-17T03:00Z'),latest:utc('2026-11-10T00:00Z')});
  assert.equal(excluded.kind,'SCHEDULE_EMPTY');assert.equal(excluded.counts.FAIL,0);
  const missed=await findLandingOpportunities(bundle,{...demo,nominal:utc('2026-11-04T06:00Z'),earliest:utc('2026-11-04T06:00Z'),latest:utc('2026-11-04T06:00Z')});
  assert.equal(missed.kind,'NO_PASS');assert.equal(missed.recommended,null);assert(missed.nearMisses.length);
  for(const row of missed.nearMisses){assert.equal(row.mission.status,'FAIL');assert(row.failedRules.every(r=>r.status==='FAIL'));assert.deepEqual(row.mission,evaluateStart(bundle,demo,row.mission.siteId,row.mission.start));}
  const synthetic={coverage:[0,7200],sites:[{id:'x',sun:[[0,7200,'uncertain']],earth:[[0,7200,'visible']]}]};
  const uncertain=await findLandingOpportunities(synthetic,{siteId:'x',nominal:0,durationHours:1,delayHours:72,maxSunHours:0,maxEarthHours:0,minJointHours:1,minContinuousJointHours:1,earliest:0,latest:0,gridMinutes:60,mode:'same-site'});
  assert.equal(uncertain.kind,'UNRESOLVED');assert.equal(uncertain.nearMisses.length,0);assert.equal(uncertain.unresolved.length,1);
});
test('coverage clipping keeps the requested hourly grid and search respects explicitly narrowed bounds',async()=>{
  const before=await findLandingOpportunities(bundle,{...demo,nominal:utc('2026-10-31T23:15Z'),earliest:utc('2026-10-31T23:15Z'),latest:utc('2026-11-01T01:15Z')});
  assert.equal(before.search.from,utc('2026-11-01T00:15Z'));assert(before.coverageClipped);
  const end=await findLandingOpportunities(bundle,{...demo,nominal:utc('2026-11-30T18:00Z'),durationHours:6,latest:utc('2026-11-30T18:00Z')});
  assert.equal(end.search.firstStart,utc('2026-11-30T18:00Z'));assert.equal(end.search.candidateCount,3);
  assert.equal(end.kind,'UNRESOLVED');assert.deepEqual(end.counts,{PASS:0,FAIL:2,INDETERMINATE:1});
  assert(end.options.every(m=>m.end<=bundle.coverage[1]));
});
test('candidate limits and cancellation remain explicit rather than silently changing resolution',async()=>{
  await assert.rejects(findLandingOpportunities(bundle,{...demo,gridMinutes:1}),/exceeds.*site\/start pairs/);
  await assert.rejects(findLandingOpportunities(bundle,demo,{cancelled:()=>true}),{name:'AbortError'});
});
test('environment opportunities require no mission limits and contain no PASS/FAIL verdicts',async()=>{
  const request={siteId:demo.siteId,nominal:utc('2026-11-17T03:00Z'),durationHours:12,earliest:demo.earliest,latest:demo.latest,gridMinutes:60};
  const found=await findVisibilityOpportunities(bundle,request);
  assert.equal(found.kind,'VISIBILITY_FOUND');assert.equal(found.requirementsApplied,false);
  assert.equal(found.recommended.start,request.nominal);assert.equal(found.recommended.metrics.joint.visibleRangeSeconds[0],43200);
  assert.equal(found.counts.PASS,undefined);assert(found.options.every(o=>!('status' in o)&&!('constraints' in o)));
  const impossibleLimits=await findVisibilityOpportunities(bundle,{...request,maxSunHours:0,maxEarthHours:0,minJointHours:200,minContinuousJointHours:200});
  assert.deepEqual(impossibleLimits.options,found.options,'Unapplied mission requirements cannot change environmental measurements or ranking.');
  const current=evaluateStart(bundle,demo,demo.siteId,demo.nominal),record=makeEnvironmentRecord(bundle,current,{releaseSha:'fixture-release'});
  assert.equal(record.record_type,'environment-evidence');assert.equal(record.requirements_applied,false);
  assert(!('status' in record));assert(!('constraints' in record));assert.equal(record.site.id,demo.siteId);
  assert.equal(record.measurements.earth.visibleRangeSeconds[0],43200);assert.equal(record.application_release_sha,'fixture-release');
  const synthetic={coverage:[0,7200],sites:[{id:'x',sun:[[0,7200,'uncertain']],earth:[[0,7200,'visible']]}]};
  const pending={siteId:'x',nominal:0,durationHours:1,earliest:0,latest:0,gridMinutes:60};
  const unresolved=await findVisibilityOpportunities(synthetic,pending);
  assert.equal(unresolved.kind,'UNRESOLVED');assert.equal(unresolved.recommended,null);
  assert.deepEqual(unresolved.options[0].metrics.joint.visibleRangeSeconds,[0,3600]);
  assert.deepEqual(unresolved.counts,{WITH_JOINT:0,UNRESOLVED:1,NO_JOINT:0});
  const blocked={...synthetic,sites:[{...synthetic.sites[0],sun:[[0,7200,'blocked']]}]};
  const noJoint=await findVisibilityOpportunities(blocked,pending);
  assert.equal(noJoint.kind,'NO_JOINT');assert.equal(noJoint.recommended,null);
  assert.deepEqual(noJoint.options[0].metrics.joint.visibleRangeSeconds,[0,0]);
  assert.deepEqual(noJoint.counts,{WITH_JOINT:0,UNRESOLVED:0,NO_JOINT:1});
});
