import { makeCertificate, runMission } from './engine.mjs';

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

function loadDemo() {
  const [start, end] = bundle.coverage;
  const fallbackDuration = Math.min(24, (end - start) / 3600);
  const demo = bundle.demo ?? {
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
      line.append(`At least ${hours(tolerance.hours)}, through ${formatTime(tolerance.until)}.${tolerance.stopReason ? ` ${tolerance.stopReason}` : ''}`);
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
}

function renderPlot(mission) {
  const plot = byId('plot');
  const probe = byId('time-probe');
  chart = undefined;
  probe.hidden = true;
  plot.replaceChildren();
  const site = findSite(mission.siteId);
  const samples = (site?.geometry ?? []).filter(([time]) => time >= mission.start && time <= mission.end);
  const [azimuth, elevation, horizon] = target === 'sun' ? [1, 2, 3] : [4, 5, 6];
  byId('plot-subtitle').textContent = `${site?.name ?? mission.siteId} · ${shortTime(mission.start)} to ${shortTime(mission.end)}`;
  if (samples.length < 2) {
    plot.append(element('p', 'plot-empty', 'This mission does not contain enough cached geometry samples for a curve. Inspect the computed intervals below.'));
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
  const x = (time) => left + (right - left) * (time - mission.start) / (mission.end - mission.start);
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
  labels.append(element('span', '', shortTime(mission.start)), element('span', '', shortTime(mission.end)));
  plot.append(svg, labels, chartLegend());
  chart = { samples, x, line, azimuth, elevation, horizon, mission, skyline: site.terrain?.skyline };
  probe.hidden = false;
  byId('probe-slider').max = samples.length - 1;
  byId('probe-slider').value = Math.floor((samples.length - 1) / 2);
  updateProbe();
}

function renderInspection() {
  const mission = selectedMission();
  if (!mission) return;
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
    inputs = nextInputs;
    result = nextResult;
    selected = result.delayed?.status === 'FAIL' ? 'delayed' : 'nominal';
    renderDecisions();
    renderAlternatives();
    renderInspection();
    byId('form-status').textContent = '';
    byId('results').setAttribute('aria-busy', 'false');
    exportButton.disabled = false;
  } catch (error) {
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
  const mission = selectedMission();
  const evidence = Object.fromEntries(studies
    .filter(({ panel, report }) => panel.open && report?.inputs === requestedInputs && report.mission === mission)
    .map(({ id, report }) => [id, studyCertificate(report)]));
  try {
    const certificate = await makeCertificate(bundle, requestedInputs, result);
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
  isEdited = false;
  evaluate();
});
form.addEventListener('input', () => {
  if (!result) return;
  isEdited = true;
  exportButton.disabled = true;
  for (const study of studies) resetStudy(study, selectedMission());
  byId('form-status').textContent = 'Evaluate the updated inputs to refresh the decisions.';
});
byId('site').addEventListener('change', updateSiteDetail);
byId('reset-demo').addEventListener('click', () => {
  isEdited = false;
  chooseTarget('sun');
  loadDemo();
});
byId('view-sun').addEventListener('click', () => chooseTarget('sun'));
byId('view-earth').addEventListener('click', () => chooseTarget('earth'));
byId('probe-slider').addEventListener('input', updateProbe);
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
  } catch (error) {
    byId('load-error').hidden = false;
    byId('load-error').textContent = `The offline demo could not load. Start the local server from the project folder and reopen this page. ${error.message}`;
    byId('bundle-range').textContent = 'Unavailable';
    byId('results').setAttribute('aria-busy', 'false');
    decisionList.replaceChildren(element('p', 'loading panel', 'No mission evaluation is available.'));
  }
}

initialize();
