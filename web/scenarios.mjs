import { runMission } from './engine.mjs';

const HOUR = 3600;
const HEIGHT_SCOPE = 'Observer-height sensitivity at one fixed study point across the listed design settings.';
const POSITION_SCOPE = 'Illustrative offsets in the lunar south-polar stereographic map at a fixed instrument height above each point’s local ground.';
const SHA256 = /^[0-9a-f]{64}$/i;

function checkEvidence(bundle, overlay, site) {
  const manifest = overlay.manifest ?? {};
  const baselineHash = bundle.manifest?.bundleSha256;
  if (!SHA256.test(baselineHash) || manifest.baselineBundleSha256 !== baselineHash) {
    throw new Error('These scenarios belong to a different Phase B bundle.');
  }
  if (!SHA256.test(manifest.bundleSha256)) throw new Error('Scenario study source hash is missing or malformed.');
  const coverage = overlay.coverage;
  if (!Array.isArray(coverage) || coverage.length !== 2 || !coverage.every(Number.isFinite)) {
    throw new Error('Scenario study coverage dates are missing or malformed.');
  }
  const sharedCoverage = [Math.max(coverage[0], bundle.coverage[0]), Math.min(coverage[1], bundle.coverage[1])];
  if (sharedCoverage[0] >= sharedCoverage[1]) {
    throw new Error('Scenario study dates must overlap Phase B coverage.');
  }
  if (!Array.isArray(overlay.scenarios)) throw new Error('Scenario set is missing.');
  const baselines = overlay.scenarios.filter(({ baseline }) => baseline === true);
  if (baselines.length !== 1 || baselines[0].heightM !== site.heightM) {
    throw new Error('The original observation point and height are required as the scenario baseline.');
  }
  const ids = new Set();
  for (const scenario of overlay.scenarios) {
    if (typeof scenario.id !== 'string' || !scenario.id || ids.has(scenario.id) ||
        !Number.isFinite(scenario.heightM) || scenario.heightM < 0) {
      throw new Error('Scenarios require distinct identifiers and nonnegative heights.');
    }
    ids.add(scenario.id);
  }
  return sharedCoverage;
}

function heightPoints(scenarios) {
  const heights = new Set();
  return scenarios.map(({ heightM }) => {
    if (heights.has(heightM)) throw new Error('Height scenarios require distinct observer heights.');
    heights.add(heightM);
    return {};
  });
}

function positionPoints(scenarios, site) {
  const coordinates = new Set();
  return scenarios.map((scenario) => {
    if (scenario.heightM !== site.heightM) throw new Error('Position scenarios require a fixed observer height.');
    const point = scenario.baseline === true ? site : scenario;
    const { lat, lon, groundM } = point;
    if (![lat, lon, groundM].every(Number.isFinite) || lat < -90 || lat > 90 || lon < 0 || lon >= 360) {
      throw new Error('Position scenarios require valid lunar coordinates and finite ground elevations.');
    }
    const key = `${lat},${lon}`;
    if (coordinates.has(key)) throw new Error('Position scenarios require distinct point coordinates.');
    coordinates.add(key);
    return { lat, lon, groundM, label: scenario.label ?? scenario.id };
  });
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

function siteForScenario(site, scenario, point) {
  return {
    ...site,
    ...point,
    heightM: scenario.heightM,
    sun: scenario.sun,
    earth: scenario.earth,
    // Incomplete scenario-specific refinement evidence must produce uncertainty,
    // even if a single retained timeline would pass.
    refinementIntervals: scenario.refinementIntervals ?? {},
    terrain: scenario.terrain,
  };
}

function evaluateScenarios(bundle, overlay, inputs, mission, preparePoints, scope) {
  if (!mission || !overlay || mission.siteId !== overlay.siteId) return null;
  const site = bundle.sites.find(({ id }) => id === mission.siteId);
  if (!site) throw new Error('The scenario study site is missing from Phase B evidence.');
  const expectedEnd = mission.start + inputs.durationHours * HOUR;
  if (!Number.isFinite(mission.start) || !Number.isFinite(mission.end) ||
      Math.abs(mission.end - expectedEnd) > 0.000001) {
    throw new Error('The selected mission does not match the requested duration.');
  }
  const sharedCoverage = checkEvidence(bundle, overlay, site);
  const points = preparePoints(overlay.scenarios, site);
  const scenario_results = overlay.scenarios.map((scenario, index) => {
    const baseline = scenario.baseline === true;
    const scenarioBundle = baseline ? bundle : { ...bundle, coverage: sharedCoverage };
    const point = points[index];
    const scenarioSite = baseline ? site : siteForScenario(site, scenario, point);
    const result = pointEvaluation(scenarioBundle, scenarioSite, inputs, mission);
    return {
      id: scenario.id, ...point, heightM: scenario.heightM, status: result.status,
      constraints: result.constraints, refinement: result.refinement ?? null,
      coverageWarnings: result.coverageWarnings, scheduleWarnings: result.scheduleWarnings,
    };
  });
  let robust_status = 'PASS';
  if (scenario_results.some(({ status }) => status === 'FAIL')) robust_status = 'FAIL';
  else if (scenario_results.some(({ status }) => status !== 'PASS')) robust_status = 'INDETERMINATE';
  return {
    scope,
    siteId: site.id,
    mission_start: mission.start,
    mission_end: mission.end,
    source_hash: overlay.manifest.bundleSha256,
    scenario_ids: scenario_results.map(({ id }) => id),
    scenario_results,
    robust_status,
  };
}

export function evaluateHeights(bundle, overlay, inputs, mission) {
  return evaluateScenarios(bundle, overlay, inputs, mission, heightPoints, HEIGHT_SCOPE);
}

export function evaluatePositions(bundle, overlay, inputs, mission) {
  return evaluateScenarios(bundle, overlay, inputs, mission, positionPoints, POSITION_SCOPE);
}
