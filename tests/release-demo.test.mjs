import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { evaluateStart, runMission } from '../web/engine.mjs';
import { communicationDemo } from '../web/overview.mjs';

// Fixed release fixtures from audits/LUNARIS_Codex_Release_Prompt.md, section 3.
// Read the shipped scientific cache and public evaluator; no display copy or
// synthetic replacement data participates in these assertions.
const HOUR = 3600;
const utc = (value) => Date.parse(value) / 1000;
const bundle = JSON.parse(readFileSync(new URL('../web/data/bundle.json', import.meta.url), 'utf8'));
const inputs = communicationDemo(bundle);
const result = runMission(bundle, inputs);
const site = bundle.sites.find(({ id }) => id === 'de-gerlache-rim');
const nominalStart = utc('2026-11-01T06:00:00Z');
const delayedStart = utc('2026-11-04T06:00:00Z');
const recoveryStart = utc('2026-11-17T03:00:00Z');
const nominalJointEnd = utc('2026-11-01T13:53:52Z');

function constraint(mission, id) {
  const value = mission.constraints.find((item) => item.id === id);
  assert(value, `The evaluated mission must retain ${id}`);
  return value;
}

// Independent interval intersection over source caches, rather than reuse of
// the engine's joint timeline or constraint metric implementation.
function sharedStateIntervals(channel, state, start, end) {
  const timelines = [site[channel], site.refinementIntervals[channel].coarse, site.refinementIntervals[channel].fine];
  let shared = [[start, end]];
  for (const timeline of timelines) {
    shared = shared.flatMap(([left, right]) => timeline.flatMap(([a, b, value]) => {
      const from = Math.max(left, a), to = Math.min(right, b);
      return value === state && from < to ? [[from, to]] : [];
    }));
  }
  return shared;
}

function knownJointSeconds(start, end) {
  const sun = sharedStateIntervals('sun', 'visible', start, end);
  const earth = sharedStateIntervals('earth', 'visible', start, end);
  return sun.reduce((total, [a, b]) => total + earth.reduce((duration, [c, d]) =>
    duration + Math.max(0, Math.min(b, d) - Math.max(a, c)), 0), 0);
}

test('audited joint-window preset keeps the fixed site, duration, delay, grid and all four limits', () => {
  assert.deepEqual({
    siteId: inputs.siteId, nominal: inputs.nominal, durationHours: inputs.durationHours,
    delayHours: inputs.delayHours, gridMinutes: inputs.gridMinutes, mode: inputs.mode,
    maxSunHours: inputs.maxSunHours, maxEarthHours: inputs.maxEarthHours,
    minJointHours: inputs.minJointHours, minContinuousJointHours: inputs.minContinuousJointHours,
  }, {
    siteId: 'de-gerlache-rim', nominal: nominalStart, durationHours: 12,
    delayHours: 72, gridMinutes: 60, mode: 'same-site',
    maxSunHours: 7, maxEarthHours: 2, minJointHours: 6, minContinuousJointHours: 2,
  });
  assert.equal(inputs.earliest, bundle.coverage[0]);
  assert.equal(inputs.latest, bundle.coverage[1] - 12 * HOUR);
  for (const mission of [result.nominal, result.delayed, result.recommended]) {
    assert.equal(mission.siteId, inputs.siteId);
    assert.equal(mission.end - mission.start, 12 * HOUR);
    assert.deepEqual(mission.constraints.map(({ id, threshold }) => [id, threshold]), [
      ['max_sun_block', 7], ['max_earth_block', 2],
      ['min_joint_total', 6], ['min_joint_continuous', 2],
    ]);
  }
});

test('Nov 1 nominal PASS retains at least 7 h 53 min 52 s known joint visibility and direct witnesses', () => {
  const mission = result.nominal;
  assert.equal(mission.start, nominalStart);
  assert.equal(mission.end, utc('2026-11-01T18:00:00Z'));
  assert.equal(mission.status, 'PASS');
  assert(mission.constraints.every(({ status }) => status === 'PASS'));
  const known = 7 * HOUR + 53 * 60 + 52;
  assert.equal(knownJointSeconds(mission.start, mission.end), known);
  assert(constraint(mission, 'min_joint_total').range[0] * HOUR >= known);
  assert.deepEqual(constraint(mission, 'min_joint_total').witnessSegments, [[nominalStart, nominalJointEnd]]);
  assert.deepEqual(constraint(mission, 'min_joint_continuous').witness, [nominalStart, nominalJointEnd]);
});

test('72-hour delay yields a witnessed 12-hour Sun outage and zero joint time while Earth alone remains unresolved', () => {
  const mission = result.delayed;
  const end = utc('2026-11-04T18:00:00Z');
  assert.equal(mission.start, delayedStart);
  assert.equal(mission.end, end);
  assert.equal(mission.start - result.nominal.start, 72 * HOUR);
  assert.equal(mission.status, 'FAIL');
  const sun = constraint(mission, 'max_sun_block');
  assert.deepEqual([sun.status, sun.metric, sun.threshold, sun.margin], ['FAIL', 12, 7, -5]);
  assert.deepEqual(sun.range, [12, 12]);
  assert.deepEqual(sun.witness, [delayedStart, end]);
  assert.deepEqual(sharedStateIntervals('sun', 'blocked', delayedStart, end), [[delayedStart, end]]);
  assert.deepEqual(mission.timeline.joint, [[delayedStart, end, 'blocked']]);
  assert.equal(knownJointSeconds(delayedStart, end), 0);
  for (const id of ['min_joint_total', 'min_joint_continuous']) {
    assert.equal(constraint(mission, id).status, 'FAIL');
    assert.deepEqual(constraint(mission, id).range, [0, 0]);
  }
  const earth = constraint(mission, 'max_earth_block');
  assert.equal(earth.status, 'INDETERMINATE');
  assert.deepEqual(earth.range, [0, 12]);
  assert.deepEqual(earth.marginRange, [-10, 2]);
  assert.deepEqual(mission.timeline.earth, [[delayedStart, end, 'uncertain']]);
});

test('confirmed same-site recovery is Nov 17 03:00–15:00 UTC with 12-hour joint witness and 12 d 21 h wait', () => {
  const mission = result.recommended;
  const end = utc('2026-11-17T15:00:00Z');
  assert.equal(mission.start, recoveryStart);
  assert.equal(mission.end, end);
  assert.equal(mission.status, 'PASS');
  assert(mission.constraints.every(({ status }) => status === 'PASS'));
  assert.equal(mission.start - result.delayed.start, (12 * 24 + 21) * HOUR);
  assert.equal(knownJointSeconds(recoveryStart, end), 12 * HOUR);
  assert.deepEqual(mission.timeline.joint, [[recoveryStart, end, 'visible']]);
  for (const id of ['min_joint_total', 'min_joint_continuous']) {
    assert.deepEqual(constraint(mission, id).range, [12, 12]);
    assert.deepEqual(constraint(mission, id).witness, [recoveryStart, end]);
  }
  assert.deepEqual(constraint(mission, 'min_joint_total').witnessSegments, [[recoveryStart, end]]);
  assert.equal(constraint(mission, 'max_sun_block').metric, 0);
  assert.equal(constraint(mission, 'max_earth_block').metric, 0);
});

test('independent exhaustive replay rejects all 309 earlier hourly starts: 240 FAIL and 69 INDETERMINATE', () => {
  assert.equal(result.search.firstStart, delayedStart);
  assert.equal(result.search.gridMinutes, 60);
  assert.deepEqual(result.search.sites, ['de-gerlache-rim']);
  const counts = { PASS: 0, FAIL: 0, INDETERMINATE: 0 };
  for (let start = delayedStart; start < recoveryStart; start += HOUR) {
    const mission = evaluateStart(bundle, inputs, inputs.siteId, start);
    assert.equal(mission.start, start);
    assert.equal(mission.siteId, inputs.siteId);
    counts[mission.status]++;
  }
  assert.deepEqual(counts, { PASS: 0, FAIL: 240, INDETERMINATE: 69 });
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), 309);
  const firstPass = evaluateStart(bundle, inputs, inputs.siteId, recoveryStart);
  assert.equal(firstPass.status, 'PASS');
  assert.deepEqual(firstPass, result.recommended);
});
