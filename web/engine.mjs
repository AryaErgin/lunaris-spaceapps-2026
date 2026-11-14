const HOUR = 3600;
const ENGINE_VERSION = '1.0.1';
const EPSILON_SECONDS = 0.000001;
const REFINEMENT_LIMIT_SECONDS = 120;
const MAX_CANDIDATES = 10_000;
const MAX_TOLERANCE_STEPS = 10_000;
const STATES = new Set(['visible', 'blocked', 'uncertain', 'unknown']);
const TIE_BREAK = 'Earliest start, then same site, then larger conservative margins in displayed constraint order, then site ID.';
const PARETO = 'Earlier start, keeping the original site, and larger conservative constraint margins.';
const INPUT_KEYS = ['siteId', 'nominal', 'delayHours', 'durationHours', 'maxSunHours',
  'maxEarthHours', 'minJointHours', 'minContinuousJointHours', 'earliest', 'latest',
  'gridMinutes', 'mode'];
const CONVERGENCE_STOP = 'Numerical convergence was not certified for every later start in the connected period.';

function appendInterval(result, start, end, state) {
  if (start >= end) return;
  const previous = result.at(-1);
  if (previous?.[1] === start && previous[2] === state) {
    previous[1] = end;
  } else {
    result.push([start, end, state]);
  }
}

function normalize(timeline, from, to) {
  if (!Array.isArray(timeline)) return [[from, to, 'unknown']];
  const result = [];
  let cursor = from;
  let previousEnd = -Infinity;
  for (const [start, end, state] of timeline) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
        start < previousEnd || !STATES.has(state)) {
      throw new Error('Visibility intervals must be ordered, nonoverlapping, and have a supported state.');
    }
    previousEnd = end;
    if (end <= from || start >= to) continue;
    const coveredStart = Math.max(from, start);
    const coveredEnd = Math.min(to, end);
    appendInterval(result, cursor, coveredStart, 'unknown');
    appendInterval(result, coveredStart, coveredEnd, state);
    cursor = coveredEnd;
  }
  appendInterval(result, cursor, to, 'unknown');
  return result;
}

function jointState(sun, earth) {
  if (sun === 'blocked' || earth === 'blocked') return 'blocked';
  if (sun === 'unknown' || earth === 'unknown') return 'unknown';
  if (sun === 'uncertain' || earth === 'uncertain') return 'uncertain';
  return 'visible';
}

function intersectTimelines(sun, earth) {
  const joint = [];
  let i = 0;
  let j = 0;
  while (i < sun.length && j < earth.length) {
    const [a, b, sunState] = sun[i];
    const [c, d, earthState] = earth[j];
    appendInterval(joint, Math.max(a, c), Math.min(b, d), jointState(sunState, earthState));
    if (b <= d) i++;
    if (d <= b) j++;
  }
  return joint;
}

function firstAfter(timeline, instant) {
  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (timeline[mid][1] <= instant) low = mid + 1;
    else high = mid;
  }
  return low;
}

function clip(timeline, from, to) {
  const clipped = [];
  let cursor = from;
  for (let i = firstAfter(timeline, from); i < timeline.length && timeline[i][0] < to; i++) {
    const [start, end, state] = timeline[i];
    const coveredStart = Math.max(from, start);
    const coveredEnd = Math.min(to, end);
    appendInterval(clipped, cursor, coveredStart, 'unknown');
    appendInterval(clipped, coveredStart, coveredEnd, state);
    cursor = coveredEnd;
  }
  appendInterval(clipped, cursor, to, 'unknown');
  return clipped;
}

function runs(timeline, include) {
  const result = [];
  for (const [start, end, state] of timeline) {
    if (!include(state)) continue;
    const previous = result.at(-1);
    if (previous?.[1] === start) previous[1] = end;
    else result.push([start, end]);
  }
  return result;
}

function longest(spans) {
  let seconds = 0;
  let witness = null;
  for (const span of spans) {
    const duration = span[1] - span[0];
    if (duration > seconds) {
      seconds = duration;
      witness = span;
    }
  }
  return { seconds, witness };
}

function total(spans) {
  const seconds = spans.reduce((sum, [start, end]) => sum + end - start, 0);
  const witness = spans.length ? [spans[0][0], spans.at(-1)[1]] : null;
  return { seconds, witness, segments: spans };
}

const isBlocked = (state) => state === 'blocked';
const isVisible = (state) => state === 'visible';
const couldBeBlocked = (state) => state !== 'visible';
const couldBeVisible = (state) => state !== 'blocked';
const isUnknown = (state) => state === 'unknown';

function unknownPresent(timeline) {
  return timeline.some(([, , state]) => isUnknown(state));
}

function evaluateConstraint(id, hours, direction, timeline, measure) {
  const maximum = direction === 'max';
  const lower = measure(runs(timeline, maximum ? isBlocked : isVisible));
  const upper = measure(runs(timeline, maximum ? couldBeBlocked : couldBeVisible));
  const optimistic = maximum ? lower : upper;
  const conservative = maximum ? upper : lower;
  const unknown = unknownPresent(timeline);
  const threshold = hours * HOUR;
  const signedSeconds = (metric) => maximum ? threshold - metric.seconds : metric.seconds - threshold;
  const marginRange = [conservative, optimistic].map((bound) => signedSeconds(bound) / HOUR);
  let status = 'INDETERMINATE';
  let evidence = conservative;
  if (signedSeconds(optimistic) < -EPSILON_SECONDS) {
    status = 'FAIL';
    evidence = optimistic;
  } else if (!unknown && signedSeconds(conservative) >= -EPSILON_SECONDS) {
    status = 'PASS';
  }
  const exact = lower.seconds === upper.seconds;
  const uncertainty = unknown ? 'Physical visibility coverage is incomplete.'
    : exact ? 'Resolved within the bundled model.'
      : 'Computed over bounded model and crossing uncertainty.';
  return {
    id, threshold: hours, units: 'h',
    metric: evidence.seconds / HOUR,
    range: [lower.seconds / HOUR, upper.seconds / HOUR],
    margin: (Math.abs(signedSeconds(evidence)) <= EPSILON_SECONDS ? 0 : signedSeconds(evidence)) / HOUR,
    marginRange, status,
    witness: evidence.witness,
    ...(evidence.segments && { witnessSegments: evidence.segments }),
    metricBasis: exact ? 'resolved' : status === 'FAIL' ? 'optimistic bound' : 'conservative bound',
    uncertainty,
  };
}

function evaluateCore(site, start, inputs, coverage) {
  const end = start + inputs.durationHours * HOUR;
  const { sun, earth, joint } = Object.fromEntries(
    ['sun', 'earth', 'joint'].map((name) => [name, clip(site[name], start, end)]),
  );
  const constraints = [
    evaluateConstraint('max_sun_block', inputs.maxSunHours, 'max', sun, longest),
    evaluateConstraint('max_earth_block', inputs.maxEarthHours, 'max', earth, longest),
  ];
  if (inputs.minJointHours !== null) {
    constraints.push(evaluateConstraint('min_joint_total', inputs.minJointHours, 'min', joint, total));
  }
  if (inputs.minContinuousJointHours !== null) {
    constraints.push(evaluateConstraint('min_joint_continuous', inputs.minContinuousJointHours, 'min', joint, longest));
  }
  const coverageWarnings = [...(site.terrain?.warnings ?? [])];
  const censored = start < coverage[0] || end > coverage[1] + EPSILON_SECONDS;
  if (censored) coverageWarnings.push('Part of this mission falls outside the cached visibility dates.');
  if (unknownPresent(sun)) coverageWarnings.push('Part of the mission has no qualified solar visibility coverage.');
  if (unknownPresent(earth)) coverageWarnings.push('Part of the mission has no qualified Earth-center visibility coverage.');
  const startAllowed = start >= inputs.earliest && start <= inputs.latest;
  const scheduleWarnings = startAllowed ? [] : ['Mission start is outside the allowed start range.'];
  let status = 'PASS';
  if (censored) status = 'INDETERMINATE';
  else if (!startAllowed || constraints.some((constraint) => constraint.status === 'FAIL')) status = 'FAIL';
  else if (constraints.some((constraint) => constraint.status === 'INDETERMINATE')) status = 'INDETERMINATE';
  return {
    siteId: site.id, start, end, status, constraints, startAllowed,
    coverageWarnings: [...new Set(coverageWarnings)], scheduleWarnings,
    timeline: { sun, earth, joint },
  };
}

function maxBoundShift(coarse, fine) {
  const shift = Math.max(...coarse.range.map((bound, index) => Math.abs(bound - fine.range[index]) * HOUR));
  return Math.round(shift / EPSILON_SECONDS) * EPSILON_SECONDS;
}

function applyRefinement(mission, coarse, fine) {
  const constraints = coarse.constraints.map((a, index) => {
    const b = fine.constraints[index];
    return {
      id: a.id, coarseRange: a.range, fineRange: b.range, coarseStatus: a.status, fineStatus: b.status,
      maxShiftSeconds: maxBoundShift(a, b),
    };
  });
  const maxShiftSeconds = Math.max(constraints[0].maxShiftSeconds, constraints[1].maxShiftSeconds);
  const largeShift = maxShiftSeconds >= REFINEMENT_LIMIT_SECONDS;
  const classificationFlip = coarse.status !== fine.status ||
    constraints.some((row) => row.coarseStatus !== row.fineStatus);
  let insufficientAgreement = false;
  mission.constraints = mission.constraints.map((constraint, index) => {
    const checks = constraints[index];
    const agrees = checks.coarseStatus === constraint.status && checks.fineStatus === constraint.status;
    const excessiveShift = index < 2 && checks.maxShiftSeconds >= REFINEMENT_LIMIT_SECONDS;
    if (constraint.status === 'INDETERMINATE') return constraint;
    if (agrees && (constraint.status === 'FAIL' || !excessiveShift)) return constraint;
    insufficientAgreement ||= !agrees;
    return {
      ...constraint, status: 'INDETERMINATE',
      uncertainty: excessiveShift && agrees ? 'Clipped blocked-run bounds shifted by at least two minutes.'
        : 'This decision needs agreement between the coarse and fine interval evaluations.',
    };
  });
  if (largeShift) mission.coverageWarnings.push('A required clipped blocked-run bound shifts by at least two minutes between refinements.');
  if (classificationFlip) mission.coverageWarnings.push('Coarse and fine evaluations disagree on a mission or constraint classification.');
  if (insufficientAgreement && !classificationFlip) {
    mission.coverageWarnings.push('The retained decision does not have matching support from both refinements.');
  }
  const unresolved = largeShift || classificationFlip || insufficientAgreement;
  const hasFailure = mission.constraints.some(({ status }) => status === 'FAIL');
  const hasUnknown = mission.constraints.some(({ status }) => status === 'INDETERMINATE');
  if (mission.startAllowed && mission.status === 'FAIL' && !hasFailure) mission.status = 'INDETERMINATE';
  if (mission.status === 'PASS' && (unresolved || hasUnknown)) mission.status = 'INDETERMINATE';
  mission.refinement = {
    status: unresolved ? 'UNRESOLVED' : 'CONVERGED',
    limitSeconds: REFINEMENT_LIMIT_SECONDS,
    maxShiftSeconds, classificationFlip, coarseStatus: coarse.status, fineStatus: fine.status, constraints,
  };
  return mission;
}

function evaluateMission(site, start, inputs, coverage) {
  const mission = evaluateCore(site, start, inputs, coverage);
  if (!site.refinements) return mission;
  const coarse = evaluateCore(site.refinements.coarse, start, inputs, coverage);
  const fine = evaluateCore(site.refinements.fine, start, inputs, coverage);
  return applyRefinement(mission, coarse, fine);
}

function firstBlockedLimit(spans, nominal, until, duration, limit) {
  if (limit + EPSILON_SECONDS >= duration) return until;
  for (const [start, end] of spans) {
    if (end - start <= limit + EPSILON_SECONDS || end - limit <= nominal) continue;
    const boundary = start + limit - duration;
    if (boundary < until) return Math.max(nominal, boundary);
  }
  return until;
}

function continuousJointLimit(spans, nominal, until, duration, limit) {
  if (limit === 0) return until;
  // A visible run [a,b) gives starts in [a + limit - duration, b - limit].
  // Merge those closed start ranges, which can overlap even if source runs do not.
  let connectedEnd = null;
  for (const [start, end] of spans) {
    if (end - start < limit - EPSILON_SECONDS) continue;
    const left = start + limit - duration;
    const right = end - limit;
    if (right < nominal - EPSILON_SECONDS) continue;
    if (left > (connectedEnd ?? nominal) + EPSILON_SECONDS) break;
    connectedEnd = right;
  }
  return Math.max(nominal, Math.min(until, connectedEnd ?? nominal));
}

function totalJointLimit(spans, nominal, until, duration, limit) {
  if (limit === 0 || nominal >= until) return until;
  // The joint total is a moving overlap integral. Its slope changes only when
  // either end of the mission passes a visibility endpoint.
  const slopes = new Map();
  const addSlope = (time, delta) => slopes.set(time, (slopes.get(time) ?? 0) + delta);
  let seconds = 0;
  for (const [start, end] of spans) {
    seconds += Math.max(0, Math.min(end, nominal + duration) - Math.max(start, nominal));
    addSlope(start - duration, 1);
    addSlope(end - duration, -1);
    addSlope(start, -1);
    addSlope(end, 1);
  }
  let slope = 0;
  let from = nominal;
  for (const [to, delta] of [...slopes, [until, 0]].sort(([a], [b]) => a - b)) {
    if (to <= nominal) {
      slope += delta;
      continue;
    }
    if (to > until) break;
    const next = seconds + slope * (to - from);
    if (next < limit - EPSILON_SECONDS && slope < 0) {
      return Math.max(nominal, from + (limit - seconds) / slope);
    }
    slope += delta;
    seconds = next;
    from = to;
  }
  return until;
}

function connectedTolerance(site, inputs, nominal, coverage) {
  if (nominal.status !== 'PASS') return null;
  const start = nominal.start;
  const duration = inputs.durationHours * HOUR;
  let until = Math.min(inputs.latest, coverage[1] - duration);
  for (const [timeline, maximum] of [[site.sun, inputs.maxSunHours], [site.earth, inputs.maxEarthHours]]) {
    until = firstBlockedLimit(runs(timeline, isUnknown), start, until, duration, 0);
    until = firstBlockedLimit(runs(timeline, couldBeBlocked), start, until, duration, maximum * HOUR);
  }
  const visible = runs(site.joint, isVisible);
  if (inputs.minContinuousJointHours !== null) {
    until = continuousJointLimit(visible, start, until, duration, inputs.minContinuousJointHours * HOUR);
  }
  if (inputs.minJointHours !== null) {
    until = totalJointLimit(visible, start, until, duration, inputs.minJointHours * HOUR);
  }
  until = Math.max(start, until);
  return { until, hours: (until - start) / HOUR };
}

function differenceWindows(site, duration) {
  const zones = [];
  const { coarse, fine } = site.refinements;
  for (const channel of ['sun', 'earth']) {
    let i = 0;
    let j = 0;
    while (i < coarse[channel].length && j < fine[channel].length) {
      const [a, b, former] = coarse[channel][i];
      const [c, d, current] = fine[channel][j];
      const left = Math.max(a, c);
      const right = Math.min(b, d);
      if (former !== current && right > left) zones.push([left - duration, right]);
      if (b <= d) i++;
      if (d <= b) j++;
    }
  }
  const merged = [];
  for (const zone of zones.sort(([a], [b]) => a - b)) {
    const prior = merged.at(-1);
    if (prior && zone[0] <= prior[1]) prior[1] = Math.max(zone[1], prior[1]);
    else merged.push(zone);
  }
  return merged;
}

function verifiedTolerance(site, inputs, nominal, coverage) {
  const core = connectedTolerance(site, inputs, nominal, coverage);
  if (!core || !site.refinements) return core;
  const { coarse, fine } = site.refinements;
  const start = nominal.start;
  const coarseCore = connectedTolerance(coarse, inputs, evaluateCore(coarse, start, inputs, coverage), coverage);
  const fineCore = connectedTolerance(fine, inputs, evaluateCore(fine, start, inputs, coverage), coverage);
  const limit = Math.min(core.until, coarseCore?.until ?? start, fineCore?.until ?? start);
  let until = start;
  let steps = 0;
  const component = (kind) => ({
    until, hours: (until - start) / HOUR, kind,
    ...(kind === 'lower-bound' && { stopReason: CONVERGENCE_STOP }),
  });
  for (const [left, right] of differenceWindows(site, inputs.durationHours * HOUR)) {
    if (right <= until || left >= limit) continue;
    until = Math.max(left, until);
    const target = Math.min(right, limit);
    while (until < target) {
      const { maxShiftSeconds } = evaluateMission(site, until, inputs, coverage).refinement;
      // Moving a fixed-duration window by dt changes each longest clipped run by at most dt.
      // A difference between two independent longest-run bounds therefore changes by at most 2dt.
      const safeStep = (REFINEMENT_LIMIT_SECONDS - EPSILON_SECONDS - maxShiftSeconds) * 0.49;
      if (safeStep < 0.001 || ++steps > MAX_TOLERANCE_STEPS) {
        until = Math.max(start, Math.floor(until * 1000) / 1000);
        return component('lower-bound');
      }
      until = Math.min(until + safeStep, target);
    }
  }
  return { until: limit, hours: (limit - start) / HOUR, kind: 'exact' };
}

function validateInputs(inputs) {
  for (const key of ['nominal', 'earliest', 'latest', 'durationHours', 'delayHours',
    'maxSunHours', 'maxEarthHours', 'gridMinutes']) {
    if (!Number.isFinite(inputs[key])) throw new Error(`A finite number is required for ${key}.`);
  }
  if (inputs.earliest > inputs.latest) throw new Error('Earliest start must be on or before latest start.');
  if (inputs.durationHours <= 0 || inputs.gridMinutes <= 0 || inputs.delayHours < 0 ||
      inputs.maxSunHours < 0 || inputs.maxEarthHours < 0) {
    throw new Error('Use a positive duration and grid, and nonnegative delay and blocked-time limits.');
  }
  for (const key of ['minJointHours', 'minContinuousJointHours']) {
    if (inputs[key] !== null && (!Number.isFinite(inputs[key]) || inputs[key] < 0)) {
      throw new Error('Optional joint limits must be nonnegative hours or left blank.');
    }
  }
  for (const key of ['durationHours', 'delayHours', 'maxSunHours', 'maxEarthHours',
    'minJointHours', 'minContinuousJointHours', 'gridMinutes']) {
    const scale = key === 'gridMinutes' ? 60 : HOUR;
    if (!Number.isFinite(inputs[key] * scale)) throw new Error(`The value for ${key} is outside the supported interval magnitude.`);
  }
  if (!['same-site', 'prelaunch'].includes(inputs.mode)) throw new Error('Select a valid alternative search mode.');
  const delayed = inputs.nominal + inputs.delayHours * HOUR;
  const duration = inputs.durationHours * HOUR;
  const startPoints = [inputs.nominal, inputs.earliest, inputs.latest, delayed];
  for (const point of [...startPoints, ...startPoints.map((start) => start + duration)]) {
    if (!Number.isFinite(new Date(point * 1000).getTime())) throw new Error('Use dates in the supported UTC calendar.');
  }
  if (startPoints.some((start) => start + duration <= start)) {
    throw new Error('Mission duration is below the supported UTC timestamp resolution.');
  }
}

function compareMargins(a, b) {
  for (let i = 0; i < a.constraints.length; i++) {
    const difference = b.constraints[i].marginRange[0] - a.constraints[i].marginRange[0];
    if (difference) return difference;
  }
  return 0;
}

function comparePasses(a, b, originalSite) {
  if (a.start !== b.start) return a.start - b.start;
  const sitePreference = Number(b.siteId === originalSite) - Number(a.siteId === originalSite);
  if (sitePreference) return sitePreference;
  const marginOrder = compareMargins(a, b);
  if (marginOrder) return marginOrder;
  if (a.siteId === b.siteId) return 0;
  return a.siteId < b.siteId ? -1 : 1;
}

function dominates(a, b, originalSite) {
  const aChangedSite = Number(a.siteId !== originalSite);
  const bChangedSite = Number(b.siteId !== originalSite);
  if (a.start > b.start || aChangedSite > bChangedSite) return false;
  let improves = a.start < b.start || aChangedSite < bChangedSite;
  for (let i = 0; i < a.constraints.length; i++) {
    const marginDifference = a.constraints[i].marginRange[0] - b.constraints[i].marginRange[0];
    if (marginDifference < 0) return false;
    if (marginDifference > 0) improves = true;
  }
  return improves;
}

function paretoFrontier(passes, originalSite) {
  const alternatives = [];
  for (const candidate of passes) {
    if (!alternatives.some((other) => dominates(other, candidate, originalSite))) alternatives.push(candidate);
  }
  return alternatives;
}

function evidenceCoverage(bundle) {
  const coverage = bundle.coverage;
  if (!Array.isArray(coverage) || coverage.length !== 2 || !coverage.every(Number.isFinite) ||
      coverage[0] >= coverage[1]) {
    throw new Error('The evidence bundle must specify a finite, positive visibility coverage period.');
  }
  return coverage;
}

function prepareSite(site, coverage) {
  const sun = normalize(site.sun, ...coverage);
  const earth = normalize(site.earth, ...coverage);
  const prepared = { ...site, sun, earth, joint: intersectTimelines(sun, earth) };
  if (site.refinementIntervals) {
    prepared.refinements = Object.fromEntries(['coarse', 'fine'].map(level => [level, prepareSite({
      id: site.id, sun: site.refinementIntervals.sun?.[level], earth: site.refinementIntervals.earth?.[level],
    }, coverage)]));
  }
  return prepared;
}

// Evaluate one start with the same interval and refinement rules as recovery search.
// The supplied allowable start range and all mission requirements remain unchanged.
export function evaluateStart(bundle, inputs, siteId = inputs.siteId, start = inputs.nominal) {
  validateInputs(inputs);
  validateInputs({ ...inputs, nominal: start });
  const coverage = evidenceCoverage(bundle);
  const site = bundle.sites.find(({ id }) => id === siteId);
  if (!site) throw new Error('The selected study point has no evidence in this bundle.');
  return evaluateMission(prepareSite(site, coverage), start, inputs, coverage);
}

export function runMission(bundle, inputs) {
  validateInputs(inputs);
  const coverage = evidenceCoverage(bundle);
  const selected = bundle.sites.find(({ id }) => id === inputs.siteId);
  if (!selected) throw new Error('The selected study point has no evidence in this bundle.');
  const sites = (inputs.mode === 'prelaunch' ? bundle.sites : [selected]).map(site => prepareSite(site, coverage));
  const original = sites.find(({ id }) => id === selected.id);
  const delayedStart = inputs.nominal + inputs.delayHours * HOUR;
  const from = Math.max(delayedStart, inputs.earliest);
  const to = inputs.latest;
  const step = inputs.gridMinutes * 60;
  const slots = from <= to ? Math.floor((to - from) / step + 1e-12) + 1 : 0;
  if (slots * sites.length > MAX_CANDIDATES) {
    throw new Error(`This search exceeds ${MAX_CANDIDATES} site/start pairs. Choose a larger grid or a shorter start range.`);
  }
  const nominal = evaluateMission(original, inputs.nominal, inputs, coverage);
  const delayed = evaluateMission(original, delayedStart, inputs, coverage);
  const counts = { PASS: 0, FAIL: 0, INDETERMINATE: 0 };
  const passes = [];
  for (let i = 0; i < slots; i++) {
    const time = Math.min(to, from + i * step);
    for (const site of sites) {
      const mission = evaluateMission(site, time, inputs, coverage);
      counts[mission.status]++;
      if (mission.status === 'PASS') passes.push(mission);
    }
  }
  passes.sort((a, b) => comparePasses(a, b, selected.id));
  const search = {
    from, to, firstStart: slots ? from : null, lastStart: slots ? Math.min(to, from + (slots - 1) * step) : null,
    gridMinutes: inputs.gridMinutes, mode: inputs.mode,
    sites: sites.map(({ id }) => id), candidateCount: slots * sites.length,
    tieBreak: TIE_BREAK, paretoObjectives: PARETO,
    evaluation: 'Every sampled start uses the full-resolution cached interval bounds.',
  };
  return {
    nominal, delayed, recommended: passes[0] ?? null, alternatives: paretoFrontier(passes, selected.id),
    counts, delayTolerance: verifiedTolerance(original, inputs, nominal, coverage), search,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const utc = (seconds) => new Date(seconds * 1000).toISOString();

function siteRecord(site) {
  return {
    site_id: site.id, name: site.name, region: site.region,
    point_coordinates: { latitude_deg: site.lat, longitude_east_deg: site.lon },
    coordinate_source: site.source, ground_elevation_m: site.groundM,
    instrument_height_m: site.heightM,
  };
}

export async function makeCertificate(bundle, inputs, result) {
  const manifest = bundle.manifest ?? {};
  const decision = result.recommended ?? result.delayed;
  const site = siteRecord(bundle.sites.find(({ id }) => id === decision.siteId));
  const comparedSites = bundle.sites.filter(({ id }) => [inputs.siteId, ...result.search.sites].includes(id));
  const missionInputs = Object.fromEntries(INPUT_KEYS.map((key) => [key, inputs[key]]));
  const [inputHash, dataHash] = await Promise.all([
    sha256(missionInputs), manifest.bundleSha256 ?? sha256(bundle),
  ]);
  const created = new Date().toISOString();
  return {
    certificate_version: '1.0',
    engine_version: ENGINE_VERSION,
    engine_commit: null,
    bundle_engine_commit: manifest.engineCommit ?? null,
    created_utc: created,
    input_hash: inputHash,
    data_bundle_hash: dataHash,
    data_bundle_version: bundle.version,
    site_id: site.site_id,
    point_coordinates: site.point_coordinates,
    coordinate_source: site.coordinate_source,
    study_points: comparedSites.map(siteRecord),
    mission_start_utc: utc(decision.start),
    mission_end_utc: utc(decision.end),
    instrument_heights_m: { solar: site.instrument_height_m, earth_center_los: site.instrument_height_m },
    visibility_definitions: manifest.visibilityDefinitions ?? null,
    constraints: decision.constraints,
    candidate_search_bounds: { earliest_utc: utc(result.search.from), latest_utc: utc(result.search.to) },
    candidate_search_grid_minutes: result.search.gridMinutes,
    tie_break_policy: result.search.tieBreak,
    search: result.search,
    candidate_counts: result.counts,
    inputs: missionInputs,
    nominal_result: result.nominal,
    delayed_result: result.delayed,
    recommended_result: result.recommended,
    nondominated_alternatives: result.alternatives,
    delay_tolerance: result.delayTolerance,
    scenario_ids: [],
    scenario_results: [],
    robustness_scope: 'Single fixed observer per study point.',
    source_files_and_hashes: manifest.files ?? [],
    frame: manifest.frame ?? null,
    kernels: manifest.kernels ?? [],
    correction_conventions: manifest.corrections ?? manifest.correctionConventions ?? null,
    software_versions: manifest.versions ?? {},
    coverage_warnings: [...new Set([result.nominal, result.delayed, decision]
      .flatMap((mission) => mission.coverageWarnings))],
    excluded_physics: manifest.limitations ?? [],
    validation: manifest.validation ?? null,
    serialization: 'UTC ISO strings at millisecond display precision. Witness and interval timestamps are UTC seconds. Metrics and margins are hours. The creation timestamp varies between exports.',
  };
}
