import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {runMission} from '../web/engine.mjs';
import {communicationDemo} from '../web/overview.mjs';

const bundle=JSON.parse(readFileSync(new URL('../web/data/bundle.json',import.meta.url)));
const missions=runMission(bundle,communicationDemo(bundle));
async function view(){
  assert(existsSync(new URL('../web/decision-evidence.mjs',import.meta.url)),'First-time decision evidence presentation is missing');
  return import('../web/decision-evidence.mjs');
}
test('nominal proof preserves conservative upper/lower bounds and positive signed margins',async()=>{
  const {constraintEvidence}=await view();
  const rows=missions.nominal.constraints.map(constraintEvidence);
  assert.equal(rows[0].metricText,'≤ 4 h 06 m 08 s');
  assert.equal(rows[0].marginText,'≥ +2 h 53 m 52 s');
  assert.equal(rows[2].metricText,'≥ 7 h 53 m 52 s');
  assert.equal(rows[2].marginText,'≥ +1 h 53 m 52 s');
  assert.deepEqual(rows.map(r=>r.status),['PASS','PASS','PASS','PASS']);
});
test('an uncertain negative margin never becomes a confirmed Earth blockage or a failed badge',async()=>{
  const {constraintEvidence}=await view();
  const source=missions.delayed.constraints[1],row=constraintEvidence(source);
  assert.equal(row.status,'INDETERMINATE');
  assert.equal(row.metricText,'≤ 12 h');
  assert.equal(row.marginText,'≥ −10 h');
  assert.equal(row.rangeText,'0 h to 12 h');
  assert.equal(row.marginRangeText,'−10 h to +2 h');
  assert.match(row.explanation,/unresolved/i);
  assert.doesNotMatch(row.explanation,/12 hours.*confirmed/i);
});
test('all selected thresholds and recovery margins are read directly from the constraint objects',async()=>{
  const {constraintEvidence}=await view();
  const rows=missions.recommended.constraints.map(constraintEvidence);
  assert.deepEqual(rows.map(r=>r.requirementText),['≤ 7 h','≤ 2 h','≥ 6 h','≥ 2 h']);
  assert.deepEqual(rows.map(r=>r.marginText),['+7 h','+2 h','+6 h','+10 h']);
  const changed={...missions.recommended.constraints[0],threshold:8.5,margin:8.5,marginRange:[8.5,8.5]};
  assert.equal(constraintEvidence(changed).requirementText,'≤ 8 h 30 m');
});
test('evidence keeps disjoint contributing segments, refuses invented zero-window witnesses and does not mutate science',async()=>{
  const {constraintSegments}=await view();
  assert.deepEqual(constraintSegments(missions.delayed.constraints[0]),[missions.delayed.constraints[0].witness]);
  assert.deepEqual(constraintSegments(missions.delayed.constraints[2]),[]);
  const input={id:'min_joint_total',witness:[0,12],witnessSegments:[[0,2],[10,12]]};
  const before=structuredClone(input);
  assert.deepEqual(constraintSegments(input),[[0,2],[10,12]]);
  assert.deepEqual(input,before);
});
test('refinement uncertainty status is retained even if the numerical margin is positive',async()=>{
  const {constraintEvidence}=await view();
  const row=constraintEvidence({...missions.recommended.constraints[0],status:'INDETERMINATE',uncertainty:'Refinement disagreement.'});
  assert.equal(row.status,'INDETERMINATE');assert.match(row.explanation,/unresolved/i);
});
