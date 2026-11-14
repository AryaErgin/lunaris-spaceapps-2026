import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runMission } from '../web/engine.mjs';

const hour = 3600;
const group = (rows) => rows.map(([start, end, state]) => [start * hour, end * hour, state]);
const fullHash = (letter) => letter.repeat(64);
const visible = group([[0, 10, 'visible']]);

function evidence(sun, earth = visible) {
  return {
    sun, earth,
    refinementIntervals: { sun: { coarse: sun, fine: sun }, earth: { coarse: earth, fine: earth } },
    terrain: { warnings: [] },
  };
}

function fixture() {
  const siteId = 'fixed-point';
  const baseline = {
    version: 'phase-b-fixture', coverage: [0, 10 * hour],
    manifest: { bundleSha256: fullHash('a') },
    sites: [{ id: siteId, heightM: 2, ...evidence(group([[0, 3, 'visible'], [3, 4, 'blocked'], [4, 10, 'visible']])) }],
  };
  const overlay = {
    version: 'height-fixture', siteId, coverage: [0, 10 * hour],
    manifest: { baselineBundleSha256: fullHash('a'), bundleSha256: fullHash('b') },
    scenarios: [
      { id: 'h1m', heightM: 1, ...evidence(group([[0, 2, 'visible'], [2, 4, 'blocked'], [4, 10, 'visible']])) },
      { id: 'h2m', heightM: 2, baseline: true },
      { id: 'h5m', heightM: 5, ...evidence(visible) },
    ],
  };
  const inputs = {
    siteId, nominal: 0, earliest: 0, latest: 8 * hour, delayHours: 2, durationHours: 2,
    maxSunHours: 0.5, maxEarthHours: 0, minJointHours: 1.5, minContinuousJointHours: 1.5,
    mode: 'same-site', gridMinutes: 60,
  };
  return { baseline, overlay, inputs };
}

async function moduleUnderTest() {
  return import('../web/height.mjs').catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/web/height.mjs')) {
      assert.fail('The height study entry point must be implemented');
    }
    throw error;
  });
}

test('height sensitivity keeps the selected phase-B mission and all hard constraints', async () => {
  const { evaluateHeights } = await moduleUnderTest();
  const { baseline, overlay, inputs } = fixture();
  const { nominal, delayed } = runMission(baseline, inputs);
  const actual = evaluateHeights(baseline, overlay, inputs, delayed);
  assert.equal(actual.siteId, delayed.siteId);
  assert.equal(actual.mission_start, 2 * hour);
  assert.equal(actual.mission_end, 4 * hour);
  assert.equal(actual.source_hash, fullHash('b'));
  assert.deepEqual(actual.scenario_ids, ['h1m', 'h2m', 'h5m']);
  assert.deepEqual(actual.scenario_results.map(({ id, heightM, status }) => [id, heightM, status]), [
    ['h1m', 1, 'FAIL'], ['h2m', 2, 'FAIL'], ['h5m', 5, 'PASS'],
  ]);
  assert.equal(actual.robust_status, 'FAIL');
  assert.deepEqual(actual.scenario_results[1].constraints, delayed.constraints);
  assert.deepEqual(actual.scenario_results[1].refinement, delayed.refinement);
  assert.equal(evaluateHeights(baseline, overlay, inputs, nominal).robust_status, 'PASS');
});

test('T10 robust passes form a subset of nominal passes and shrink when adding a height', async () => {
  const { evaluateHeights } = await moduleUnderTest();
  const { baseline, overlay, inputs } = fixture();
  const candidates = [0, 1, 2, 3, 4, 5];
  const feasible = (scenarios) => candidates.filter((start) => {
    const { nominal } = runMission(baseline, { ...inputs, nominal: start * hour });
    return evaluateHeights(baseline, { ...overlay, scenarios }, inputs, nominal).robust_status === 'PASS';
  });
  assert.deepEqual(feasible(overlay.scenarios.filter(({ baseline }) => baseline)), [0, 1, 4, 5]);
  assert.deepEqual(feasible(overlay.scenarios), [0, 4, 5]);
  const fourth = { id: 'h8m', heightM: 8, ...evidence(group([[0, 4, 'visible'], [4, 6, 'blocked'], [6, 10, 'visible']])) };
  assert.deepEqual(feasible([...overlay.scenarios, fourth]), [0]);
});

test('an uncovered height remains indeterminate and cannot mask another height failure', async () => {
  const { evaluateHeights } = await moduleUnderTest();
  const { baseline, overlay, inputs } = fixture();
  overlay.scenarios[0] = {
    id: 'h1m', heightM: 1, ...evidence(group([[0, 2, 'unknown'], [2, 10, 'visible']])),
  };
  const { nominal, delayed } = runMission(baseline, inputs);
  const result = evaluateHeights(baseline, overlay, inputs, nominal);
  assert.equal(result.robust_status, 'INDETERMINATE');
  assert.ok(result.scenario_results[0].coverageWarnings.length);
  assert.equal(evaluateHeights(baseline, overlay, inputs, delayed).robust_status, 'FAIL');
});

test('limited height-study coverage does not censor the baseline phase-B scenario', async () => {
  const { evaluateHeights } = await moduleUnderTest();
  const { baseline, overlay, inputs } = fixture();
  overlay.coverage = [hour, 10 * hour];
  const { nominal } = runMission(baseline, inputs);
  const result = evaluateHeights(baseline, overlay, inputs, nominal);
  assert.equal(result.robust_status, 'INDETERMINATE');
  assert.deepEqual(result.scenario_results.map(({ status }) => status), ['INDETERMINATE', 'PASS', 'INDETERMINATE']);
  assert.deepEqual(result.scenario_results[1].constraints, nominal.constraints);
});

test('height-specific convergence checks gate an otherwise passing setting', async () => {
  const { evaluateHeights } = await moduleUnderTest();
  const { baseline, overlay, inputs } = fixture();
  const scenario = overlay.scenarios[2];
  scenario.sun = group([[0, 0.05, 'uncertain'], [0.05, 10, 'visible']]);
  scenario.refinementIntervals.sun.coarse = scenario.sun;
  const { nominal } = runMission(baseline, inputs);
  const result = evaluateHeights(baseline, overlay, inputs, nominal);
  assert.equal(result.robust_status, 'INDETERMINATE');
  assert.equal(result.scenario_results[2].refinement.status, 'UNRESOLVED');
  assert.equal(result.scenario_results[2].refinement.maxShiftSeconds, 180);
});

test('height sensitivity refuses a stale base hash or an omitted baseline and ignores different sites', async () => {
  const { evaluateHeights } = await moduleUnderTest();
  const { baseline, overlay, inputs } = fixture();
  const { nominal } = runMission(baseline, inputs);
  assert.throws(() => evaluateHeights(baseline, { ...overlay, manifest: {
    ...overlay.manifest, baselineBundleSha256: fullHash('c'),
  } }, inputs, nominal), /Phase B bundle/);
  assert.throws(() => evaluateHeights(baseline, { ...overlay,
    scenarios: overlay.scenarios.filter(({ baseline }) => !baseline),
  }, inputs, nominal), /baseline/);
  assert.equal(evaluateHeights(baseline, overlay, inputs, { ...nominal, siteId: 'other' }), null);
});
