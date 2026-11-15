import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as engine from '../web/engine.mjs';

const HOUR = 3600;
const spans = rows => rows.map(([a,b,state]) => [a*HOUR,b*HOUR,state]);
const input = overrides => ({siteId:'ridge', nominal:6*HOUR, durationHours:30,
  delayHours:0, maxSunHours:30, maxEarthHours:30, minJointHours:null,
  minContinuousJointHours:null, earliest:6*HOUR, latest:30*HOUR,
  gridMinutes:60, mode:'same-site', ...overrides});
const fixture = () => ({coverage:[0,120*HOUR], sites:['ridge','crater','rim'].map(id => ({
  id,name:id,sun:spans([[0,120,'visible']]),earth:spans([[0,120,'visible']]),
  terrain:{warnings:[]},
}))});
async function operations() {
  try { return await import('../web/operations.mjs'); }
  catch(error) {
    if(error.code==='ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/web/operations.mjs')) {
      assert.fail('The operations data interface must be implemented');
    }
    throw error;
  }
}

test('single-start evaluation matches authoritative mission decisions without running recovery search', () => {
  assert.equal(typeof engine.evaluateStart,'function');
  const bundle=fixture(), inputs=input();
  assert.deepEqual(engine.evaluateStart(bundle,inputs,'ridge',6*HOUR),engine.runMission(bundle,inputs).nominal);
  const wide=input({latest:100000*HOUR,gridMinutes:1});
  assert.throws(()=>engine.runMission(bundle,wide),/exceeds/);
  assert.equal(engine.evaluateStart(bundle,wide,'ridge',6*HOUR).status,'PASS');
  assert.throws(()=>engine.evaluateStart(bundle,inputs,'missing',0),/no evidence/);
  assert.throws(()=>engine.evaluateStart(bundle,inputs,'ridge',Infinity),/finite/);
});

test('daily matrix anchors nominal UTC time of day and preserves schedule and cache-edge failures', async () => {
  const {feasibilityMatrix}=await operations();
  const bundle=fixture(), inputs=input(), before=JSON.stringify({bundle,inputs});
  const matrix=feasibilityMatrix(bundle,inputs,{stepHours:24});
  assert.deepEqual(matrix.starts,[6,30,54,78,102].map(t=>t*HOUR));
  assert.equal(matrix.stepHours,24);assert.equal(matrix.rows.length,3);
  for(const row of matrix.rows) {
    assert.deepEqual(row.cells.map(c=>c.status),['PASS','PASS','FAIL','FAIL','INDETERMINATE']);
    assert(row.cells[2].scheduleWarnings.length);
    assert(row.cells.at(-1).coverageWarnings.some(w=>w.includes('outside')));
    for(let i=0;i<matrix.starts.length;i++) {
      assert.deepEqual(row.cells[i],engine.evaluateStart(bundle,inputs,row.siteId,matrix.starts[i]));
      assert.equal(row.cells[i].constraints[0].threshold,inputs.maxSunHours);
      assert.equal(row.cells[i].end-row.cells[i].start,inputs.durationHours*HOUR);
    }
  }
  assert.equal(JSON.stringify({bundle,inputs}),before);
  assert.throws(()=>feasibilityMatrix(bundle,inputs,{stepHours:0}),/positive/);
  assert.throws(()=>feasibilityMatrix(bundle,inputs,{stepHours:1e-7}),/exceeds/);
});

test('matrix grid starts inside cache after a partial first UTC day', async () => {
  const {feasibilityMatrix}=await operations();
  const bundle=fixture(); bundle.coverage=[8*HOUR,50*HOUR];
  const matrix=feasibilityMatrix(bundle,input(),{stepHours:12});
  assert.deepEqual(matrix.starts,[18,30,42].map(t=>t*HOUR));
});

test('mission metrics bound unresolved runs and keep the retained state partition explicit', async () => {
  const {missionMetrics}=await operations();
  const sun=spans([[0,1,'visible'],[1,2,'uncertain'],[2,4,'blocked'],[4,5,'unknown'],[5,6,'visible']]);
  const earth=spans([[0,3,'visible'],[3,6,'blocked']]);
  const mission={start:0,end:6*HOUR,timeline:{sun,earth,joint:spans([[0,1,'visible'],[1,2,'uncertain'],[2,6,'blocked']])},coverageWarnings:['Missing terrain'],scheduleWarnings:[]};
  const result=missionMetrics(mission,{terrain:{warnings:[]}});
  assert.deepEqual([result.sun.visibleSeconds,result.sun.blockedSeconds,result.sun.unresolvedSeconds],[2,2,2].map(x=>x*HOUR));
  assert.deepEqual(result.sun.visibleRangeSeconds,[2,4].map(x=>x*HOUR));
  assert.deepEqual(result.sun.blockedRangeSeconds,[2,4].map(x=>x*HOUR));
  assert.deepEqual(result.sun.longestBlockedRangeSeconds,[2,4].map(x=>x*HOUR));
  assert.deepEqual(result.sun.longestVisibleRangeSeconds,[1,2].map(x=>x*HOUR));
  assert.deepEqual(result.joint.longestBlockedRangeSeconds,[4,5].map(x=>x*HOUR));
  assert.match(result.sun.stateTotalsBasis,/retained/i);assert.deepEqual(result.warnings,['Missing terrain']);
});

test('mission metric ranges enclose all refinements and clip unknown coverage at both edges', async () => {
  const {missionMetrics}=await operations();
  const mission={start:-HOUR,end:7*HOUR,refinement:{status:'UNRESOLVED'},
    timeline:{sun:spans([[0,6,'visible']]),earth:spans([[0,6,'visible']]),joint:spans([[0,6,'visible']])},
    coverageWarnings:[],scheduleWarnings:['Outside allowed start range']};
  const site={terrain:{warnings:['Refinement warning']},refinementIntervals:{
    sun:{coarse:spans([[0,6,'blocked']]),fine:spans([[0,3,'blocked'],[3,6,'visible']])},
    earth:{coarse:spans([[0,6,'visible']]),fine:spans([[0,6,'visible']])},
  }};
  const result=missionMetrics(mission,site);
  assert.equal(result.refinementStatus,'UNRESOLVED');
  assert.deepEqual(result.sun.longestBlockedRangeSeconds,[0,8*HOUR]);
  assert.deepEqual(result.sun.longestVisibleRangeSeconds,[0,8*HOUR]);
  assert.deepEqual(result.sun.visibleRangeSeconds,[0,8*HOUR]);
  assert.equal(result.sun.unknownSeconds,2*HOUR);
  assert.equal(result.sun.evaluations.length,3);
  assert.deepEqual(result.joint.longestBlockedRangeSeconds,[0,8*HOUR]);
  assert.match(result.basis,/not statistical/i);
  assert(result.warnings.includes('Refinement warning'));
  assert(result.warnings.includes('Outside allowed start range'));
  assert(result.warnings.some(w=>w.includes('unresolved')));
});

test('real bundle matrix and metrics reuse the exact certified start results', async () => {
  const {feasibilityMatrix,missionMetrics}=await operations();
  const bundle=JSON.parse(fs.readFileSync(new URL('../web/data/bundle.json',import.meta.url)));
  const matrix=feasibilityMatrix(bundle,bundle.demo);
  assert.equal(matrix.starts.length,Math.ceil((bundle.coverage[1]-bundle.coverage[0])/86400));
  assert.equal(matrix.rows.length,bundle.sites.length);
  for(const row of matrix.rows) for(const index of new Set([0,Math.floor(matrix.starts.length/2),matrix.starts.length-1])) {
    const mission=row.cells[index],site=bundle.sites.find(s=>s.id===row.siteId);
    assert.deepEqual(mission,engine.evaluateStart(bundle,bundle.demo,row.siteId,matrix.starts[index]));
    const metrics=missionMetrics(mission,site);
    for(const channel of ['sun','earth','joint']) {
      const m=metrics[channel];
      assert.equal(m.visibleSeconds+m.blockedSeconds+m.unresolvedSeconds,mission.end-mission.start);
      assert(m.longestBlockedRangeSeconds[0]<=m.longestBlockedRangeSeconds[1]);
      assert(m.longestVisibleRangeSeconds[0]<=m.longestVisibleRangeSeconds[1]);
    }
  }
});
