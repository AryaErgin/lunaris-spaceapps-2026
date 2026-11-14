import assert from 'node:assert/strict';
import { test } from 'node:test';

const hour = 3600;
const intervals = (rows) => rows.map(([a, b, state]) => [a * hour, b * hour, state]);
const input = (overrides = {}) => ({
  siteId: 'ridge', nominal: 0, durationHours: 10, delayHours: 0,
  maxSunHours: 4, maxEarthHours: 0, minJointHours: null,
  minContinuousJointHours: null, earliest: 0, latest: 0, gridMinutes: 60,
  mode: 'same-site', ...overrides,
});

function bundle(sun, earth = [[0, 10, 'visible']], end = 10) {
  return {
    version: 'synthetic-1', coverage: [0, end * hour],
    manifest: { files: [], frame: 'fixture', visibilityDefinitions: {}, limitations: [] },
    sites: [{
      id: 'ridge', name: 'Synthetic ridge', region: 'Fixture', lat: -89, lon: 120,
      heightM: 2, groundM: 0, source: { type: 'synthetic fixture' }, terrain: { warnings: [] },
      sun: intervals(sun), earth: intervals(earth),
    }],
  };
}

async function engine() {
  return import('../web/engine.mjs').catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/web/engine.mjs')) {
      assert.fail('The mission engine entry point must be implemented');
    }
    throw error;
  });
}

test('T07 clips half-open runs and measures joint time across disjoint spans', async () => {
  const { runMission } = await engine();
  const data = bundle([[0, 2, 'blocked'], [2, 4, 'visible'], [4, 8, 'blocked'], [8, 10, 'visible']]);
  const result = runMission(data, input({ minJointHours: 4, minContinuousJointHours: 2 })).nominal;
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.constraints.map(({ id, metric, margin, witness }) => [id, metric, margin, witness]), [
    ['max_sun_block', 4, 0, [4 * hour, 8 * hour]],
    ['max_earth_block', 0, 0, null],
    ['min_joint_total', 4, 0, [2 * hour, 10 * hour]],
    ['min_joint_continuous', 2, 0, [2 * hour, 4 * hour]],
  ]);
  assert.deepEqual(result.constraints[2].witnessSegments, [[2 * hour, 4 * hour], [8 * hour, 10 * hour]]);
  const clipped = runMission(data, input({ nominal: 3 * hour, earliest: 3 * hour, latest: 3 * hour, durationHours: 6, minJointHours: 2 })).nominal;
  assert.deepEqual(clipped.timeline.joint, intervals([[3, 4, 'visible'], [4, 8, 'blocked'], [8, 9, 'visible']]));
});

test('T08 data boundary censors an otherwise fully lit mission and an observed failure', async () => {
  const { runMission } = await engine();
  const constraints = input({ nominal: 5 * hour, earliest: 0, latest: 5 * hour });
  const lit = runMission(bundle([[0, 10, 'visible']]), constraints).nominal;
  assert.equal(lit.status, 'INDETERMINATE');
  assert.deepEqual(lit.timeline.sun.at(-1), [10 * hour, 15 * hour, 'unknown']);
  const fail = runMission(bundle([[0, 10, 'blocked']]), constraints).nominal;
  assert.equal(fail.status, 'INDETERMINATE');
  assert.ok(fail.coverageWarnings.length);
});

test('T09 physical gaps preclude an unqualified pass but cannot erase a known failure', async () => {
  const { runMission } = await engine();
  const inputWithLooseLimit = input({ maxSunHours: 9 });
  const data = bundle([[0, 5, 'blocked'], [6, 10, 'visible']]);
  const { nominal } = runMission(data, inputWithLooseLimit);
  assert.equal(nominal.status, 'INDETERMINATE');
  assert.deepEqual(nominal.constraints[0].range, [5, 6]);
  assert.ok(nominal.coverageWarnings.length);
  assert.equal(runMission(data, input()).nominal.status, 'FAIL');
});

test('bounded crossing uncertainty permits proven decisions and leaves threshold overlap unresolved', async () => {
  const { runMission } = await engine();
  const data = bundle([[0, 5, 'blocked'], [5, 6, 'uncertain'], [6, 10, 'visible']]);
  const solve = (maxSunHours) => runMission(data, input({ maxSunHours })).nominal;
  assert.equal(solve(6).status, 'PASS');
  assert.equal(solve(5.5).status, 'INDETERMINATE');
  assert.equal(solve(4).status, 'FAIL');
  assert.deepEqual(solve(5.5).constraints[0].marginRange, [-0.5, 0.5]);
});

test('delay tolerance selects the connected component and returns the exact fractional crossing', async () => {
  const { runMission } = await engine();
  const data = bundle(
    [[0, 3, 'visible'], [3, 5, 'blocked'], [5, 12, 'visible']],
    [[0, 12, 'visible']], 12,
  );
  const result = runMission(data, input({
    earliest: 0, latest: 10 * hour, durationHours: 2, maxSunHours: 2,
    minJointHours: 1.5, minContinuousJointHours: 1.25, delayHours: 2,
  }));
  assert.equal(result.nominal.status, 'PASS');
  assert.equal(result.delayed.status, 'FAIL');
  assert.equal(result.recommended.start, 5 * hour);
  assert.deepEqual(result.delayTolerance, { until: 1.5 * hour, hours: 1.5 });
  assert.equal(result.counts.PASS, 6);
  assert.equal(result.counts.FAIL, 3);
});

test('delay tolerance stops when an interval with missing terrain starts to overlap', async () => {
  const { runMission } = await engine();
  const data = bundle(
    [[0, 4, 'visible'], [4, 5, 'unknown'], [5, 9, 'visible']],
    [[0, 9, 'visible']], 9,
  );
  const result = runMission(data, input({
    latest: 7 * hour, maxSunHours: 10, durationHours: 2, delayHours: 3,
  }));
  assert.deepEqual(result.delayTolerance, { until: 2 * hour, hours: 2 });
  assert.equal(result.delayed.status, 'INDETERMINATE');
  assert.equal(result.recommended.start, 5 * hour);
});

test('T11 search counts match an independent exhaustive integer-grid oracle', async () => {
  const { runMission } = await engine();
  const sun =     [true, false, false, true, true, false, true, true, true];
  const earth =   [true, true, false, true, true,  true, false, true, true];
  const byHour = (values) => values.map((visible, i) => [i, i + 1, visible ? 'visible' : 'blocked']);
  const data = bundle(byHour(sun), byHour(earth), 9);
  const candidateStarts = [1, 2, 3, 4, 5, 6];
  const expected = candidateStarts.filter((start) => {
    const solarBits = sun.slice(start, start + 3).map(Number).join('');
    const earthBits = earth.slice(start, start + 3).map(Number).join('');
    return !solarBits.includes('00') && !earthBits.includes('00') &&
      [0, 1, 2].filter((offset) => sun[start + offset] && earth[start + offset]).length >= 2;
  });
  const mission = input({ durationHours: 3, maxSunHours: 1, maxEarthHours: 1,
    minJointHours: 2, delayHours: 1, latest: 6 * hour });
  const result = runMission(data, mission);
  assert.deepEqual(expected, [2, 3, 6]);
  assert.equal(result.search.candidateCount, candidateStarts.length);
  assert.deepEqual(result.counts, { PASS: expected.length, FAIL: 3, INDETERMINATE: 0 });
  assert.equal(result.recommended.start, expected[0] * hour);
  assert.deepEqual(result.alternatives.map(({ start }) => start), [2 * hour, 3 * hour, 6 * hour]);
  const individual = candidateStarts.filter((start) =>
    runMission(data, input({ ...mission, nominal: start * hour, earliest: start * hour, latest: start * hour, delayHours: 0 })).counts.PASS);
  assert.deepEqual(individual, expected);
});

test('T10 synthetic robust intersection is contained in nominal and shrinks with scenarios', async () => {
  const { runMission } = await engine();
  const data = [
    bundle([[0, 5, 'visible'], [5, 6, 'blocked'], [6, 10, 'visible']]),
    bundle([[0, 4, 'visible'], [4, 6, 'blocked'], [6, 10, 'visible']]),
    bundle([[0, 3, 'visible'], [3, 6, 'blocked'], [6, 10, 'visible']]),
  ];
  const starts = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const testStarts = (scenarios) => starts.filter((start) => scenarios.every((scenario) =>
    runMission(scenario, input({ nominal: start * hour, latest: start * hour, durationHours: 2,
      maxSunHours: 0 })).nominal.status === 'PASS'));
  const nominal = testStarts(data.slice(0, 1));
  assert.deepEqual(nominal, [0, 1, 2, 3, 6, 7, 8]);
  const two = testStarts(data.slice(0, 2));
  assert.deepEqual(two, [0, 1, 2, 6, 7, 8]);
  assert.deepEqual(testStarts(data), [0, 1, 6, 7, 8]);
});

test('cross-site alternatives require prelaunch mode and ties favor the original site', async () => {
  const { runMission } = await engine();
  const data = bundle([[0, 2, 'blocked'], [2, 10, 'visible']]);
  data.sites.push({ ...data.sites[0], id: 'other', sun: intervals([[0, 10, 'visible']]) });
  const mission = input({ durationHours: 2, latest: 4 * hour, maxSunHours: 0 });
  assert.equal(runMission(data, mission).recommended.start, 2 * hour);
  const prelaunch = runMission(data, { ...mission, mode: 'prelaunch' });
  assert.equal(prelaunch.recommended.siteId, 'other');
  assert.equal(prelaunch.recommended.start, 0);
  const tie = runMission(data, { ...mission, delayHours: 2, mode: 'prelaunch' });
  assert.equal(tie.recommended.siteId, 'ridge');
});

test('unrepresentable time inputs are rejected before they can corrupt the grid or certificate', async () => {
  const { runMission } = await engine();
  const data = bundle([[0, 10, 'visible']]);
  assert.throws(() => runMission(data, input({ gridMinutes: Number.MAX_VALUE })), /gridMinutes/);
  assert.throws(() => runMission(data, input({ maxSunHours: Number.MAX_VALUE })), /maxSunHours/);
});

test('a positive duration smaller than the UTC timestamp resolution cannot yield an empty passing mission', async () => {
  const { runMission } = await engine();
  const data = bundle([[0, 10, 'visible']]);
  const now = 1_793_491_200;
  data.coverage = data.coverage.map((time) => time + now);
  for (const site of data.sites) {
    for (const channel of ['sun', 'earth']) {
      site[channel] = site[channel].map(([start, end, state]) => [start + now, end + now, state]);
    }
  }
  const mission = input({ nominal: now, earliest: now, latest: now, maxSunHours: 0 });
  assert.throws(() => runMission(data, { ...mission, durationHours: 1e-12 }), /timestamp resolution/);
  assert.equal(runMission(data, { ...mission, durationHours: 1 / hour }).nominal.end, now + 1);
});

test('T06 withholds a pass at a 120-second clipped bound shift', async () => {
  const { runMission } = await engine();
  const data = bundle([[0, 2, 'blocked'], [2, 2.25, 'uncertain'], [2.25, 10, 'visible']]);
  const [site] = data.sites;
  site.refinementIntervals = {
    sun: {
      coarse: site.sun,
      fine: intervals([[0, 2, 'blocked'], [2, 2.25 - 1/30, 'uncertain'], [2.25 - 1/30, 10, 'visible']]),
    },
    earth: { coarse: site.earth, fine: site.earth },
  };
  const result = runMission(data, input({ durationHours: 4, latest: 3 * hour, delayHours: 0 }));
  assert.equal(result.nominal.status, 'INDETERMINATE');
  assert.equal(result.nominal.constraints[0].status, 'INDETERMINATE');
  assert.equal(result.nominal.constraints[1].status, 'PASS');
  assert.equal(result.nominal.refinement.status, 'UNRESOLVED');
  assert.equal(result.nominal.refinement.maxShiftSeconds, 120);
  assert.equal(result.nominal.refinement.coarseStatus, 'PASS');
  assert.equal(result.nominal.refinement.fineStatus, 'PASS');
  assert.equal(result.recommended.start, 3 * hour);
  assert.deepEqual(result.counts, { PASS: 1, FAIL: 0, INDETERMINATE: 3 });
  assert.equal(result.delayTolerance, null);
});

test('T06 reports a coarse/fine decision disagreement on a threshold-overlapping bound', async () => {
  const { runMission } = await engine();
  const data = bundle([[0, 2, 'blocked'], [2, 2.025, 'uncertain'], [2.025, 10, 'visible']]);
  const [site] = data.sites;
  site.refinementIntervals = {
    sun: {
      coarse: site.sun,
      fine: intervals([[0, 2, 'blocked'], [2, 10, 'visible']]),
    },
    earth: { coarse: site.earth, fine: site.earth },
  };
  const result = runMission(data, input({ durationHours: 4, maxSunHours: 2.01 }));
  assert.equal(result.nominal.status, 'INDETERMINATE');
  assert.equal(result.nominal.refinement.coarseStatus, 'INDETERMINATE');
  assert.equal(result.nominal.refinement.fineStatus, 'PASS');
  assert.equal(result.nominal.refinement.classificationFlip, true);
  assert.ok(result.nominal.coverageWarnings.some((note) => note.includes('disagree')));
});

test('T06 preserves a failure established by both refinements', async () => {
  const { runMission } = await engine();
  const data = bundle([[0, 2, 'blocked'], [2, 2.25, 'uncertain'], [2.25, 10, 'visible']]);
  const [site] = data.sites;
  site.refinementIntervals = {
    sun: {
      coarse: site.sun,
      fine: intervals([[0, 2, 'blocked'], [2, 10, 'visible']]),
    },
    earth: { coarse: site.earth, fine: site.earth },
  };
  const result = runMission(data, input({ durationHours: 4, maxSunHours: 1 }));
  assert.equal(result.nominal.status, 'FAIL');
  assert.equal(result.nominal.constraints[0].status, 'FAIL');
  assert.equal(result.nominal.refinement.status, 'UNRESOLVED');
  assert.equal(result.nominal.refinement.coarseStatus, 'FAIL');
  assert.equal(result.nominal.refinement.fineStatus, 'FAIL');
});

test('T06 gives a conflicting retained failure the same decision in the detail and search paths', async () => {
  const { runMission } = await engine();
  const data = bundle([[0, 10, 'blocked']]);
  const [site] = data.sites;
  const visible = intervals([[0, 10, 'visible']]);
  site.refinementIntervals = {
    sun: { coarse: visible, fine: visible },
    earth: { coarse: site.earth, fine: site.earth },
  };
  const result = runMission(data, input({ maxSunHours: 0 }));
  assert.equal(result.nominal.status, 'INDETERMINATE');
  assert.equal(result.delayed.status, 'INDETERMINATE');
  assert.equal(result.nominal.refinement.status, 'UNRESOLVED');
  assert.ok(result.nominal.coverageWarnings.some((note) => note.includes('matching support')));
  assert.deepEqual(result.counts, { PASS: 0, FAIL: 0, INDETERMINATE: 1 });
  assert.equal(result.recommended, null);
});

test('T06 delay tolerance cannot bridge an internal convergence exclusion', async () => {
  const { runMission } = await engine();
  const data = bundle([[0, 2, 'visible'], [2, 2.5, 'uncertain'], [2.5, 10, 'visible']]);
  const [site] = data.sites;
  site.refinementIntervals = {
    sun: {
      coarse: site.sun,
      fine: intervals([[0, 10, 'visible']]),
    },
    earth: { coarse: site.earth, fine: site.earth },
  };
  const mission = input({ durationHours: 1, latest: 9*hour, delayHours: 1.5 });
  const result = runMission(data, mission);
  const tolerance = result.delayTolerance;
  assert.equal(result.nominal.status, 'PASS');
  assert.equal(result.delayed.status, 'INDETERMINATE');
  assert.equal(tolerance.kind, 'lower-bound');
  assert.ok(tolerance.stopReason);
  assert.ok(tolerance.until >= 3719 && tolerance.until < 3720);
  assert.equal(runMission(data, { ...mission, nominal: tolerance.until, delayHours: 0 }).nominal.status, 'PASS');
  assert.equal(runMission(data, { ...mission, nominal: 3720, delayHours: 0 }).nominal.status, 'INDETERMINATE');
  assert.equal(runMission(data, { ...mission, nominal: 4*hour, delayHours: 0 }).nominal.status, 'PASS');
});

test('T12 certificate metrics, IDs and statuses are reproducible offline', async () => {
  const { runMission, makeCertificate } = await engine();
  const data = bundle([[0, 10, 'visible']]);
  const mission = input();
  const a = await makeCertificate(data, mission, runMission(data, mission));
  const b = await makeCertificate(structuredClone(data), mission, runMission(data, mission));
  assert.ok(a.created_utc.endsWith('Z'));
  assert.match(a.input_hash, /^[0-9a-f]{64}$/);
  assert.match(a.data_bundle_hash, /^[0-9a-f]{64}$/);
  assert.equal(a.nominal_result.status, 'PASS');
  assert.equal(a.recommended_result.siteId, 'ridge');
  assert.equal(a.mission_end_utc, '1970-01-01T10:00:00.000Z');
  delete a.created_utc;
  delete b.created_utc;
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
