import { evaluateStart } from './engine.mjs';

const HOUR = 3600;
const DAY = 24 * HOUR;
const MAX_MATRIX_CELLS = 10000;
const CHANNELS = ['sun', 'earth', 'joint'];
const STATES = new Set(['visible', 'blocked', 'uncertain', 'unknown']);

export function feasibilityMatrix(bundle, inputs, { stepHours = 24 } = {}) {
  if (!Number.isFinite(stepHours) || stepHours <= 0 || !Number.isFinite(stepHours * HOUR)) {
    throw new Error('The feasibility matrix requires a finite positive step in hours.');
  }
  // Validate through the authoritative evaluator, including zero-row date ranges.
  evaluateStart(bundle, inputs);
  const [from, to] = bundle.coverage;
  const step = stepHours * HOUR;
  const timeOfDay = ((inputs.nominal % DAY) + DAY) % DAY;
  const anchor = Math.floor(from / DAY) * DAY + timeOfDay;
  const first = anchor + Math.max(0, Math.ceil((from - anchor) / step)) * step;
  const count = Math.max(0, Math.ceil((to - first) / step));
  if (count * bundle.sites.length > MAX_MATRIX_CELLS) {
    throw new Error(`This feasibility matrix exceeds ${MAX_MATRIX_CELLS} site/start pairs. Choose a larger step.`);
  }
  const starts = Array.from({ length: count }, (_, index) => first + index * step).filter(start => start < to);
  return {
    starts, stepHours,
    rows: bundle.sites.map(site => ({
      siteId: site.id, name: site.name,
      cells: starts.map(start => evaluateStart(bundle, inputs, site.id, start)),
    })),
    basis: 'Discrete starts inside the offline cache, anchored to the nominal UTC time of day. All mission limits and the allowed start range are unchanged. Missions crossing the cache edge are indeterminate; this comparison establishes no landing trajectory.',
  };
}

function clippedTimeline(timeline, start, end) {
  const result = [];
  let cursor = start;
  let previousEnd = -Infinity;
  for (const [a, b, state] of timeline ?? []) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || a < previousEnd || !STATES.has(state)) {
      throw new Error('Metric intervals must be ordered, nonoverlapping, and have a supported state.');
    }
    previousEnd = b;
    const lo = Math.max(start, a), hi = Math.min(end, b);
    if (hi <= lo) continue;
    if (lo > cursor) result.push([cursor, lo, 'unknown']);
    result.push([lo, hi, state]);
    cursor = hi;
  }
  if (cursor < end) result.push([cursor, end, 'unknown']);
  return result;
}

function jointTimeline(sun, earth) {
  const result = [];
  let i = 0, j = 0;
  while (i < sun.length && j < earth.length) {
    const [a,b,s] = sun[i], [c,d,e] = earth[j];
    const start = Math.max(a,c), end = Math.min(b,d);
    const state = s === 'blocked' || e === 'blocked' ? 'blocked'
      : s === 'unknown' || e === 'unknown' ? 'unknown'
        : s === 'uncertain' || e === 'uncertain' ? 'uncertain' : 'visible';
    if (start < end) result.push([start,end,state]);
    if (b <= d) i++;
    if (d <= b) j++;
  }
  return result;
}

function longestRun(timeline, predicate) {
  let maximum = 0, run = 0, previousEnd = null;
  for (const [a,b,state] of timeline) {
    if (predicate(state)) run = (a === previousEnd ? run : 0) + b - a;
    else run = 0;
    maximum = Math.max(maximum, run);
    previousEnd = b;
  }
  return maximum;
}

function summarize(timeline) {
  const totals = { visible:0, blocked:0, uncertain:0, unknown:0 };
  for (const [a,b,state] of timeline) totals[state] += b-a;
  return {
    visibleSeconds: totals.visible, blockedSeconds: totals.blocked,
    uncertainSeconds: totals.uncertain, unknownSeconds: totals.unknown,
    unresolvedSeconds: totals.uncertain + totals.unknown,
    visibleRangeSeconds: [totals.visible, totals.visible + totals.uncertain + totals.unknown],
    blockedRangeSeconds: [totals.blocked, totals.blocked + totals.uncertain + totals.unknown],
    longestBlockedRangeSeconds: [longestRun(timeline, state => state === 'blocked'), longestRun(timeline, state => state !== 'visible')],
    longestVisibleRangeSeconds: [longestRun(timeline, state => state === 'visible'), longestRun(timeline, state => state !== 'blocked')],
  };
}

export function missionMetrics(mission, site) {
  if (!Number.isFinite(mission.start) || !Number.isFinite(mission.end) || mission.end <= mission.start) {
    throw new Error('Mission metrics require a finite positive UTC interval.');
  }
  const levels = [{ level:'retained', timelines: Object.fromEntries(CHANNELS.map(channel =>
    [channel, clippedTimeline(mission.timeline?.[channel], mission.start, mission.end)])) }];
  if (site?.refinementIntervals) {
    for (const level of ['coarse','fine']) {
      const sun = clippedTimeline(site.refinementIntervals.sun?.[level], mission.start, mission.end);
      const earth = clippedTimeline(site.refinementIntervals.earth?.[level], mission.start, mission.end);
      levels.push({ level, timelines:{ sun, earth, joint:jointTimeline(sun,earth) } });
    }
  }
  const refinementStatus = mission.refinement?.status ?? 'NOT_SUPPLIED';
  const basis = 'State totals describe retained interval labels. Duration ranges enclose the retained, coarse and fine evaluations where supplied; they are not statistical confidence intervals or bounds on unresolved physical effects.';
  const channels = Object.fromEntries(CHANNELS.map(channel => {
    const evaluations = levels.map(({level,timelines}) => ({level,...summarize(timelines[channel])}));
    const output = { ...evaluations[0] };
    delete output.level;
    for (const key of ['visibleRangeSeconds','blockedRangeSeconds','longestBlockedRangeSeconds','longestVisibleRangeSeconds']) {
      output[key] = [Math.min(...evaluations.map(row => row[key][0])), Math.max(...evaluations.map(row => row[key][1]))];
    }
    return [channel, { ...output, evaluations, refinementStatus,
      stateTotalsBasis:'Retained interval labels, including explicit uncertain and unknown time.', basis }];
  }));
  const warnings = [...new Set([
    ...(mission.coverageWarnings ?? []), ...(mission.scheduleWarnings ?? []), ...(site?.terrain?.warnings ?? []),
    ...(refinementStatus === 'UNRESOLVED' ? ['Mission refinement is unresolved; duration ranges must not be presented as exact physical durations.'] : []),
  ])];
  return { ...channels, warnings, basis, refinementStatus };
}
