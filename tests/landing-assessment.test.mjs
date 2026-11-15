import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {evaluateStart} from '../web/engine.mjs';
import {communicationDemo} from '../web/overview.mjs';
import {createLandingAssessmentCache} from '../web/landing-assessment.mjs';

const bundle=JSON.parse(await readFile(new URL('../web/data/bundle.json',import.meta.url),'utf8'));
const example=communicationDemo(bundle),utc=value=>Date.parse(value)/1000;
const inputs=Object.freeze({...example,earliest:bundle.coverage[0],latest:bundle.coverage[1]-example.durationHours*3600});

test('the displayed arrival uses unchanged authoritative PASS, FAIL, PASS decisions',()=>{
  const cache=createLandingAssessmentCache(bundle),before=JSON.stringify(inputs);
  for(const [time,status]of [[utc('2026-11-01T06:00Z'),'PASS'],[utc('2026-11-04T06:00Z'),'FAIL'],[utc('2026-11-17T03:00Z'),'PASS']]){
    const assessed=cache.assess(inputs,inputs.siteId,time,{requirementsApplied:true});
    assert.equal(assessed.status,status);assert.equal(assessed.time,time);assert(assessed.coverageComplete);
    assert.deepEqual(assessed.decision,evaluateStart(bundle,inputs,inputs.siteId,time));
    assert.equal(assessed.scheduleExcluded,false);assert(assessed.reason.length);
  }
  const failed=cache.assess(inputs,inputs.siteId,utc('2026-11-04T06:00Z'),{requirementsApplied:true});
  assert.equal(failed.limitingConstraint.id,'max_sun_block');assert.match(failed.reason,/12 h/);assert.match(failed.reason,/7 h/);
  assert.equal(JSON.stringify(inputs),before);
});

test('schedule exclusions do not masquerade as adverse lunar conditions',()=>{
  const time=utc('2026-11-17T03:00Z'),fixed={...inputs,latest:utc('2026-11-10T00:00Z')};
  const result=createLandingAssessmentCache(bundle).assess(fixed,fixed.siteId,time,{requirementsApplied:true});
  assert.equal(result.status,'FAIL');assert.equal(result.scheduleExcluded,true);
  assert.match(result.label,/schedule/i);assert.match(result.reason,/allowed|schedule/i);
  assert(result.decision.constraints.every(rule=>rule.status==='PASS'),'This is a real environmental PASS excluded only by the fixed schedule.');
});

test('out-of-cache, incomplete full duration and invalid instants never manufacture PASS',()=>{
  const cache=createLandingAssessmentCache(bundle);
  for(const time of [NaN,Infinity,bundle.coverage[0]-1,bundle.coverage[1]-3600,bundle.coverage[1]]){
    const result=cache.assess(inputs,inputs.siteId,time,{requirementsApplied:true});
    assert.equal(result.status,'INDETERMINATE');assert.equal(result.coverageComplete,false);
    assert.match(result.reason,/UTC|data|coverage|duration|validated/i);
  }
  assert.equal(cache.assess(inputs,inputs.siteId,bundle.coverage[1]-inputs.durationHours*3600,{requirementsApplied:true}).coverageComplete,true);
});

test('no requirements means no mission PASS or FAIL even at a failing example time',()=>{
  const result=createLandingAssessmentCache(bundle).assess(inputs,inputs.siteId,utc('2026-11-04T06:00Z'),{requirementsApplied:false});
  assert.equal(result.status,null);assert.equal(result.label,'Requirements not applied');assert.equal(result.decision,undefined);
  assert.equal(result.reasonCode,'NOT_APPLIED');
});

test('cache identity includes exact time, selected site and changed requirements',()=>{
  const cache=createLandingAssessmentCache(bundle),time=utc('2026-11-17T03:00Z');
  const first=cache.assess(inputs,inputs.siteId,time,{requirementsApplied:true});
  assert.strictEqual(cache.assess(inputs,inputs.siteId,time,{requirementsApplied:true}),first);
  const next=cache.assess(inputs,inputs.siteId,time+.125,{requirementsApplied:true});
  assert.equal(next.time,time+.125);assert.equal(next.decision.start,time+.125);assert.notStrictEqual(next,first);
  const changed={...inputs,minJointHours:13};
  assert.equal(cache.assess(changed,changed.siteId,time,{requirementsApplied:true}).status,'FAIL');
  const other=cache.assess(inputs,'connecting-ridge',time,{requirementsApplied:true});
  assert.deepEqual(other.decision,evaluateStart(bundle,inputs,'connecting-ridge',time));assert.notStrictEqual(other,first);
  assert.equal(cache.assess(inputs,inputs.siteId,time,{requirementsApplied:false}).status,null);
});

test('mutated caller fields invalidate cached values and returned records resist contamination',()=>{
  const cache=createLandingAssessmentCache(bundle),mutable={...inputs},time=utc('2026-11-17T03:00Z');
  const pass=cache.assess(mutable,mutable.siteId,time,{requirementsApplied:true});
  mutable.minJointHours=13;
  const fail=cache.assess(mutable,mutable.siteId,time,{requirementsApplied:true});
  assert.equal(pass.status,'PASS');assert.equal(fail.status,'FAIL');
  assert.throws(()=>{pass.decision.constraints[0].status='FAIL';},TypeError);
  assert.equal(cache.assess(inputs,inputs.siteId,time,{requirementsApplied:true}).status,'PASS');
});

test('unsupported locations and absent visibility evidence stay indeterminate',()=>{
  const cache=createLandingAssessmentCache(bundle);
  assert.equal(cache.assess(inputs,'apollo-11',inputs.nominal,{requirementsApplied:true}).status,'INDETERMINATE');
  const synthetic={coverage:[0,7200],sites:[{id:'empty'}]},request={...inputs,siteId:'empty',nominal:0,durationHours:1,minJointHours:1,minContinuousJointHours:1,earliest:0,latest:3600};
  const missing=createLandingAssessmentCache(synthetic).assess(request,'empty',0,{requirementsApplied:true});
  assert.equal(missing.status,'INDETERMINATE');assert.equal(missing.coverageComplete,false);
});

test('cache is bounded and evicts old exact-start assessments',()=>{
  const cache=createLandingAssessmentCache(bundle),time=utc('2026-11-17T03:00Z');
  const first=cache.assess(inputs,inputs.siteId,time,{requirementsApplied:true});
  for(let index=1;index<=600;index++)cache.assess(inputs,inputs.siteId,time+index,{requirementsApplied:true});
  assert(cache.size<=512);assert.notStrictEqual(cache.assess(inputs,inputs.siteId,time,{requirementsApplied:true}),first);
});

test('bundle-specific caches and bounded explanations cannot swap conservative and optimistic evidence',()=>{
  const request={...inputs,siteId:'x',nominal:0,durationHours:2,delayHours:0,maxSunHours:2,maxEarthHours:2,minJointHours:null,minContinuousJointHours:null,earliest:0,latest:3600};
  const visible={coverage:[0,14400],sites:[{id:'x',sun:[[0,3600,'uncertain'],[3600,14400,'visible']],earth:[[0,14400,'visible']]}]};
  const pass=createLandingAssessmentCache(visible).assess(request,'x',0,{requirementsApplied:true});
  assert.equal(pass.status,'PASS');assert.match(pass.reason,/at most 1 h/);
  const limited={coverage:[0,14400],sites:[{id:'x',sun:[[0,1800,'visible'],[1800,3600,'uncertain'],[3600,14400,'blocked']],earth:[[0,14400,'visible']]}]};
  const fail=createLandingAssessmentCache(limited).assess({...request,minJointHours:2},'x',0,{requirementsApplied:true});
  assert.equal(fail.status,'FAIL');assert.equal(fail.limitingConstraint.id,'min_joint_total');assert.match(fail.reason,/At most 1 h/);
});
