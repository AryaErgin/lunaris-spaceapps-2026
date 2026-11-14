import { runMission } from './engine.mjs';

const HOUR = 3600;
const SCOPE = 'Observer-height sensitivity at one fixed study point across the listed design settings.';
const SHA256 = /^[0-9a-f]{64}$/i;

function checkEvidence(bundle, heightBundle, site) {
  const manifest = heightBundle.manifest ?? {};
  const baselineHash = bundle.manifest?.bundleSha256;
  if (!SHA256.test(baselineHash) || manifest.baselineBundleSha256 !== baselineHash) {
    throw new Error('Height scenarios belong to a different Phase B bundle.');
  }
  if (!SHA256.test(manifest.bundleSha256)) throw new Error('Height study source hash is missing or malformed.');
  const coverage = heightBundle.coverage;
  if (!Array.isArray(coverage) || coverage.length !== 2 || !coverage.every(Number.isFinite)) {
    throw new Error('Height study coverage dates are missing or malformed.');
  }
  const sharedCoverage = [Math.max(coverage[0], bundle.coverage[0]), Math.min(coverage[1], bundle.coverage[1])];
  if (sharedCoverage[0] >= sharedCoverage[1]) {
    throw new Error('Height study dates must overlap Phase B coverage.');
  }
  if (!Array.isArray(heightBundle.scenarios)) throw new Error('Height scenarios are missing.');
  const baselines = heightBundle.scenarios.filter(({ baseline }) => baseline === true);
  if (baselines.length !== 1 || baselines[0].heightM !== site.heightM) {
    throw new Error('Height scenarios must include the original observer height as their baseline.');
  }
  const ids = new Set();
  const heights = new Set();
  for (const scenario of heightBundle.scenarios) {
    if (typeof scenario.id !== 'string' || !scenario.id || ids.has(scenario.id) ||
        !Number.isFinite(scenario.heightM) || scenario.heightM < 0 || heights.has(scenario.heightM)) {
      throw new Error('Height scenarios require distinct identifiers and nonnegative heights.');
    }
    ids.add(scenario.id);
    heights.add(scenario.heightM);
  }
  return sharedCoverage;
}

function pointEvaluation(bundle, site, inputs, mission) {
  const scheduleAllowed = mission.start >= inputs.earliest && mission.start <= inputs.latest;
  // Restrict the engine's candidate search to the selected start. Schedule status
  // still follows the original allowed range for a start outside those bounds.
  const latest = scheduleAllowed ? mission.start : inputs.latest;
  const delayHours = Math.max(0, (latest - mission.start) / HOUR) + 1;
  return runMission({ ...bundle, sites: [site] }, {
    ...inputs, siteId: site.id, nominal: mission.start, mode: 'same-site', latest, delayHours,
  }).nominal;
}

function siteForHeight(site, scenario) {
  return {
    ...site,
    heightM: scenario.heightM,
    sun: scenario.sun,
    earth: scenario.earth,
    // Incomplete height-specific refinement evidence must produce uncertainty,
    // even if a single retained timeline would pass.
    refinementIntervals: scenario.refinementIntervals ?? {},
    terrain: scenario.terrain,
  };
}

export function evaluateHeights(bundle, heightBundle, inputs, mission) {
  if (!mission || !heightBundle || mission.siteId !== heightBundle.siteId) return null;
  const site = bundle.sites.find(({ id }) => id === mission.siteId);
  if (!site) throw new Error('The height study site is missing from Phase B evidence.');
  const expectedEnd = mission.start + inputs.durationHours * HOUR;
  if (!Number.isFinite(mission.start) || !Number.isFinite(mission.end) ||
      Math.abs(mission.end - expectedEnd) > 0.000001) {
    throw new Error('The selected mission does not match the requested duration.');
  }
  const sharedCoverage = checkEvidence(bundle, heightBundle, site);
  const scenario_results = heightBundle.scenarios.map((scenario) => {
    const baseline = scenario.baseline === true;
    const scenarioBundle = baseline ? bundle : { ...bundle, coverage: sharedCoverage };
    const scenarioSite = baseline ? site : siteForHeight(site, scenario);
    const result = pointEvaluation(scenarioBundle, scenarioSite, inputs, mission);
    return {
      id: scenario.id, heightM: scenario.heightM, status: result.status,
      constraints: result.constraints, refinement: result.refinement ?? null,
      coverageWarnings: result.coverageWarnings, scheduleWarnings: result.scheduleWarnings,
    };
  });
  let robust_status = 'PASS';
  if (scenario_results.some(({ status }) => status === 'FAIL')) robust_status = 'FAIL';
  else if (scenario_results.some(({ status }) => status !== 'PASS')) robust_status = 'INDETERMINATE';
  return {
    scope: SCOPE,
    siteId: site.id,
    mission_start: mission.start,
    mission_end: mission.end,
    source_hash: heightBundle.manifest.bundleSha256,
    scenario_ids: scenario_results.map(({ id }) => id),
    scenario_results,
    robust_status,
  };
}
