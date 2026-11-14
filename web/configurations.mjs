// Display aggregation of the existing frozen studies; no new scenario solver.
import { evaluateStart } from './engine.mjs';
import { evaluateHeights, evaluatePositions, evaluateTerrainRealizations } from './scenarios.mjs';

const SHA256 = /^[0-9a-f]{64}$/i;
const INPUT_KEYS = ['siteId', 'nominal', 'delayHours', 'durationHours', 'maxSunHours',
  'maxEarthHours', 'minJointHours', 'minContinuousJointHours', 'earliest', 'latest', 'gridMinutes', 'mode'];
const STUDIES = [
  { name: 'height', evaluate: evaluateHeights, ids: ['h1m', 'h5m'], labels: ['1 m observer height', '5 m observer height'] },
  { name: 'position', evaluate: evaluatePositions, ids: ['e-25m', 'e+25m'], labels: ['−25 m map easting', '+25 m map easting'] },
  { name: 'terrain', evaluate: evaluateTerrainRealizations, ids: ['clone-0001', 'clone-0002'], labels: ['PGDA clone 0001', 'PGDA clone 0002'] },
];
const SCOPE = 'Seven distinct one-factor configurations: one shared baseline and six existing variations, evaluated at the same selected mission and unchanged hard limits. This finite sensitivity comparison is not a probability of success. Joint combinations, other positions, heights and terrain realizations remain unevaluated.';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function hash(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function files(manifest) {
  if (!manifest?.files?.length) throw new Error('Configuration source files and hashes are missing.');
  return manifest.files.map(({ filename, sha256, url, citation }) => {
    if (!filename || !SHA256.test(sha256) || !url?.startsWith('https://')) {
      throw new Error('Configuration source file identity or hash is invalid.');
    }
    return { filename, sha256, url, citation };
  });
}

function checkOneFactor(bundle, overlay, definition, site) {
  if (!overlay || overlay.siteId !== site.id || overlay.manifest?.siteId !== site.id) {
    throw new Error(`${definition.name} study evidence does not match the selected site.`);
  }
  const manifest = overlay.manifest;
  if (canonical(manifest.pointCoordinates) !== canonical([site.lat, site.lon]) ||
      manifest.frame?.working !== bundle.manifest?.frame?.working) {
    throw new Error('Configuration evidence has a different study point or lunar frame.');
  }
  const baselines = overlay.scenarios?.filter(item => item.baseline === true) ?? [];
  if (baselines.length !== 1) throw new Error('Every study must contain exactly one shared baseline.');
  if (overlay.scenarios.length !== 3 || !definition.ids.every(id =>
    overlay.scenarios.some(item => item.id === id && item.baseline !== true))) {
    throw new Error('The configuration strip requires the six specified existing one-factor variations.');
  }
  for (const item of overlay.scenarios) {
    if (item.baseline || definition.name === 'height') {
      if (item.lat !== undefined && item.lat !== site.lat || item.lon !== undefined && item.lon !== site.lon ||
          item.groundM !== undefined && item.groundM !== site.groundM) {
        throw new Error('A height-only configuration cannot change the baseline observation point or terrain.');
      }
    }
  }
  if (site.heightM !== 2 || definition.name === 'height' &&
      definition.ids.some((id, index) => overlay.scenarios.find(item => item.id === id).heightM !== [1, 5][index])) {
    throw new Error('The existing height configurations require the 2 m baseline and 1 m / 5 m variations.');
  }
  if (definition.name === 'position' && canonical(manifest.offsetEastingM) !== canonical([-25, 0, 25])) {
    throw new Error('The existing position study must identify its −25 m / +25 m map offsets.');
  }
  const sourceFiles = files(manifest), baselineFiles = files(bundle.manifest);
  for (const file of sourceFiles) {
    const original = baselineFiles.find(item => item.filename === file.filename);
    if (original && original.sha256 !== file.sha256) throw new Error('A shared source hash differs from the baseline bundle.');
    if (!original && (definition.name !== 'terrain' || !definition.ids.some((id, index) => {
      const scenario = overlay.scenarios.find(item => item.id === id);
      return file.filename.includes(`_${String(index + 1).padStart(4, '0')}_err`) && scenario.localSourceSha256 === file.sha256;
    }))) throw new Error('An unrecognized source cannot be mixed into a one-factor configuration.');
  }
  if (definition.name === 'terrain') for (const id of definition.ids) {
    const scenario = overlay.scenarios.find(item => item.id === id);
    if (!SHA256.test(scenario.localSourceSha256) || !sourceFiles.some(file => file.sha256 === scenario.localSourceSha256)) {
      throw new Error('The correlated terrain source hash does not identify a study source file.');
    }
  }
  return sourceFiles;
}

function compactCase(result, identity, sourceFiles) {
  return {
    ...identity, status: result.status, constraints: result.constraints,
    metrics: Object.fromEntries(result.constraints.map(item => [item.id, item])),
    refinement: result.refinement ?? null,
    coverageWarnings: result.coverageWarnings, scheduleWarnings: result.scheduleWarnings,
    source_files_and_hashes: sourceFiles,
  };
}

/** Evaluate exactly one baseline plus six existing, separate variations.
 * studyData = {height, position, terrain}; all three are already parsed JSON.
 * Reject mismatched/missing evidence; the caller fetches and displays errors.
 */
export async function evaluateConfigurations(bundle, studyData, inputs, mission) {
  inputs = structuredClone(Object.fromEntries(INPUT_KEYS.map(key => [key, inputs[key]])));
  mission = structuredClone(mission);
  if (!mission) throw new Error('A selected mission is required for configuration assessment.');
  const site = bundle.sites.find(item => item.id === mission.siteId);
  if (!site) throw new Error('The selected mission site is not supported by the bundle.');
  const baseline = evaluateStart(bundle, inputs, mission.siteId, mission.start);
  if (canonical(mission) !== canonical(baseline)) {
    throw new Error('The selected mission, constraints or witnesses do not match the current inputs and bundle.');
  }
  if (!SHA256.test(bundle.manifest?.bundleSha256)) throw new Error('The baseline bundle hash is missing.');
  const baselineFiles = files(bundle.manifest);
  const plan = { siteId: site.id, mission_start: mission.start, mission_end: mission.end };
  const cases = [compactCase(baseline, {
    ...plan, id: 'baseline', scenario_id: 'baseline', factor: 'baseline', baseline: true,
    label: 'Shared baseline: 2 m, published point, nominal terrain',
    heightM: site.heightM, lat: site.lat, lon: site.lon, groundM: site.groundM,
    source: site.source, study_path: './data/bundle.json', source_hash: bundle.manifest.bundleSha256,
  }, baselineFiles)];
  const source_hashes = {};
  for (const definition of STUDIES) {
    const overlay = studyData?.[definition.name];
    const sourceFiles = checkOneFactor(bundle, overlay, definition, site);
    // Existing evaluators validate bundle association, coverage, uniqueness,
    // unchanged observer factors and every original mission constraint.
    const report = definition.evaluate(bundle, overlay, inputs, mission);
    if (!report || report.siteId !== site.id || report.mission_start !== mission.start || report.mission_end !== mission.end) {
      throw new Error('Configuration report belongs to a different selected mission.');
    }
    const baselineId = overlay.scenarios.find(item => item.baseline === true).id;
    const repeated = report.scenario_results.find(item => item.id === baselineId);
    if (!repeated || repeated.status !== baseline.status || canonical(repeated.constraints) !== canonical(baseline.constraints)) {
      throw new Error('Study baselines do not identify the same evaluated mission.');
    }
    source_hashes[definition.name] = report.source_hash;
    definition.ids.forEach((id, index) => {
      const evaluated = report.scenario_results.find(item => item.id === id);
      const scenario = overlay.scenarios.find(item => item.id === id);
      if (!evaluated || canonical(evaluated.constraints.map(({ id, threshold, units }) => ({ id, threshold, units }))) !==
          canonical(baseline.constraints.map(({ id, threshold, units }) => ({ id, threshold, units })))) {
        throw new Error('A variation changed or omitted an original hard constraint.');
      }
      const local = scenario.localSourceSha256 && sourceFiles.find(file => file.sha256 === scenario.localSourceSha256);
      cases.push(compactCase(evaluated, {
        ...plan, id: `${definition.name}:${id}`, scenario_id: id, factor: definition.name, baseline: false,
        label: definition.labels[index], heightM: evaluated.heightM,
        lat: evaluated.lat ?? site.lat, lon: evaluated.lon ?? site.lon, groundM: evaluated.groundM ?? site.groundM,
        ...(definition.name === 'position' ? { offsetEastingM: index === 0 ? -25 : 25 } : {}),
        source: local?.citation ?? 'https://pgda.gsfc.nasa.gov/products/78',
        study_path: `./data/${definition.name}-study.json`, source_hash: report.source_hash,
      }, sourceFiles));
    });
  }
  const counts = { PASS: 0, FAIL: 0, INDETERMINATE: 0 };
  for (const item of cases) counts[item.status]++;
  const overall_status = counts.FAIL ? 'FAIL' : counts.INDETERMINATE ? 'INDETERMINATE' : 'PASS';
  // Capture detached evidence before any digest yields to concurrent UI input.
  const output = structuredClone({
    ...plan, inputs, cases, counts, pass_count: counts.PASS, total: cases.length, overall_status,
    baseline_bundle_hash: bundle.manifest.bundleSha256, source_hashes, scope: SCOPE,
  });
  const [search_input_hash, selected_plan_fingerprint] = await Promise.all([
    hash(inputs), hash({ data_bundle_hash: output.baseline_bundle_hash, selected_plan: mission }),
  ]);
  const input_hash = await hash({ search_input_hash, selected_plan_fingerprint, source_hashes: output.source_hashes });
  return { ...output, search_input_hash, selected_plan_fingerprint, input_hash,
    input_hash_semantics: 'Assessment hash binds original search inputs, the complete selected plan and the three study identities. It is distinct from certificate display-role identity.',
    cases: output.cases.map(item => ({ ...item, input_hash })),
  };
}
