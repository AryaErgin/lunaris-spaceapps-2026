import { compareSites, communicationDemo, visibilitySummary, refinedEvents } from './overview.mjs';
import { makeCertificate, runMission } from './engine.mjs';
import { feasibilityMatrix, missionMetrics } from './operations.mjs';
import { playbackSamples, nearestSample, transitionCountdown, terrainClearance } from './playback.mjs';
import { renderHorizon } from './horizon.mjs';
import { createAtlas } from './atlas.mjs';

const byId = (id) => document.getElementById(id);
const form = byId('mission-form');
const exportButton = byId('export');
const decisionList = byId('decision-list');
const number = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const dateOnly = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
});
const compactTime = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
});
const phases = [
  ['nominal', 'Nominal landing'], ['delayed', 'After delay'], ['recommended', 'Recommended start'],
];
const constraintNames = {
  max_sun_block: 'Max unqualified sunlight',
  max_earth_block: 'Max Earth-center blockage',
  min_joint_total: 'Min total joint visibility',
  min_joint_continuous: 'Min continuous joint visibility',
  earliest: 'Earliest allowable start',
  latest: 'Latest allowable start',
};
const timelineChannels = [
  ['sun', 'Sunlight'], ['earth', 'Earth center'], ['joint', 'Joint visibility'],
];
const stateNames = {
  visible: 'Qualified / visible', blocked: 'Unqualified / blocked', uncertain: 'Unresolved crossing', unknown: 'Coverage unknown',
};

let bundle;
let inputs;
let result;
let selected = 'nominal';
let target = 'sun';
let chart;
let lastPlotWidth;
let isEdited = false;
let atlas;
let matrix;
let currentTime = null;
let inspectedMission;
let playbackTimer;
let playing = false;
const metricCache = new WeakMap();
const SENSITIVITY_STUDY_SITE = 'de-gerlache-rim';
const studies = [
  { id: 'height', cases: 'heights', evaluator: 'evaluateHeights' },
  { id: 'position', cases: 'positions', evaluator: 'evaluatePositions' },
  { id: 'terrain', cases: 'terrain realizations', evaluator: 'evaluateTerrainRealizations' },
].map((study) => ({
  ...study, panel: byId(`${study.id}-panel`), button: byId(`run-${study.id}s`),
  status: byId(`${study.id}-status`), content: byId(`${study.id}-results`),
  request: 0,
}));

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const iso = new Date(seconds * 1000).toISOString().replace('T', ' ');
  return `${iso.replace(/\.000Z$/, '').replace(/Z$/, '')} UTC`;
}

function shortTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const formatted = compactTime.format(seconds * 1000).replace(',', ' ·');
  if (seconds % 60 === 0) return `${formatted} UTC`;
  const secondsPart = new Date(seconds * 1000).toISOString().slice(17, 23).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
  return `${formatted}:${secondsPart} UTC`;
}

function hours(value, signed = false) {
  if (!Number.isFinite(value)) return '—';
  if (value !== 0 && Math.abs(value) < 0.01) return `${value < 0 ? '−' : signed ? '+' : ''}<0.01 h`;
  const sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  return `${sign}${number.format(Math.abs(value))} h`;
}

function precise(value) {
  return Number.isFinite(value) ? String(value) : '';
}

function inputTime(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString().slice(0, 19) : '';
}

function readTime(id) {
  const value = byId(id).value;
  return value ? Date.parse(`${value}Z`) / 1000 : null;
}

function readNumber(id) {
  const value = byId(id).value;
  return value === '' ? null : Number(value);
}

function findSite(id) {
  return bundle.sites.find((site) => site.id === id);
}

function constraintName(id) {
  return constraintNames[id] ?? String(id).replace(/[_-]/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

function statusChip(status, className = '') {
  const kind = { PASS: 'pass', FAIL: 'fail', INDETERMINATE: 'indeterminate' }[status] ?? 'unavailable';
  return element('span', `status status-${kind} ${className}`, status ?? 'NO PASS FOUND');
}

function updateSiteDetail() {
  const site = findSite(byId('site').value);
  if (!site) return;
  const text = `${Math.abs(site.lat)}° ${site.lat < 0 ? 'S' : 'N'}, ${site.lon}° E · ${site.heightM} m above ground`;
  const detail = byId('site-detail');
  detail.replaceChildren(element('span', '', `${text}. `));
  if (typeof site.source === 'string' && site.source.startsWith('https://')) {
    const link = element('a', '', 'Point source ↗');
    link.href = site.source;
    if (site.coordinateReference) link.title = site.coordinateReference;
    detail.append(link);
  }
}

function loadDemo(communications = false) {
  const [start, end] = bundle.coverage;
  const fallbackDuration = Math.min(24, (end - start) / 3600);
  const demo = (communications ? communicationDemo(bundle) : bundle.demo) ?? {
    siteId: bundle.sites[0].id, nominal: start, delayHours: 6, durationHours: fallbackDuration,
    maxSunHours: 8, maxEarthHours: 8, minJointHours: null, minContinuousJointHours: null,
    earliest: start, latest: end - fallbackDuration * 3600, gridMinutes: 60, mode: 'same-site',
  };
  byId('site').value = demo.siteId;
  byId('nominal').value = inputTime(demo.nominal);
  byId('duration').value = demo.durationHours;
  byId('delay').value = demo.delayHours;
  byId('max-sun').value = demo.maxSunHours;
  byId('max-earth').value = demo.maxEarthHours;
  byId('min-total').value = demo.minJointHours ?? '';
  byId('min-continuous').value = demo.minContinuousJointHours ?? '';
  byId('earliest').value = inputTime(demo.earliest);
  byId('latest').value = inputTime(demo.latest);
  byId('grid').value = demo.gridMinutes;
  byId('prelaunch').checked = demo.mode === 'prelaunch';
  updateSiteDetail();
  evaluate();
}

function readInputs() {
  const durationHours = readNumber('duration');
  if (durationHours <= 0) throw new Error('Mission length must be greater than zero.');
  const allowedEnd = bundle.coverage[1] - durationHours * 3600;
  const earliest = readTime('earliest') ?? bundle.coverage[0];
  const latest = readTime('latest') ?? allowedEnd;
  const gridMinutes = readNumber('grid');
  if (earliest > latest) throw new Error('The earliest allowable start must be at or before the latest start.');
  return {
    siteId: byId('site').value,
    nominal: readTime('nominal'),
    delayHours: readNumber('delay'),
    durationHours,
    maxSunHours: readNumber('max-sun'),
    maxEarthHours: readNumber('max-earth'),
    minJointHours: readNumber('min-total'),
    minContinuousJointHours: readNumber('min-continuous'),
    earliest,
    latest,
    gridMinutes,
    mode: byId('prelaunch').checked ? 'prelaunch' : 'same-site',
  };
}

function selectedMission() {
  if (typeof selected === 'number') return result.alternatives[selected];
  return result[selected];
}

function selectDecision(value) {
  pausePlayback();
  selected = value;
  for (const button of document.querySelectorAll('[data-decision]')) {
    button.setAttribute('aria-pressed', String(button.dataset.decision === String(value)));
  }
  renderInspection();
}

function renderDecisions() {
  decisionList.replaceChildren();
  for (const [key, label] of phases) {
    const evaluated = result[key];
    const card = element('button', 'panel decision');
    card.type = 'button';
    card.disabled = evaluated == null;
    card.dataset.decision = key;
    if (evaluated) {
      card.dataset.start = precise(evaluated.start);
      card.dataset.end = precise(evaluated.end);
    }
    card.setAttribute('aria-pressed', String(key === selected));
    card.append(element('span', 'decision-title', label));
    const date = element('span', 'decision-date', evaluated ? shortTime(evaluated.start) : 'No eligible start');
    if (evaluated) date.title = formatTime(evaluated.start);
    card.append(date);
    if (evaluated && evaluated.siteId !== inputs.siteId) {
      card.append(element('span', 'decision-site', findSite(evaluated.siteId)?.name ?? evaluated.siteId));
    }
    card.append(statusChip(evaluated?.status, 'decision-status'));
    card.addEventListener('click', () => selectDecision(key));
    decisionList.append(card);
  }

  const summary = byId('decision-summary');
  const delayed = result.delayed;
  const recommended = result.recommended;
  const failures = delayed?.constraints.filter((constraint) => constraint.status === 'FAIL') ?? [];
  summary.replaceChildren();
  if (delayed?.status === 'FAIL' && failures.length) {
    const line = element('p');
    line.append(element('strong', '', 'After the delay. '));
    line.append(failures.map((failure) => `${constraintName(failure.id)} (${hours(failure.margin, true)} margin)`).join(' · '));
    summary.append(line);
  } else if (delayed?.scheduleWarnings?.length) {
    summary.append(element('p', '', delayed.scheduleWarnings.join(' ')));
  } else if (delayed?.status === 'INDETERMINATE') {
    summary.append(element('p', '', 'Coverage or threshold uncertainty prevents a definitive delayed decision.'));
  }
  if (recommended && delayed && (recommended.start !== delayed.start || recommended.siteId !== delayed.siteId)) {
    const line = element('p');
    line.append(element('strong', '', 'Earliest sampled pass. '));
    line.append(`${formatTime(recommended.start)} · ${hours((recommended.start - delayed.start) / 3600)} after the proposed delayed start.`);
    summary.append(line);
    for (const failure of failures) {
      const recovery = recommended.constraints.find(({ id }) => id === failure.id);
      if (Number.isFinite(failure.margin) && Number.isFinite(recovery?.margin)) {
        summary.append(element('p', '', `${constraintName(failure.id)} margin improves from ${hours(failure.margin, true)} to ${hours(recovery.margin, true)}.`));
      }
    }
  }
  if (result.delayTolerance) {
    const tolerance = result.delayTolerance;
    if (tolerance.kind === 'lower-bound') {
      const line = element('p');
      line.append(element('strong', '', 'Connected feasible delay lower bound. '));
      line.append(`Feasible through ${formatTime(tolerance.until)}.${tolerance.stopReason ? ` ${tolerance.stopReason}` : ''}`);
      summary.append(line);
    } else {
      summary.append(element('p', '', `The nominal start stays in the same continuous feasible period for ${hours(tolerance.hours)}, through ${formatTime(tolerance.until)}.`));
    }
  }
  summary.hidden = !summary.childElementCount;
}

function renderConstraints(mission) {
  const site = findSite(mission.siteId);
  byId('constraint-summary').textContent = `${site?.name ?? mission.siteId} · ${formatTime(mission.start)} to ${formatTime(mission.end)}`;
  const table = element('table');
  table.setAttribute('aria-label', 'Hard limit results and witness intervals');
  const headers = element('tr');
  for (const label of ['Hard limit', 'Modeled', 'Threshold', 'Margin', 'Status', 'Witness interval (UTC)']) {
    const header = element('th', '', label);
    header.scope = 'col';
    headers.append(header);
  }
  const head = element('thead');
  head.append(headers);
  table.append(head);
  const body = element('tbody');
  for (const item of mission.constraints) {
    const row = element('tr');
    row.dataset.constraint = item.id;
    const name = element('th', '', constraintName(item.id));
    name.scope = 'row';
    const metric = element('td', 'number', hours(item.metric));
    metric.dataset.value = precise(item.metric);
    if (Number.isFinite(item.metric)) metric.title = `${item.metric} h${item.metricBasis ? ` · ${item.metricBasis}` : ''}`;
    if (item.range && item.range[0] !== item.range[1]) {
      const range = element('span', 'range', `${hours(item.range[0])} to ${hours(item.range[1])}`);
      range.title = `Possible values ${item.range[0]} to ${item.range[1]} h`;
      metric.append(range);
    }
    const threshold = element('td', 'number', hours(item.threshold));
    threshold.dataset.value = precise(item.threshold);
    if (Number.isFinite(item.threshold)) threshold.title = `${item.threshold} h`;
    const margin = element('td', `number ${item.margin < 0 ? 'margin-negative' : 'margin-positive'}`, hours(item.margin, true));
    margin.dataset.value = precise(item.margin);
    if (Number.isFinite(item.margin)) margin.title = `${item.margin} h`;
    const status = element('td');
    status.append(statusChip(item.status));
    const witness = element('td', 'witness-detail');
    if (Array.isArray(item.witness)) {
      witness.dataset.start = precise(item.witness[0]);
      witness.dataset.end = precise(item.witness[1]);
      witness.append(element('div', '', formatTime(item.witness[0])), element('div', '', `to ${formatTime(item.witness[1])}`));
    } else {
      witness.append(element('span', '', '—'));
    }
    if (item.witnessSegments?.length > 1) {
      const segments = element('details', 'witness-segments');
      segments.append(element('summary', '', `${item.witnessSegments.length} contributing intervals`));
      const list = element('ul');
      for (const [start, end] of item.witnessSegments) {
        const piece = element('li', '', `${formatTime(start)} to ${formatTime(end)}`);
        piece.dataset.start = precise(start);
        piece.dataset.end = precise(end);
        list.append(piece);
      }
      segments.append(list);
      witness.append(segments);
    }
    if (item.uncertainty) witness.append(element('small', 'uncertainty', String(item.uncertainty)));
    row.append(name, metric, threshold, margin, status, witness);
    body.append(row);
  }
  table.append(body);
  byId('constraint-table').replaceChildren(table);
  renderRefinement(mission.refinement);
  const warnings = byId('warnings');
  const messages = [...(mission.scheduleWarnings ?? []), ...(mission.coverageWarnings ?? [])];
  warnings.hidden = !messages.length;
  warnings.replaceChildren();
  if (!warnings.hidden) {
    warnings.append(element('strong', '', 'Decision warnings'));
    const list = element('ul');
    list.append(...messages.map((warning) => element('li', '', warning)));
    warnings.append(list);
  }
}

function renderRefinement(refinement) {
  const container = byId('refinement-evidence');
  container.replaceChildren();
  container.hidden = !refinement;
  if (!refinement) return;
  const details = element('details');
  details.append(element('summary', '', `Refinement check · ${refinement.status.toLowerCase()}`));
  if (Number.isFinite(refinement.maxShiftSeconds)) {
    details.append(element('p', '', `Largest required blocked-run bound shift ${number.format(refinement.maxShiftSeconds)} s. The target is below ${number.format(refinement.limitSeconds)} s. Coarse evaluation ${refinement.coarseStatus}, fine evaluation ${refinement.fineStatus}.`));
  }
  const list = element('ul');
  for (const item of refinement.constraints ?? []) {
    const [coarseLower, coarseUpper] = item.coarseRange;
    const [fineLower, fineUpper] = item.fineRange;
    const line = element('li', '', `${constraintName(item.id)} · coarse ${hours(coarseLower)} to ${hours(coarseUpper)} · fine ${hours(fineLower)} to ${hours(fineUpper)} · largest shift ${number.format(item.maxShiftSeconds)} s`);
    line.dataset.refinement = item.id;
    line.dataset.shift = precise(item.maxShiftSeconds);
    list.append(line);
  }
  if (list.childElementCount) details.append(list);
  container.dataset.status = refinement.status;
  container.dataset.shift = precise(refinement.maxShiftSeconds);
  container.append(details);
}

function renderAlternatives() {
  const section = byId('alternatives');
  const summary = byId('search-detail');
  const list = byId('alternatives-list');
  const search = result.search;
  const alternatives = result.alternatives ?? [];
  section.hidden = !search;
  list.replaceChildren();
  if (!search) return;
  const scope = inputs.mode === 'prelaunch' ? 'Prelaunch concept comparison' : 'Same-site search';
  const count = search.candidateCount;
  const range = search.from <= search.to ? ` · ${formatTime(search.from)} to ${formatTime(search.to)}` : '';
  summary.textContent = `${scope} · ${search.gridMinutes ?? inputs.gridMinutes}-minute grid${Number.isFinite(count) ? ` · ${count} evaluated` : ''}${range}`;
  const counts = result.counts;
  if (counts) {
    list.append(element('p', 'secondary', `${counts.PASS} pass · ${counts.FAIL} fail · ${counts.INDETERMINATE} indeterminate`));
  }
  if (!alternatives.length) {
    list.append(element('p', 'secondary', 'No sampled start passed all limits.'));
    return;
  }
  list.append(element('p', 'secondary', 'Each listed option trades off landing time, site change, or constraint margin.'));
  const entries = element('ul');
  for (const [index, alternative] of alternatives.entries()) {
    const listItem = element('li');
    const site = findSite(alternative.siteId);
    const button = element('button', '', `${shortTime(alternative.start)}${site ? ` · ${site.name}` : ''}`);
    button.type = 'button';
    button.title = formatTime(alternative.start);
    button.dataset.decision = index;
    button.setAttribute('aria-pressed', String(index === selected));
    button.addEventListener('click', () => {
      selectDecision(index);
      byId('plot-title').scrollIntoView({ block: 'start' });
    });
    listItem.append(button);
    entries.append(listItem);
  }
  list.append(entries);
}

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function geometryPath(samples, column, x, y) {
  let drawing = false;
  const segments = [];
  for (const sample of samples) {
    const value = sample[column];
    if (!Number.isFinite(value)) {
      drawing = false;
      continue;
    }
    const coordinates = `${x(sample[0]).toFixed(2)} ${y(value).toFixed(2)}`;
    if (!drawing) segments.push(`M${coordinates}`);
    else segments.push(`L${coordinates}`);
    drawing = true;
  }
  return segments.join(' ');
}

function timelineLegend() {
  const legend = element('div', 'chart-legend timeline-legend');
  for (const [state, label] of Object.entries(stateNames)) {
    const entry = element('span');
    entry.append(element('i', `square-key timeline-${state}`), label);
    legend.append(entry);
  }
  return legend;
}

function renderTimeline(mission) {
  const timeline = byId('timeline');
  timeline.replaceChildren();
  for (const [channel, label] of timelineChannels) {
    const row = element('div', 'timeline-row');
    const track = element('div', 'timeline-track');
    track.setAttribute('aria-label', `${label} state intervals`);
    const intervals = mission.timeline?.[channel] ?? [];
    const duration = mission.end - mission.start;
    for (const [start, end, state] of intervals) {
      const clippedStart = Math.max(start, mission.start);
      const clippedEnd = Math.min(end, mission.end);
      if (clippedStart >= clippedEnd) continue;
      const piece = element('span', `timeline-piece timeline-${state}`);
      piece.style.left = `${100 * (clippedStart - mission.start) / duration}%`;
      piece.style.width = `${100 * (clippedEnd - clippedStart) / duration}%`;
      piece.title = `${stateNames[state] ?? state} · ${formatTime(start)} to ${formatTime(end)}`;
      piece.dataset.state = state;
      piece.dataset.start = precise(start);
      piece.dataset.end = precise(end);
      track.append(piece);
    }
    const playhead = element('span', 'timeline-playhead');
    playhead.setAttribute('aria-hidden', 'true');
    track.append(playhead);
    row.append(element('span', 'timeline-label', label), track);
    timeline.append(row);
  }
  timeline.append(timelineLegend());
  const details = byId('interval-details');
  details.hidden = false;
  if (details.open) renderIntervalList(mission);
}

function renderIntervalList(mission = selectedMission()) {
  if (!mission || !byId('interval-details').open) return;
  const channel = byId('interval-channel').value;
  const table = element('table');
  table.setAttribute('aria-label', `${timelineChannels.find(([key]) => key === channel)[1]} UTC visibility intervals`);
  const head = element('thead');
  const heading = element('tr');
  for (const label of ['Start (UTC)', 'End (UTC)', 'State']) {
    const header = element('th', '', label);
    header.scope = 'col';
    heading.append(header);
  }
  head.append(heading);
  table.append(head);
  const body = element('tbody');
  for (const [start, end, state] of mission.timeline?.[channel] ?? []) {
    const row = element('tr');
    row.append(element('td', '', formatTime(start)), element('td', '', formatTime(end)), element('td', '', stateNames[state] ?? state));
    body.append(row);
  }
  table.append(body);
  byId('interval-table').replaceChildren(table);
}

function chartLegend() {
  const legend = element('div', 'chart-legend');
  const elevation = element('span');
  elevation.append(element('i', `line-key ${target}`), target === 'sun' ? 'Sun-center elevation' : 'Earth-center elevation');
  const horizon = element('span');
  horizon.append(element('i', 'line-key horizon'), 'Terrain model (cell-center trace)');
  legend.append(elevation, horizon);
  return legend;
}

function updateProbe() {
  if (!chart) return;
  const { samples, x, line, azimuth, elevation, horizon, mission, skyline } = chart;
  const sample = samples[Number(byId('probe-slider').value)];
  if (!sample) return;
  currentTime = sample[0];
  const position = x(sample[0]);
  line.setAttribute('x1', position);
  line.setAttribute('x2', position);
  const angle = (value) => Number.isFinite(value) ? `${number.format(value)}°` : 'unknown';
  const state = mission.timeline?.[target]?.find(([start, end]) => sample[0] >= start && sample[0] < end)?.[2];
  const details = [formatTime(sample[0]), `az ${angle(sample[azimuth])}`, `el ${angle(sample[elevation])}`, `skyline ${angle(sample[horizon])}`];
  if (state) details.push(stateNames[state]);
  if (skyline?.length && Number.isFinite(sample[azimuth])) {
    const bearing = ((sample[azimuth] % 360) + 360) % 360;
    const sector = skyline[Math.floor(bearing * skyline.length / 360)];
    const blocker = sector?.[5];
    if (blocker && Number.isFinite(blocker[2])) details.push(`nominal blocker ${number.format(blocker[2] / 1000)} km away`);
  }
  byId('probe-output').textContent = details.join(' · ');
  byId('probe-slider').setAttribute('aria-valuetext', formatTime(sample[0]));
  const site = findSite(mission.siteId);
  byId('local-sky').style.setProperty('--sky-step-duration',`${playing?Math.min(180,1000/Number(byId('sky-speed').value)):180}ms`);
  renderHorizon(byId('local-sky'),site,sample,mission,samples);
  renderTelemetry(site,sample,mission);
  for (const playhead of document.querySelectorAll('.timeline-playhead')) {
    playhead.hidden = sample[0] < mission.start || sample[0] >= mission.end;
    playhead.style.left = `${100*(sample[0]-mission.start)/(mission.end-mission.start)}%`;
  }
  byId('sky-jump').value = inputTime(sample[0]);
}

function renderPlot(mission) {
  const plot = byId('plot');
  const probe = byId('time-probe');
  chart = undefined;
  probe.hidden = true;
  plot.replaceChildren();
  byId('local-sky').replaceChildren();
  const site = findSite(mission.siteId);
  const scope = byId('time-scope').value;
  const samples = playbackSamples(site,mission,bundle.coverage,scope);
  const domain = scope === 'coverage' ? bundle.coverage : [Math.max(mission.start,bundle.coverage[0]),Math.min(mission.end,bundle.coverage[1])];
  const [azimuth, elevation, horizon] = target === 'sun' ? [1, 2, 3] : [4, 5, 6];
  byId('plot-subtitle').textContent = `${site?.name ?? mission.siteId} · ${shortTime(mission.start)} to ${shortTime(mission.end)}`;
  if (samples.length === 0) {
    pausePlayback();
    plot.append(element('p', 'plot-empty', 'This mission does not contain enough cached geometry samples for a curve. Inspect the computed intervals below.'));
    byId('live-telemetry').replaceChildren(element('p','secondary','No sampled geometry inside this mission and cache intersection. Interval-based mission evidence remains below.'));
    byId('playback-status').textContent = 'No cached geometry in the selected time domain. Try full data coverage.';
    byId('sky-play').disabled = true;
    return;
  }

  const values = samples.flatMap((row) => [row[elevation], row[horizon]]).filter(Number.isFinite);
  if (!values.length) {
    plot.append(element('p', 'plot-empty', 'Geometry samples are unavailable for this target.'));
    return;
  }
  let lower = 0;
  let upper = 0;
  for (const value of values) {
    lower = Math.min(lower, value);
    upper = Math.max(upper, value);
  }
  const pad = Math.max(.12, (upper - lower) * .05);
  lower -= pad;
  upper += pad;
  const width = Math.max(240, Math.floor(plot.clientWidth));
  lastPlotWidth = plot.clientWidth;
  const height = 208;
  const left = 49;
  const right = width - 5;
  const top = 8;
  const bottom = height - 8;
  const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
  svg.setAttribute('aria-label', `${target === 'sun' ? 'Sun' : 'Earth'} elevation and terrain horizon in degrees over the selected mission window`);
  const x = (time) => left + (right - left) * (time - domain[0]) / (domain[1] - domain[0]);
  const y = (value) => bottom - (bottom - top) * (value - lower) / (upper - lower);
  for (const vertical of [0, .25, .5, .75, 1]) {
    const position = left + vertical * (right - left);
    svg.append(svgElement('line', { x1: position, x2: position, y1: top, y2: bottom, class: 'plot-axis' }));
  }
  for (const level of [upper, (upper + lower) / 2, lower]) {
    const position = y(level);
    svg.append(svgElement('line', { x1: left, x2: right, y1: position, y2: position, class: 'plot-axis' }));
    const label = svgElement('text', { x: left - 4, y: position + 4, 'text-anchor': 'end' });
    label.textContent = `${number.format(level)}°`;
    svg.append(label);
  }
  svg.append(svgElement('line', { x1: left, x2: right, y1: y(0), y2: y(0), class: 'plot-axis plot-zero' }));
  svg.append(svgElement('path', { d: geometryPath(samples, horizon, x, y), class: 'plot-curve plot-horizon' }));
  svg.append(svgElement('path', { d: geometryPath(samples, elevation, x, y), class: `plot-curve plot-${target}` }));
  const line = svgElement('line', { x1: left, x2: left, y1: top, y2: bottom, class: 'plot-probe' });
  svg.append(line);
  const labels = element('div', 'axis-labels');
  labels.append(element('span', '', shortTime(domain[0])), element('span', '', shortTime(domain[1])));
  plot.append(svg, labels, chartLegend());
  chart = { samples, x, line, azimuth, elevation, horizon, mission, domain, skyline: site.terrain?.skyline };
  probe.hidden = false;
  byId('probe-slider').max = samples.length - 1;
  byId('probe-slider').value = currentTime===null ? 0 : nearestSample(samples,currentTime,domain) ?? 0;
  byId('sky-play').disabled = isEdited || samples.length<2;
  byId('sky-jump').min = inputTime(domain[0]);
  byId('sky-jump').max = inputTime(samples.at(-1)[0]);
  if(!playing) byId('playback-status').textContent = 'Paused · actual cached samples at 30-minute cadence. Use arrow keys to step. Geometry display does not refine interval decisions.';
  updateProbe();
}

function renderInspection() {
  renderVisibilityOverview();
  const mission = selectedMission();
  if (!mission) return;
  if(inspectedMission!==mission) {pausePlayback();currentTime=null;inspectedMission=mission;}
  const site = findSite(mission.siteId);
  const sources = byId('terrain-provenance');
  const { local, regional } = site?.terrain?.fine ?? {};
  if (local && regional) {
    const parts = [`${local.spacingM} m local and ${regional.spacingM} m regional nominal pixel spacing`];
    if (site.workingFrame) parts.push(`working frame ${site.workingFrame}`);
    sources.textContent = `${site.name} uses ${parts.join(', ')}. Grid spacing differs from effective resolution. Source hashes are in the certificate.`;
  }
  renderConstraints(mission);
  renderPlot(mission);
  renderTimeline(mission);
  updateProbe();
  atlas?.setSelected(mission.siteId);
  for (const study of studies) resetStudy(study, mission);
}

function resetStudy(study, mission) {
  study.request += 1;
  study.report = undefined;
  study.content.hidden = true;
  study.content.replaceChildren();
  const matchesStudyPoint = mission?.siteId === SENSITIVITY_STUDY_SITE;
  study.button.disabled = !matchesStudyPoint || isEdited;
  let message = '';
  if (isEdited) message = `Evaluate the updated mission before comparing ${study.cases}.`;
  else if (matchesStudyPoint) message = `Selected mission begins ${formatTime(mission.start)}.`;
  else message = 'Available for landing decisions at de Gerlache Rim 1.';
  study.status.textContent = message;
}

function renderStudyReport(study, report) {
  const content = study.content;
  const summary = element('div', 'study-summary');
  const total = report.scenario_results.length;
  const passes = report.scenario_results.filter(({ status }) => status === 'PASS').length;
  summary.append(element('strong', '', `Passes ${passes} of ${total} evaluated ${study.cases}`), statusChip(report.robust_status));
  const scope = element('p', 'secondary', report.scope);
  const cards = element('div', 'study-cards');
  const nominalHeight = findSite(report.siteId)?.heightM;
  for (const scenario of report.scenario_results) {
    const card = element('section', 'study-card');
    card.dataset.scenario = scenario.id;
    card.dataset.status = scenario.status;
    card.dataset.height = precise(scenario.heightM);
    const header = element('header');
    const suffix = scenario.heightM === nominalHeight ? ' · nominal' : '';
    header.append(element('h3', '', scenario.label ?? `${number.format(scenario.heightM)} m${suffix}`), statusChip(scenario.status));
    card.append(header);
    if (Number.isFinite(scenario.lat) && Number.isFinite(scenario.lon)) {
      const coordinates = `${Math.abs(scenario.lat).toFixed(6)}° ${scenario.lat < 0 ? 'S' : 'N'}, ${scenario.lon.toFixed(6)}° E`;
      const ground = Number.isFinite(scenario.groundM) ? ` · ground ${number.format(scenario.groundM)} m` : '';
      card.dataset.latitude = precise(scenario.lat);
      card.dataset.longitude = precise(scenario.lon);
      card.dataset.ground = precise(scenario.groundM);
      card.append(element('p', 'coordinates', `${coordinates}${ground}`));
    }
    const limits = element('ul', 'study-limits');
    for (const constraint of scenario.constraints) {
      const line = element('li');
      const margin = element('span', `number ${constraint.margin < 0 ? 'margin-negative' : 'margin-positive'}`, hours(constraint.margin, true));
      line.dataset.constraint = constraint.id;
      line.dataset.margin = precise(constraint.margin);
      if (Number.isFinite(constraint.margin)) margin.title = `${constraint.margin} h · ${constraint.status}`;
      line.append(element('span', '', constraintName(constraint.id)), margin);
      limits.append(line);
    }
    card.append(limits);
    const warnings = [...(scenario.scheduleWarnings ?? []), ...(scenario.coverageWarnings ?? [])];
    if (warnings.length || scenario.refinement) {
      const details = element('details');
      details.append(element('summary', '', 'Coverage and refinement'));
      const list = element('ul');
      if (scenario.refinement) {
        const refinement = scenario.refinement;
        list.append(element('li', '', `${refinement.status} · largest required blocked-run bound shift ${number.format(refinement.maxShiftSeconds)} s.`));
      }
      list.append(...warnings.map((warning) => element('li', '', warning)));
      details.append(list);
      card.append(details);
    }
    cards.append(card);
  }
  content.dataset.robustStatus = report.robust_status;
  content.replaceChildren(summary, scope, cards, element('p', 'secondary', 'The decision certificate includes this study for the inspected mission.'));
  content.hidden = false;
}

async function evaluateStudy(study) {
  const mission = selectedMission();
  if (isEdited || mission?.siteId !== SENSITIVITY_STUDY_SITE) return;
  const currentRequest = ++study.request;
  const evaluatedInputs = inputs;
  study.button.disabled = true;
  study.status.textContent = `Loading the offline ${study.id} study…`;
  try {
    const isHeight = study.id === 'height';
    study.assets ??= Promise.all([
      isHeight ? import('./height.mjs') : import('./scenarios.mjs'),
      fetch(`./data/${study.id}-study.json`).then((response) => {
        if (!response.ok) throw new Error(`Offline ${study.id} data returned HTTP ${response.status}.`);
        return response.json();
      }),
    ]).catch((error) => {
      study.assets = undefined;
      throw error;
    });
    const [module, evidence] = await study.assets;
    if (currentRequest !== study.request) return;
    const evaluator = module[study.evaluator];
    const report = evaluator(bundle, evidence, evaluatedInputs, mission);
    if (!report) throw new Error(`The ${study.id} study has no evidence for the selected mission.`);
    study.report = { report, evidence, mission, inputs: evaluatedInputs, decision: selected };
    study.status.textContent = `${formatTime(report.mission_start)} to ${formatTime(report.mission_end)}`;
    renderStudyReport(study, report);
  } catch (error) {
    if (currentRequest !== study.request) return;
    study.status.textContent = error instanceof Error ? error.message : `The ${study.id} study could not be evaluated.`;
  } finally {
    if (currentRequest === study.request) study.button.disabled = false;
  }
}

function studyCertificate(record) {
  const { report, evidence, mission, decision } = record;
  const site = findSite(report.siteId);
  return {
    scenario_ids: report.scenario_ids,
    scenario_results: report.scenario_results,
    robustness_scope: report.scope,
    robust_status: report.robust_status,
    source_hash: report.source_hash,
    mission_start: new Date(mission.start * 1000).toISOString(),
    mission_end: new Date(mission.end * 1000).toISOString(),
    inspected_decision: typeof decision === 'number' ? `alternative-${decision + 1}` : decision,
    site: {
      site_id: site.id, name: site.name, latitude_deg: site.lat, longitude_east_deg: site.lon,
      coordinate_source: site.source, ground_elevation_m: site.groundM,
    },
    manifest: evidence.manifest ?? null,
  };
}

function evaluate() {
  if (!form.reportValidity()) return;
  try {
    const nextInputs = readInputs();
    const nextResult = runMission(bundle, nextInputs);
    isEdited = false;
    inputs = nextInputs;
    result = nextResult;
    selected = result.delayed?.status === 'FAIL' ? 'delayed' : 'nominal';
    renderDecisions();
    renderComparison();
    renderAlternatives();
    renderInspection();
    renderFeasibility();
    byId('form-status').textContent = '';
    byId('results').setAttribute('aria-busy', 'false');
    exportButton.disabled = false;
  } catch (error) {
    isEdited = true;
    if (result) for (const study of studies) resetStudy(study, selectedMission());
    byId('form-status').textContent = error instanceof Error ? error.message : 'The mission could not be evaluated.';
    exportButton.disabled = true;
  }
}

function chooseTarget(value) {
  target = value;
  for (const key of ['sun', 'earth']) byId(`view-${key}`).setAttribute('aria-pressed', String(key === value));
  if (result) renderPlot(selectedMission());
}

async function downloadCertificate() {
  exportButton.disabled = true;
  const requestedInputs = inputs;
  const requestedResult = result;
  const requestedMatrix = matrix;
  const mission = selectedMission();
  const requestedTime = currentTime;
  const requestedSample = chart?.samples.find(row=>row[0]===requestedTime)?.slice();
  const inspection = requestedSample ? {sample_utc:requestedTime,sample:requestedSample,geometry_cadence_seconds:1800,
    basis:'Actual cached geometry sample; sampled center-trace clearance does not establish a visibility decision.',
    events:Object.fromEntries(['sun','earth'].map(key=>[key,refinedEvents(findSite(mission.siteId),key,requestedTime,bundle.coverage)]))} : null;
  const evidence = Object.fromEntries(studies
    .filter(({ panel, report }) => panel.open && report?.inputs === requestedInputs && report.mission === mission)
    .map(({ id, report }) => [id, studyCertificate(report)]));
  try {
    const certificate = await makeCertificate(bundle, requestedInputs, requestedResult);
    certificate.same_input_site_comparison = compareSites(bundle, requestedInputs);
    certificate.visibility_summary = missionOverview(mission);
    certificate.inspected_mission = {siteId:mission.siteId,start:mission.start,end:mission.end,status:mission.status};
    certificate.mission_visibility_metrics = missionMetrics(mission,findSite(mission.siteId));
    certificate.date_site_comparison = requestedMatrix;
    if(inspection) certificate.display_inspection=inspection;
    if (evidence.position) certificate.position_study = evidence.position;
    if (evidence.terrain) certificate.terrain_study = evidence.terrain;
    if (evidence.height) {
      const { scenario_ids, scenario_results, robustness_scope, robust_status, ...metadata } = evidence.height;
      Object.assign(certificate, { scenario_ids, scenario_results, robustness_scope, robust_status });
      for (const [key, value] of Object.entries(metadata)) certificate[`height_study_${key}`] = value;
    }
    const blob = new Blob([`${JSON.stringify(certificate, null, 2)}\n`], { type: 'application/json' });
    const resource = URL.createObjectURL(blob);
    const anchor = element('a');
    anchor.href = resource;
    anchor.download = `lunaris-decision-${requestedInputs.siteId}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(resource), 60000);
  } catch (error) {
    byId('form-status').textContent = error instanceof Error ? error.message : 'The certificate could not be exported.';
  } finally {
    if (requestedInputs === inputs && !isEdited) exportButton.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  evaluate();
});
form.addEventListener('input', () => {
  if (!result) return;
  isEdited = true;
  pausePlayback();
  byId('sky-play').disabled = true;
  exportButton.disabled = true;
  for (const study of studies) resetStudy(study, selectedMission());
  byId('site-comparison').replaceChildren(element('p', '', 'Inputs changed. Evaluate to refresh the comparison.'));
  byId('visibility-overview').replaceChildren(element('p', '', 'Inputs changed. Evaluate to refresh visibility metrics.'));
  byId('feasibility-grid').replaceChildren(element('p','','Inputs changed. Evaluate to refresh the date/site matrix.'));
  byId('live-telemetry').replaceChildren(element('p','secondary','Inputs changed. Evaluate to refresh telemetry. The chart shows the previous evaluated mission.'));
  byId('form-status').textContent = 'Evaluate the updated inputs to refresh the decisions.';
});
byId('communication-demo').addEventListener('click', () => loadDemo(true));
byId('site').addEventListener('change', updateSiteDetail);
byId('reset-demo').addEventListener('click', () => {
  isEdited = false;
  chooseTarget('sun');
  loadDemo();
});
byId('view-sun').addEventListener('click', () => chooseTarget('sun'));
byId('view-earth').addEventListener('click', () => chooseTarget('earth'));
byId('probe-slider').addEventListener('input', () => {pausePlayback();updateProbe();});
byId('sky-play').addEventListener('click',startPlayback);
byId('sky-pause').addEventListener('click',() => pausePlayback());
byId('sky-reset').addEventListener('click',() => {pausePlayback('Reset to the first cached sample in this domain.');byId('probe-slider').value=0;updateProbe();});
byId('sky-speed').addEventListener('change',() => {if(playing) {pausePlayback();startPlayback();}});
byId('time-scope').addEventListener('change',() => {pausePlayback();if(result) renderPlot(selectedMission());});
byId('sky-jump-go').addEventListener('click',jumpPlayback);
byId('sky-jump').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();jumpPlayback();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pausePlayback();});
byId('interval-details').addEventListener('toggle', () => { if (result) renderIntervalList(); });
byId('interval-channel').addEventListener('change', () => { if (result) renderIntervalList(); });
for (const study of studies) {
  study.button.addEventListener('click', () => evaluateStudy(study));
  study.panel.addEventListener('toggle', () => {
    if (!study.panel.open && result) resetStudy(study, selectedMission());
  });
}
exportButton.addEventListener('click', downloadCertificate);
new ResizeObserver(() => {
  if (result && byId('plot').clientWidth !== lastPlotWidth) renderPlot(selectedMission());
}).observe(byId('plot'));

async function initialize() {
  try {
    const response = await fetch('./data/bundle.json');
    if (!response.ok) throw new Error(`Offline bundle request returned HTTP ${response.status}.`);
    bundle = await response.json();
    if (!bundle.sites?.length || bundle.coverage?.length !== 2 || !bundle.coverage.every(Number.isFinite)) {
      throw new Error('The offline bundle is incomplete.');
    }
    const [start, end] = bundle.coverage;
    byId('bundle-range').textContent = dateOnly.formatRange(start * 1000, end * 1000);
    byId('bundle-range').title = `${formatTime(start)} to ${formatTime(end)}`;
    byId('bundle-note').textContent = `${bundle.sites.length} study point${bundle.sites.length === 1 ? '' : 's'} · NASA LOLA terrain · JPL ephemerides`;
    const siteOptions = bundle.sites.map((site) => {
      const option = element('option', '', site.name);
      option.value = site.id;
      return option;
    });
    byId('site').replaceChildren(...siteOptions);
    byId('site').disabled = false;
    byId('evaluate').disabled = false;
    byId('reset-demo').disabled = false;
    byId('communication-demo').disabled = false;
    for (const { panel } of studies) panel.hidden = !findSite(SENSITIVITY_STUDY_SITE);
    byId('prelaunch-option').hidden = bundle.sites.length < 2;
    const definitions = bundle.manifest?.visibilityDefinitions ?? bundle.manifest?.visibility_definitions;
    if (definitions && typeof definitions === 'object') {
      const paragraphs = Object.values(definitions).filter((definition) => typeof definition === 'string');
      if (paragraphs.length) byId('visibility-definitions').replaceChildren(...paragraphs.map((definition) => element('p', '', definition)));
    }
    const validation = bundle.manifest?.validation?.horizons;
    if (Number.isFinite(validation?.max_angular_separation_deg)) {
      const comparison = byId('geometry-check');
      const difference = new Intl.NumberFormat('en', { maximumSignificantDigits: 3 }).format(validation.max_angular_separation_deg);
      comparison.textContent = `Horizons geometry cross-check ${validation.status.toLowerCase()} · largest direction difference ${difference}° across ${validation.comparison_count} comparisons.`;
      comparison.hidden = false;
    }
    loadDemo();
    try {
      atlas=await createAtlas({bundle,mapRoot:byId('site-map'),sitesRoot:byId('map-sites'),
        coordinateForm:byId('coordinate-form'),feedback:byId('coordinate-feedback'),
        onSelect:siteId=>{
          // Explicit map selection starts a new concept-study mission at that point.
          byId('site').value=siteId;updateSiteDetail();pausePlayback();evaluate();
        }});
      atlas.setSelected(selectedMission().siteId);
    } catch(error) {
      byId('site-map').textContent=`Terrain atlas unavailable: ${error.message}. Study-point mission calculations remain available.`;
      byId('coordinate-feedback').textContent='Coordinate exploration requires the atlas metadata; no unsupported calculations are available.';
    }
  } catch (error) {
    byId('load-error').hidden = false;
    byId('load-error').textContent = `The offline demo could not load. Start the local server from the project folder and reopen this page. ${error.message}`;
    byId('bundle-range').textContent = 'Unavailable';
    byId('results').setAttribute('aria-busy', 'false');
    decisionList.replaceChildren(element('p', 'loading panel', 'No mission evaluation is available.'));
  }
}

initialize();

function missionOverview(mission) {
 const site=findSite(mission.siteId);
 return Object.fromEntries(['sun','earth','joint'].map(channel=>[channel,{
  ...visibilitySummary(mission.timeline[channel],mission.start,mission.end),
  events:channel==='joint' ? null : refinedEvents(site,channel,mission.start,bundle.coverage)
 }]));
}
function renderComparison() {
 const root=byId('site-comparison'); root.replaceChildren();
 for(const row of compareSites(bundle,inputs)) {
  const card=element('article','comparison-card'); card.dataset.site=row.siteId;
  card.append(element('h3','',row.name));
  for(const [key,label] of [['nominal','Planned start'],['delayed','Same delay']]) {
   const mission=row[key]; const line=element('p',''); line.append(`${label}: `,statusChip(mission.status));card.append(line);
   for(const [channel,title] of timelineChannels) {
    const m=visibilitySummary(mission.timeline[channel],mission.start,mission.end).seconds;
    const line=element('p','comparison-metric',`${title}: ${hours(m.visible/3600)} confirmed; ${hours((m.uncertain+m.unknown)/3600)} unresolved`);
    line.dataset.phase=key;line.dataset.channel=channel;line.dataset.visibleSeconds=m.visible;card.append(line);
   }
   const bounded=missionMetrics(mission,findSite(row.siteId));
   for(const [channel,metric,title] of [['sun','longestBlockedRangeSeconds','Longest sunlight-unqualified'],['earth','longestBlockedRangeSeconds','Longest Earth blockage'],['joint','longestVisibleRangeSeconds','Longest joint opportunity']]) {
    const range=bounded[channel][metric],line=element('p','comparison-metric',`${title}: ${durationRange(range)}`);
    line.dataset.phase=key;line.dataset.metric=`${channel}-${metric}`;line.dataset.lower=range[0];line.dataset.upper=range[1];card.append(line);
   }
   card.append(element('p','telemetry-note',`Duration ranges enclose retained/coarse/fine models · refinement ${bounded.refinementStatus}.`));
  }
  root.append(card);
 }
}
function renderVisibilityOverview() {
 if(!result || isEdited) return;
 const mission=selectedMission(), overview=missionOverview(mission),root=byId('visibility-overview');root.replaceChildren();
 root.append(element('p','secondary',`Selected decision: ${formatTime(mission.start)} to ${formatTime(mission.end)}. Confirmed geometric visibility is not electrical power or a working radio link.`));
 for(const [channel,title] of timelineChannels) {
  const summary=overview[channel],m=summary.seconds,card=element('article','comparison-card');card.dataset.channel=channel;
  card.append(element('h3','',title));
  card.append(element('p','',`${hours(m.visible/3600)} confirmed visible / ${hours(m.blocked/3600)} blocked / ${hours((m.unknown+m.uncertain)/3600)} unresolved within this mission.`));
  if(summary.events) for(const [key,label] of [['loss','Next established loss'],['reacquisition','Next established reacquisition']]) {
   const interval=summary.events[key];
   card.append(element('p','event-time',`${label}: ${interval ? interval[0]===interval[1] ? formatTime(interval[0])+' (cached transition)' : formatTime(interval[0])+' to '+formatTime(interval[1])+' (retained/coarse/fine enclosure'+(summary.events.unresolved.includes(key)?'; timing unresolved':'')+')' : 'not established in remaining contiguous cache; not a guarantee of continuous visibility'}`));
  }
  root.append(card);
 }
 root.append(element('p','secondary',`Established resolved-state events are measured from the selected mission start, may lie after its end, and stop at missing data or ${formatTime(bundle.coverage[1])}. Earlier uncertain pockets may conceal additional unproved crossings. Brackets retain crossing uncertainty; DEM resolution and refinement limitations still apply.`));
}

function pausePlayback(message) {
  if(!message && playing) message='Paused · inspect cached samples with the time slider or arrow keys.';
  clearTimeout(playbackTimer); playing=false;
  byId('sky-play')?.setAttribute('aria-pressed','false');
  if(message && byId('playback-status')) byId('playback-status').textContent=message;
}

function startPlayback() {
  if(!chart || isEdited || chart.samples.length<2) return;
  pausePlayback();
  const slider=byId('probe-slider');
  if(Number(slider.value)>=chart.samples.length-1) slider.value=0;
  playing=true;byId('sky-play').setAttribute('aria-pressed','true');
  byId('playback-status').textContent=`Playing cached 30-minute samples · ${byId('sky-speed').selectedOptions[0].textContent}. Stops at this domain's final sample.`;
  const tick=()=>{
    if(!playing || !chart || isEdited) return;
    if(Number(slider.value)>=chart.samples.length-1) {
      pausePlayback('Playback ended at the last cached sample in this domain. No geometry extrapolated.');return;
    }
    slider.value=Number(slider.value)+1;updateProbe();
    playbackTimer=setTimeout(tick,1000/Number(byId('sky-speed').value));
  };
  updateProbe();playbackTimer=setTimeout(tick,1000/Number(byId('sky-speed').value));
}

function jumpPlayback() {
  if(!chart || isEdited) return;
  pausePlayback();
  const time=Date.parse(`${byId('sky-jump').value}Z`)/1000;
  const index=nearestSample(chart.samples,time,chart.domain);
  if(index===null) {
    byId('playback-status').textContent='This UTC time is outside the selected cached domain. No extrapolated positions are available.';return;
  }
  byId('probe-slider').value=index;updateProbe();
  byId('playback-status').textContent=`Jumped to nearest actual cached sample: ${formatTime(currentTime)}. Ties choose the earlier sample; geometry cadence is 30 minutes.`;
}

function durationRange(range) {
  return Math.abs(range[1]-range[0])<1e-6 ? hours(range[0]/3600) : `${hours(range[0]/3600)}–${hours(range[1]/3600)}`;
}

function renderTelemetry(site,sample,mission) {
  if(isEdited) return;
  const root=byId('live-telemetry');root.replaceChildren();root.dataset.time=sample[0];
  let metrics=metricCache.get(mission);
  if(!metrics) {metrics=missionMetrics(mission,site);metricCache.set(mission,metrics);}
  const grid=element('div','telemetry-grid');
  for(const [id,label,value,note] of [
    ['sun-elevation','Solar-center elevation',sample[2],'Above local radial level'],
    ['earth-elevation','Earth-center elevation',sample[5],'Apparent topocentric center'],
    ['sun-clearance','Sun terrain clearance',terrainClearance(sample,'sun'),'Center elevation minus DEM center trace'],
    ['earth-clearance','Earth terrain clearance',terrainClearance(sample,'earth'),'Center trace; interval status governs visibility'],
  ]) {
    const card=element('article',`telemetry-card ${id.startsWith('sun')?'sun':'earth'}`);card.dataset.metric=id;
    card.dataset.value=precise(value);
    card.append(element('span','telemetry-label',label),element('strong','telemetry-value',Number.isFinite(value)?`${value.toFixed(2)}°`:'Unknown'),element('span','telemetry-note',note));
    grid.append(card);
  }
  const durations=element('div','telemetry-grid duration-telemetry');
  for(const [channel,key,label] of [
    ['sun','visibleRangeSeconds','Qualified Sun-center time'],
    ['sun','longestBlockedRangeSeconds','Longest sunlight-unqualified run'],
    ['earth','visibleRangeSeconds','Earth-center LOS time'],
    ['earth','longestBlockedRangeSeconds','Longest Earth obstruction'],
    ['joint','visibleRangeSeconds','Total joint visibility'],
    ['joint','longestVisibleRangeSeconds','Longest joint operating window'],
  ]) {
    const range=metrics[channel][key],card=element('article',`telemetry-card ${channel}`);
    card.dataset.metric=`${channel}-${key}`;card.dataset.lower=range[0];card.dataset.upper=range[1];
    card.append(element('span','telemetry-label',label),element('strong','telemetry-value',durationRange(range)),element('span','telemetry-note','Selected mission · retained/coarse/fine bounds'));
    durations.append(card);
  }
  const events=element('div','telemetry-events');
  for(const [channel,label] of [['sun','Sun'],['earth','Earth']]) {
    const found=refinedEvents(site,channel,sample[0],bundle.coverage);
    const line=element('p',`event-countdown ${channel}`);
    line.append(element('strong','',`${label} established state changes · `));
    for(const [key,title] of [['loss','loss'],['reacquisition','reacquisition']]) {
      const countdown=transitionCountdown(found,key,sample[0]);
      let text;
      if(countdown.kind==='bounded') text=`${title} in ${durationRange(countdown.remaining)} (numerical enclosure)`;
      else if(countdown.kind==='unresolved') text=`${title}: timing unresolved, ${shortTime(countdown.interval[0])} to ${shortTime(countdown.interval[1])}; countdown withheld`;
      else text=`${title}: not established before a gap or cache end`;
      const item=element('span','',text);item.dataset.channel=channel;item.dataset.event=key;item.dataset.kind=countdown.kind;
      if(countdown.interval) {item.dataset.start=countdown.interval[0];item.dataset.end=countdown.interval[1];}
      line.append(item, ' · ');
    }
    events.append(line);
  }
  const durationDetails=element('details','duration-details');
  durationDetails.append(element('summary','','Mission duration metrics · 6 bounded values'),durations);
  root.append(grid,durationDetails,events,element('p','telemetry-note',`Duration ranges are numerical/model enclosures, not physical confidence intervals. Mission refinement: ${metrics.refinementStatus}. Earlier uncertain pockets may conceal additional unproved crossings before the established state changes above. Sun-center qualification is not full-disc illumination or array power; Earth-center LOS is not a working communications link. Timelines retain their explicit unresolved intervals.`));
}

function renderFeasibility() {
  const root=byId('feasibility-grid');root.replaceChildren();
  matrix=feasibilityMatrix(bundle,inputs);
  const scroll=element('div','heatmap-scroll');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','Scrollable daily site feasibility table');
  const table=element('table','feasibility-table'),head=element('thead'),header=element('tr');
  const corner=element('th','','Study point / UTC day');corner.scope='col';header.append(corner);
  for(const start of matrix.starts) {
    const th=element('th','',new Date(start*1000).getUTCDate());th.scope='col';th.title=formatTime(start);header.append(th);
  }
  head.append(header);table.append(head);
  const body=element('tbody');
  const detail=element('div','heatmap-detail');detail.setAttribute('role','status');
  detail.textContent='Select a cell to inspect its exact start, decision, constraint margins and warnings. Cross-site dates are prelaunch concept comparisons.';
  for(const row of matrix.rows) {
    const tr=element('tr');const label=element('th','',row.name);label.scope='row';tr.append(label);
    for(const mission of row.cells) {
      const td=element('td');
      const button=element('button',`feasibility-cell status-${mission.status.toLowerCase()}`,{PASS:'P',FAIL:'F',INDETERMINATE:'?'}[mission.status]);
      button.type='button';button.dataset.site=row.siteId;button.dataset.start=mission.start;button.dataset.status=mission.status;
      const description=`${row.name}, ${formatTime(mission.start)}, ${mission.status}`;
      button.title=description;button.setAttribute('aria-label',description);
      button.addEventListener('click',()=>{
        for(const active of root.querySelectorAll('[aria-pressed]')) active.setAttribute('aria-pressed','false');
        button.setAttribute('aria-pressed','true');detail.replaceChildren();
        const heading=element('p');heading.append(element('strong','',`${row.name} · ${shortTime(mission.start)} · `),statusChip(mission.status));detail.append(heading);
        for(const c of mission.constraints) detail.append(element('p','secondary',`${constraintName(c.id)} · ${c.status} · ${hours(c.margin,true)} signed margin · ${durationRange(c.range.map(h=>h*3600))} modeled`));
        for(const warning of [...mission.scheduleWarnings,...mission.coverageWarnings])detail.append(element('p','secondary',warning));
        const use=element('button','outline','Use this site and start in concept study');use.type='button';
        use.addEventListener('click',()=>{
          byId('site').value=row.siteId;byId('nominal').value=inputTime(mission.start);updateSiteDetail();evaluate();selectDecision('nominal');
          byId('console').scrollIntoView({block:'start'});
        });detail.append(use);
      });td.append(button);tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);scroll.append(table);root.append(scroll,detail);
  byId('feasibility-note').textContent=`${matrix.starts.length} dates × ${matrix.rows.length} sites · starts every ${matrix.stepHours} h at ${new Date(inputs.nominal*1000).toISOString().slice(11,19)} UTC · ${inputs.durationHours} h fixed mission. P = PASS, F = FAIL, ? = INDETERMINATE. All hard limits and the allowed start range remain unchanged. The last date may be censored by the cache end. ${matrix.basis}`;
}
