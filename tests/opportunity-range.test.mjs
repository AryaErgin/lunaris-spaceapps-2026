import test from 'node:test';
import assert from 'node:assert/strict';
import {findLandingOpportunities,findVisibilityOpportunities} from '../web/opportunities.mjs';
import {evaluateStart} from '../web/engine.mjs';
import {opportunityRange,opportunityPage,opportunityRequestInputs} from '../web/opportunity-view.mjs';

const H=3600;
const bundle={coverage:[0,40*H],sites:[
  {id:'clear',sun:[[0,40*H,'visible']],earth:[[0,40*H,'visible']]},
  {id:'unknown',sun:[[0,40*H,'uncertain']],earth:[[0,40*H,'visible']]},
  {id:'blocked',sun:[[0,40*H,'blocked']],earth:[[0,40*H,'visible']]},
]};
const inputs={siteId:'clear',nominal:10*H,durationHours:2,delayHours:72,maxSunHours:0,maxEarthHours:0,minJointHours:2,minContinuousJointHours:2,earliest:0,latest:30*H,gridMinutes:60,mode:'same-site'};
const range={from:0,to:12*H};

test('UTC range inputs are strict, ordered, and independent of mission arrival',()=>{
  const from='2027-02-01T06:15',to='2027-02-02T06:15';
  assert.deepEqual(opportunityRange(from,to,'180'),{from:Date.parse(from+'Z')/1000,to:Date.parse(to+'Z')/1000,gridMinutes:180});
  assert.throws(()=>opportunityRange(to,from,60),/To UTC must/);
  assert.throws(()=>opportunityRange('2027-02-30T06:15',to,60),/valid From/);
  assert.throws(()=>opportunityRange(from,to,0),/positive/);
});

test('range searches use automatic coverage without mutating arrival or explicit schedule',()=>{
  const snapshot=structuredClone(inputs),stale={...inputs,earliest:2*H,latest:4*H};
  const automatic=opportunityRequestInputs(bundle,stale,{gridMinutes:180},{});
  assert.equal(automatic.nominal,inputs.nominal);assert.equal(automatic.delayHours,72);
  assert.equal(automatic.earliest,0);assert.equal(automatic.latest,38*H);assert.equal(automatic.gridMinutes,180);
  assert.equal(stale.latest,4*H);assert.deepEqual(inputs,snapshot);
  const explicit=opportunityRequestInputs(bundle,stale,{gridMinutes:60},{earliest:true,latest:true});
  assert.equal(explicit.earliest,2*H);assert.equal(explicit.latest,4*H);
});

test('all sampled passing arrivals are retained without changing default per-site results',async()=>{
  const original=JSON.stringify(inputs);
  const all=await findLandingOpportunities(bundle,inputs,{searchRange:range,collectAll:true});
  assert.equal(all.search.candidateCount,39);assert.equal(all.allOptions.length,13);
  assert.equal(all.options.length,1);assert.equal(all.recommended.start,0,'A range can search earlier than the inspected arrival.');
  assert.deepEqual(all.allOptions.map(m=>m.start),Array.from({length:13},(_,i)=>i*H));
  assert.deepEqual(all.counts,{PASS:13,FAIL:13,INDETERMINATE:13});
  for(const mission of all.allOptions)assert.deepEqual(mission,evaluateStart(bundle,inputs,mission.siteId,mission.start));
  assert.equal(JSON.stringify(inputs),original);assert.equal(all.requested.nominal,10*H);
  const normal=await findLandingOpportunities(bundle,inputs);
  assert.equal(normal.options.length,1);assert.equal(normal.recommended.start,10*H);assert(!('allOptions' in normal));
});

test('environment collection lists confirmed overlap only, retaining uncertainty separately',async()=>{
  const all=await findVisibilityOpportunities(bundle,inputs,{searchRange:range,collectAll:true});
  assert.equal(all.allOptions.length,13);assert.equal(all.options.length,3);
  assert.deepEqual(all.counts,{WITH_JOINT:13,UNRESOLVED:13,NO_JOINT:13});
  assert(all.allOptions.every(view=>view.metrics.joint.visibleRangeSeconds[0]===2*H));
  assert(all.allOptions.every(view=>!('status' in view)&&!('constraints' in view)));
  assert.equal(all.options.find(view=>view.siteId==='unknown').metrics.joint.visibleRangeSeconds[0],0);
  const unknown=await findVisibilityOpportunities({...bundle,sites:[bundle.sites[1]]},{...inputs,siteId:'unknown'},{searchRange:range,collectAll:true});
  const blocked=await findVisibilityOpportunities({...bundle,sites:[bundle.sites[2]]},{...inputs,siteId:'blocked'},{searchRange:range,collectAll:true});
  assert.equal(unknown.kind,'UNRESOLVED');assert.equal(blocked.kind,'NO_JOINT');
  assert.equal(unknown.allOptions.length,0);assert.equal(blocked.allOptions.length,0);
});

test('explicit ranges preserve allowed scheduling exclusions and distinguish unsupported data',async()=>{
  const limited={...inputs,earliest:20*H,latest:24*H};
  const excluded=await findLandingOpportunities(bundle,limited,{searchRange:range,collectAll:true});
  assert.equal(excluded.kind,'SCHEDULE_EMPTY');assert.equal(excluded.search.candidateCount,0);assert.deepEqual(excluded.allOptions,[]);
  const outside=await findLandingOpportunities(bundle,limited,{searchRange:{from:50*H,to:60*H},collectAll:true});
  assert.equal(outside.kind,'NO_DATA');assert.equal(outside.counts.FAIL,0);
  const clipped=await findLandingOpportunities(bundle,{...inputs,earliest:-H,latest:45*H},{searchRange:{from:-H,to:45*H},collectAll:true});
  assert.equal(clipped.search.firstStart,0);assert.equal(clipped.search.lastStart,38*H);assert(clipped.coverageClipped);
  const gridGap=await findLandingOpportunities(bundle,{...inputs,earliest:-H},{searchRange:{from:-H/2,to:H/6},collectAll:true});
  assert.equal(gridGap.kind,'GRID_EMPTY');assert.equal(gridGap.search.candidateCount,0);
});

test('explicit range has no silent 30-day cap and retains engine candidate/cancellation guards',async()=>{
  const long={coverage:[0,100*24*H],sites:[{id:'clear',sun:[[0,100*24*H,'visible']],earth:[[0,100*24*H,'visible']]}]};
  const request={...inputs,nominal:0,latest:90*24*H};
  const found=await findLandingOpportunities(long,request,{searchWindowDays:30,searchRange:{from:0,to:40*24*H},collectAll:true});
  assert.equal(found.search.lastStart,40*24*H);assert.equal(found.allOptions.length,961);
  await assert.rejects(findLandingOpportunities(long,{...request,gridMinutes:1},{searchRange:{from:0,to:10*24*H},collectAll:true}),/exceeds 10000 site\/start pairs/);
  await assert.rejects(findLandingOpportunities(bundle,inputs,{searchRange:range,collectAll:true,cancelled:()=>true}),{name:'AbortError'});
  await assert.rejects(findLandingOpportunities(bundle,inputs,{collectAll:true}),/explicit UTC range/);
});

test('desktop page11, mobile pages and invalid bounds cannot leak extra cards',()=>{
  assert.deepEqual(opportunityPage(21,1,10),{index:1,pages:3,size:10,start:10,end:20,total:21});
  assert.deepEqual(opportunityPage(21,99,10),{index:2,pages:3,size:10,start:20,end:21,total:21});
  assert.equal(opportunityPage(21,-1,10).index,0);
  assert.deepEqual(opportunityPage(21,2,5),{index:2,pages:5,size:5,start:10,end:15,total:21});
  assert.deepEqual(opportunityPage(0,0,10),{index:0,pages:1,size:10,start:0,end:0,total:0});
  assert.throws(()=>opportunityPage(10,0,0),/valid count/);
});
