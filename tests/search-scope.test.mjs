import test from 'node:test';
import assert from 'node:assert/strict';
import {runMission,evaluateStart,makeCertificate} from '../web/engine.mjs';
import {feasibilityMatrix} from '../web/operations.mjs';
import {communicationDemo} from '../web/overview.mjs';
import {findLandingOpportunities,findVisibilityOpportunities} from '../web/opportunities.mjs';

const DAY=86400,HOUR=3600;
const bundle={coverage:[0,400*DAY],sites:['a','b','c'].map(id=>({id,name:id,lat:-89,lon:20,heightM:2,groundM:0,
  sun:[[0,400*DAY,'visible']],earth:[[0,400*DAY,'visible']],terrain:{warnings:[]}}))};
const inputs={siteId:'a',nominal:10*DAY,durationHours:12,delayHours:72,maxSunHours:7,maxEarthHours:2,
  minJointHours:6,minContinuousJointHours:2,earliest:0,latest:400*DAY-12*HOUR,gridMinutes:60,mode:'prelaunch'};

test('candidate-only bounds preserve all hard constraints and declare unsearched dates',async()=>{
  assert.throws(()=>runMission(bundle,inputs),/exceeds/);
  const copy=structuredClone(inputs),end=13*DAY+30*DAY;
  const result=runMission(bundle,inputs,{searchEnd:end});
  assert.deepEqual(inputs,copy);
  assert.deepEqual(result.nominal,evaluateStart(bundle,inputs));
  assert.deepEqual(result.delayed,evaluateStart(bundle,inputs,'a',13*DAY));
  assert.equal(result.search.to,end);assert.equal(result.search.requestedTo,inputs.latest);
  assert.equal(result.search.windowLimited,true);assert.equal(result.search.candidateCount,721*3);
  assert.equal(result.recommended.start,13*DAY);
  const certificate=await makeCertificate(bundle,inputs,result,{role:'recommended'});
  assert.equal(certificate.search.to,end);assert.equal(certificate.search.requestedTo,inputs.latest);
  assert.equal(certificate.inputs.latest,inputs.latest);
  const shorter=await makeCertificate(bundle,inputs,runMission(bundle,inputs,{searchEnd:end-DAY}),{role:'recommended'});
  assert.notEqual(certificate.search_input_hash,shorter.search_input_hash,'Different searched windows must not share a search identity.');
  assert.equal(certificate.selected_plan_fingerprint,shorter.selected_plan_fingerprint);
});

test('invalid candidate windows cannot bypass limits or alter the UTC grid',()=>{
  for(const searchEnd of [NaN,Infinity,'bad'])assert.throws(()=>runMission(bundle,inputs,{searchEnd}),/search|candidate|finite/i);
  const small={...inputs,latest:15*DAY,gridMinutes:37};
  const limited=runMission(bundle,small,{searchEnd:14*DAY+17});
  const expected=[];for(let t=13*DAY;t<=14*DAY+17;t+=37*60)for(const site of bundle.sites)expected.push(evaluateStart(bundle,small,site.id,t));
  assert.equal(limited.search.candidateCount,expected.length);
  assert.equal(limited.counts.PASS,expected.filter(p=>p.status==='PASS').length);
  assert.equal(limited.search.lastStart,13*DAY+(expected.length/3-1)*37*60);
  assert.throws(()=>runMission(bundle,inputs,{searchEnd:inputs.latest}),/exceeds/);
});

test('calendar display range does not shorten missions at a displayed month edge',()=>{
  const request={...inputs,nominal:31*DAY+6*HOUR,durationHours:48};
  const matrix=feasibilityMatrix(bundle,request,{range:[31*DAY,59*DAY]});
  assert.equal(matrix.starts.length,28);assert.equal(matrix.starts[0],31*DAY+6*HOUR);
  assert.equal(matrix.starts.at(-1),58*DAY+6*HOUR);
  assert.equal(matrix.rows[0].cells.at(-1).end,60*DAY+6*HOUR);
  assert(matrix.rows.every(r=>r.cells.every(c=>c.status==='PASS')));
  assert.throws(()=>feasibilityMatrix(bundle,request,{range:[20,10]}),/range/i);
});

test('the fixed teaching example retains its original allowed November search',()=>{
  const data={...bundle,demo:{...inputs,durationHours:12},demonstrationCoverage:[0,30*DAY]};
  const demo=communicationDemo(data);
  assert.equal(demo.latest,30*DAY-12*HOUR);
  assert.equal(demo.earliest,0);
});

test('automatic bounds are separate from user scheduling constraints',async()=>{
  let api;try{api=await import('../web/search-scope.mjs');}catch{assert.fail('Implement the disclosed candidate-window policy');}
  const options=api.automaticSearchOptions(bundle,inputs);
  assert.deepEqual(options,{searchEnd:43*DAY});
  assert.deepEqual(api.automaticSearchOptions(bundle,{...inputs,latest:14*DAY}),{});
  assert.deepEqual(inputs.latest,400*DAY-12*HOUR);
});

test('new-arrival searches bound enumeration without adding the landing delay or relaxing user requirements',async()=>{
  for(const find of [findLandingOpportunities,findVisibilityOpportunities]){
    const copy=structuredClone(inputs),report=await find(bundle,inputs,{searchWindowDays:30});
    assert.deepEqual(inputs,copy);assert.equal(report.search.from,inputs.nominal);
    assert.equal(report.search.to,inputs.nominal+30*DAY);assert.equal(report.search.windowLimited,true);
    assert.equal(report.search.requestedTo,inputs.latest);assert.equal(report.search.candidateCount,721*3);
  }
});
