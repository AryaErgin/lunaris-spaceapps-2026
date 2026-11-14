import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runMission } from '../web/engine.mjs';

const HOUR = 3600;
const baseHash = 'a'.repeat(64);
const overlayHash = 'b'.repeat(64);
const allVisible = [[0, 4 * HOUR, 'visible']];

function timeline(sun = allVisible) {
  return {
    sun,
    earth: allVisible,
    refinementIntervals: {
      sun: { coarse: sun, fine: sun },
      earth: { coarse: allVisible, fine: allVisible },
    },
    terrain: { warnings: [] },
  };
}

function fixture() {
  const phaseB = {
    coverage: [0, 4 * HOUR],
    manifest: { bundleSha256: baseHash },
    sites: [{ id: 'de-gerlache', lat: -88, lon: 292, groundM: 1790, heightM: 2, ...timeline() }],
  };
  const positions = {
    siteId: 'de-gerlache',
    coverage: [0, 4 * HOUR],
    manifest: { baselineBundleSha256: baseHash, bundleSha256: overlayHash },
    scenarios: [
      { id: 'west', label: '25 m toward negative map X', heightM: 2, lat: -88.0003, lon: 291.9997, groundM: 1788,
        ...timeline([[0, HOUR, 'blocked'], [HOUR, 4 * HOUR, 'visible']]) },
      { id: 'center', label: 'Published study point', heightM: 2, baseline: true },
      { id: 'east', label: '25 m toward positive map X', heightM: 2, lat: -87.9997, lon: 292.0003, groundM: 1791,
        ...timeline() },
    ],
  };
  const inputs = {
    siteId: 'de-gerlache', nominal: 0, durationHours: 2, delayHours: 1,
    maxSunHours: 0, maxEarthHours: 0, minJointHours: 1.5, minContinuousJointHours: 1.5,
    earliest: 0, latest: 2 * HOUR, gridMinutes: 60, mode: 'same-site',
  };
  return { phaseB, positions, inputs };
}

async function moduleUnderTest() {
  return import('../web/scenarios.mjs').catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/web/scenarios.mjs')) {
      assert.fail('The position study entry point must be implemented');
    }
    throw error;
  });
}

test('position assessment retains exact Phase B baseline, trial coordinates and separate elevations', async () => {
  const { evaluatePositions } = await moduleUnderTest();
  const { phaseB, positions, inputs } = fixture();
  const { nominal } = runMission(phaseB, inputs);
  const result = evaluatePositions(phaseB, positions, inputs, nominal);
  assert.equal(result.source_hash, overlayHash);
  assert.equal(result.siteId, nominal.siteId);
  assert.deepEqual([result.mission_start, result.mission_end], [0, 2 * HOUR]);
  assert.deepEqual(result.scenario_ids, ['west', 'center', 'east']);
  assert.deepEqual(result.scenario_results.map(({ id, label, lat, lon, groundM, heightM, status }) =>
    [id, label, lat, lon, groundM, heightM, status]), [
    ['west', '25 m toward negative map X', -88.0003, 291.9997, 1788, 2, 'FAIL'],
    ['center', 'Published study point', -88, 292, 1790, 2, 'PASS'],
    ['east', '25 m toward positive map X', -87.9997, 292.0003, 1791, 2, 'PASS'],
  ]);
  assert.equal(result.robust_status, 'FAIL');
  assert.deepEqual(result.scenario_results[1].constraints, nominal.constraints);
  assert.ok(result.scope.includes('map'));
});

test('position assessment applies all original limits and returns no recommendation', async () => {
  const { evaluatePositions } = await moduleUnderTest();
  const { phaseB, positions, inputs } = fixture();
  const { delayed } = runMission(phaseB, inputs);
  const result = evaluatePositions(phaseB, positions, inputs, delayed);
  assert.equal(result.robust_status, 'PASS');
  assert.equal(result.mission_start, HOUR);
  assert.ok(!('recommended' in result));
  assert.ok(result.scenario_results.every(({ constraints }) => constraints.length === 4));
});

test('position settings cannot include wrong instrument heights, duplicate coordinates, or a stale bundle', async () => {
  const { evaluatePositions } = await moduleUnderTest();
  const { phaseB, positions, inputs } = fixture();
  const { nominal } = runMission(phaseB, inputs);
  const [west, center, east] = positions.scenarios;
  const check = (changed) => evaluatePositions(phaseB, changed, inputs, nominal);
  assert.throws(() => check({ ...positions, scenarios: [{ ...west, heightM: 1 }, center, east] }), /fixed observer height/);
  assert.throws(() => check({ ...positions, scenarios: [{ ...west, lat: -88, lon: 292 }, center, east] }), /distinct point coordinates/);
  assert.throws(() => check({ ...positions, manifest: { ...positions.manifest, baselineBundleSha256: overlayHash } }), /Phase B bundle/);
});

test('unknown position-specific terrain prevents a robust pass despite a passing base point', async () => {
  const { evaluatePositions } = await moduleUnderTest();
  const { phaseB, positions, inputs } = fixture();
  positions.scenarios[0] = {
    ...positions.scenarios[0],
    ...timeline([[0, 4 * HOUR, 'unknown']]),
  };
  const { nominal } = runMission(phaseB, inputs);
  const result = evaluatePositions(phaseB, positions, inputs, nominal);
  assert.equal(result.robust_status, 'INDETERMINATE');
  assert.deepEqual(result.scenario_results.map(({ status }) => status), ['INDETERMINATE', 'PASS', 'PASS']);
});

test('correlated local terrain realizations preserve the observation point and use per-realization ground', async () => {
  const { evaluateTerrainRealizations } = await moduleUnderTest();
  assert.equal(typeof evaluateTerrainRealizations, 'function');
  const { phaseB, positions, inputs } = fixture();
  const { nominal } = runMission(phaseB, inputs);
  const [first, center, last] = positions.scenarios;
  const terrain = {
    ...positions,
    scenarios: [
      { ...first, id: 'clone1', label: 'Clone 001', lat: -88, lon: 292, groundM: 1789.8 },
      { ...center, label: 'Nominal DEM' },
      { ...last, id: 'clone2', label: 'Clone 002', lat: -88, lon: 292, groundM: 1790.2 },
    ],
  };
  const result = evaluateTerrainRealizations(phaseB, terrain, inputs, nominal);
  assert.equal(result.robust_status, 'FAIL');
  assert.deepEqual(result.scenario_results.map(({ id, label, lat, lon, groundM, heightM, status }) =>
    [id, label, lat, lon, groundM, heightM, status]), [
    ['clone1', 'Clone 001', -88, 292, 1789.8, 2, 'FAIL'],
    ['center', 'Nominal DEM', -88, 292, 1790, 2, 'PASS'],
    ['clone2', 'Clone 002', -88, 292, 1790.2, 2, 'PASS'],
  ]);
  assert.ok(result.scope.includes('shared regional terrain'));
  assert.deepEqual(result.scenario_results[1].constraints, nominal.constraints);
  assert.ok(!('recommended' in result));
});

test('terrain realizations reject displaced coordinates, changed heights or duplicate labels', async () => {
  const { evaluateTerrainRealizations } = await moduleUnderTest();
  assert.equal(typeof evaluateTerrainRealizations, 'function');
  const { phaseB, positions, inputs } = fixture();
  const { nominal } = runMission(phaseB, inputs);
  const [, center] = positions.scenarios;
  const clone = { id: 'clone-one', label: 'Clone 001', lat: -88, lon: 292, groundM: 1790, heightM: 2, ...timeline() };
  const evaluate = (scenarios) => evaluateTerrainRealizations(phaseB, { ...positions, scenarios }, inputs, nominal);
  assert.throws(() => evaluate([center, { ...clone, lat: -88.001 }]), /fixed observation point/);
  assert.throws(() => evaluate([center, { ...clone, heightM: 5 }]), /fixed observer height/);
  assert.throws(() => evaluate([center, clone, { ...clone, id: 'clone-other' }]), /distinct labels/);
});
