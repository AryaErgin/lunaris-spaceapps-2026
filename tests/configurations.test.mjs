import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { makeCertificate, runMission } from '../web/engine.mjs';
import { communicationDemo } from '../web/overview.mjs';
import { evaluateHeights, evaluatePositions, evaluateTerrainRealizations } from '../web/scenarios.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(`../web/data/${name}.json`, import.meta.url), 'utf8'));
const bundle = read('bundle');
const studies = Object.fromEntries(['height', 'position', 'terrain'].map((name) => [name, read(`${name}-study`)]));
const inputs = communicationDemo(bundle);
const decisions = runMission(bundle, inputs);
const moduleUnderTest = () => import('../web/configurations.mjs');

test('actual Nov 17 recovery aggregates one baseline plus six existing one-factor cases, all PASS', async () => {
  const { evaluateConfigurations } = await moduleUnderTest();
  const report = await evaluateConfigurations(bundle, studies, inputs, decisions.recommended);
  assert.equal(report.total, 7);
  assert.equal(report.pass_count, 7);
  assert.equal(report.overall_status, 'PASS');
  assert.deepEqual(report.counts, { PASS: 7, FAIL: 0, INDETERMINATE: 0 });
  assert.equal(report.cases.filter((item) => item.baseline).length, 1);
  assert.equal(new Set(report.cases.map(({ id }) => id)).size, 7);
  assert.deepEqual(report.cases.map(({ factor }) => factor), ['baseline', 'height', 'height', 'position', 'position', 'terrain', 'terrain']);
  assert.equal(report.siteId, decisions.recommended.siteId);
  assert.equal(report.mission_start, Date.parse('2026-11-17T03:00:00Z') / 1000);
  assert.equal(report.mission_end, Date.parse('2026-11-17T15:00:00Z') / 1000);
  for (const item of report.cases) {
    assert.equal(item.status, 'PASS');
    assert.equal(item.siteId, report.siteId);
    assert.equal(item.mission_start, report.mission_start);
    assert.equal(item.mission_end, report.mission_end);
    assert.equal(item.input_hash, report.input_hash);
    assert(item.source.startsWith('https://'));
    assert.match(item.source_hash, /^[0-9a-f]{64}$/);
    assert(item.source_files_and_hashes.length > 0);
    assert.deepEqual(item.constraints.map(({ id, threshold }) => [id, threshold]),
      decisions.recommended.constraints.map(({ id, threshold }) => [id, threshold]));
    assert.equal(item.metrics.min_joint_total.metric, 12);
  }
  assert(report.scope.includes('one-factor'));
  assert(report.scope.includes('not a probability'));
  assert(report.scope.includes('combinations'));
});

test('nominal fragility is retained: 4 PASS, 2 FAIL and 1 INDETERMINATE without pooling uncertainty', async () => {
  const { evaluateConfigurations } = await moduleUnderTest();
  const report = await evaluateConfigurations(bundle, studies, inputs, decisions.nominal);
  assert.equal(report.overall_status, 'FAIL');
  assert.equal(report.pass_count, 4);
  assert.deepEqual(report.counts, { PASS: 4, FAIL: 2, INDETERMINATE: 1 });
  assert.deepEqual(report.cases.map(({ status }) => status), ['PASS', 'FAIL', 'PASS', 'FAIL', 'PASS', 'PASS', 'INDETERMINATE']);
  assert.deepEqual(report.cases[0].constraints, decisions.nominal.constraints);
  const expected = [evaluateHeights, evaluatePositions, evaluateTerrainRealizations]
    .flatMap((evaluate, index) => {
      const name = ['height', 'position', 'terrain'][index];
      const ids = new Set(studies[name].scenarios.filter(({ baseline }) => baseline !== true).map(({ id }) => id));
      return evaluate(bundle, studies[name], inputs, decisions.nominal).scenario_results.filter(({ id }) => ids.has(id));
    });
  report.cases.slice(1).forEach((item, index) => {
    assert.equal(item.scenario_id, expected[index].id);
    assert.deepEqual(item.constraints, expected[index].constraints);
    assert.deepEqual(item.refinement, expected[index].refinement);
  });
});

test('reports reject missing, wrong-site, stale, duplicate-baseline and mixed-factor evidence', async () => {
  const { evaluateConfigurations } = await moduleUnderTest();
  const check = (overlays, mission = decisions.recommended) => evaluateConfigurations(bundle, overlays, inputs, mission);
  await assert.rejects(check({ ...studies, terrain: null }), /study|evidence/i);
  const wrongSite = structuredClone(studies);
  wrongSite.height.siteId = 'another-site';
  await assert.rejects(check(wrongSite), /site/i);
  const stale = structuredClone(studies);
  stale.position.manifest.baselineBundleSha256 = '0'.repeat(64);
  await assert.rejects(check(stale), /bundle/i);
  const duplicate = structuredClone(studies);
  duplicate.height.scenarios[0].baseline = true;
  await assert.rejects(check(duplicate), /baseline/i);
  const mixture = structuredClone(studies);
  mixture.height.scenarios[0].lat = bundle.sites.find(({ id }) => id === inputs.siteId).lat + 0.001;
  await assert.rejects(check(mixture), /one-factor|point/i);
  const shiftedHeight = structuredClone(studies);
  shiftedHeight.position.scenarios[0].heightM = 5;
  await assert.rejects(check(shiftedHeight), /height/i);
  const badSource = structuredClone(studies);
  badSource.terrain.scenarios[1].localSourceSha256 = '0'.repeat(64);
  await assert.rejects(check(badSource), /source|hash/i);
});

test('selected plan identity rejects stale constraints or duration and hashes exact inputs and plan', async () => {
  const { evaluateConfigurations } = await moduleUnderTest();
  const tampered = structuredClone(decisions.recommended);
  tampered.constraints[0].threshold = 12;
  await assert.rejects(evaluateConfigurations(bundle, studies, inputs, tampered), /selected|constraints|mission/i);
  await assert.rejects(evaluateConfigurations(bundle, studies, inputs, { ...decisions.recommended, end: decisions.recommended.end + 1 }), /duration|selected|mission/i);
  const nominal = await evaluateConfigurations(bundle, studies, inputs, decisions.nominal);
  const recovered = await evaluateConfigurations(bundle, studies, inputs, decisions.recommended);
  assert.equal(nominal.search_input_hash, recovered.search_input_hash);
  assert.notEqual(nominal.selected_plan_fingerprint, recovered.selected_plan_fingerprint);
  assert.notEqual(nominal.input_hash, recovered.input_hash);
  const certificate = await makeCertificate(bundle, inputs, decisions, { role: 'recommended' });
  assert.equal(recovered.search_input_hash, certificate.search_input_hash);
  assert.equal(recovered.selected_plan_fingerprint, certificate.selected_plan_fingerprint);
  assert.equal(recovered.baseline_bundle_hash, certificate.data_bundle_hash);
  const changedInputs = { ...inputs, delayHours: inputs.delayHours + 1 };
  const changed = await evaluateConfigurations(bundle, studies, changedInputs, decisions.recommended);
  assert.notEqual(changed.search_input_hash, recovered.search_input_hash);
  assert.notEqual(changed.input_hash, recovered.input_hash);
});

test('one unresolved existing case prevents PASS even when all six other configurations pass', async () => {
  const { evaluateConfigurations } = await moduleUnderTest();
  // An explicit test-only input record isolates the uncertainty branch. It is
  // not a recovery recommendation or a change to the guided demo's hard limits.
  const testInputs = { ...inputs, maxSunHours: 12, minJointHours: 0, minContinuousJointHours: 0 };
  const mission = runMission(bundle, testInputs).nominal;
  const report = await evaluateConfigurations(bundle, studies, testInputs, mission);
  assert.deepEqual(report.counts, { PASS: 6, FAIL: 0, INDETERMINATE: 1 });
  assert.equal(report.overall_status, 'INDETERMINATE');
  assert.equal(report.cases.find(({ id }) => id === 'terrain:clone-0002').status, 'INDETERMINATE');
});

test('reordering study arrays cannot duplicate baselines or change the seven configuration identities', async () => {
  const { evaluateConfigurations } = await moduleUnderTest();
  const reordered = structuredClone(studies);
  for (const overlay of Object.values(reordered)) overlay.scenarios.reverse();
  const expected = await evaluateConfigurations(bundle, studies, inputs, decisions.recommended);
  const actual = await evaluateConfigurations(bundle, reordered, inputs, decisions.recommended);
  assert.deepEqual(actual, expected);
});

test('aggregation does not mutate inputs, studies or selected mission and captures inputs before awaiting', async () => {
  const { evaluateConfigurations } = await moduleUnderTest();
  const selectedInputs = structuredClone(inputs), mission = structuredClone(decisions.recommended);
  const beforeStudies = JSON.stringify(studies), beforeMission = JSON.stringify(mission);
  const pending = evaluateConfigurations(bundle, studies, selectedInputs, mission);
  selectedInputs.delayHours += 2;
  const report = await pending;
  assert.equal(report.inputs.delayHours, inputs.delayHours);
  assert.equal(JSON.stringify(studies), beforeStudies);
  assert.equal(JSON.stringify(mission), beforeMission);
  report.cases[0].constraints[0].margin = -1000;
  assert.notEqual(mission.constraints[0].margin, -1000);
});
