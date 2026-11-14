import { compareSites, communicationDemo, visibilitySummary, refinedEvents } from './overview.mjs';
import { makeCertificate, runMission, evaluateStart } from './engine.mjs';
import { feasibilityMatrix, missionMetrics } from './operations.mjs';
import { playbackSamples, nearestSample, transitionCountdown, terrainClearance } from './playback.mjs';
import { renderHorizon } from './horizon.mjs';
import { createAtlas } from './atlas.mjs';
import { sceneFrame, missionStory } from './scene-model.mjs';
import {constraintEvidence,constraintSegments,evidenceTime} from './decision-evidence.mjs';
import {resolveAutomaticSchedule,findLandingOpportunities,findVisibilityOpportunities,makeEnvironmentRecord,environmentInputs} from './opportunities.mjs';

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
let sceneController;
let sceneLoading;
let sceneDisabled=false;
let latestSceneFrame;
let visualSiteId;
let guidedPhase='nominal';
let experienceMode='orbital';
let sceneIntent=0;
let requestedExperienceMode='orbital';
let productMode='explore';
let applicationRelease={application_release_sha:null,public_url:null};
let configurationRequest=0;
let configurationReport;
let configurationsRequested=false;
let earthReferenceRequested=false;
let rescueAnimation=0;
const prefixCountCache=new WeakMap();
let telemetryMission;
let renderingNotes;
let evidenceMission;
let highlightedConstraintId;
let comparisonOptions;
let scheduleAnchor;
let explicitSchedule={earliest:false,latest:false};
let opportunityRequest=0;
let opportunityReport;
let requirementsEnabled=false;
let requirementsSource='example';
let delayStoryEnabled=false;
let loadingPreset=false;
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

function syncAssessment(){
  document.body.classList.toggle('environment-only',!requirementsEnabled);
  byId('apply-requirements').checked=requirementsEnabled;
  byId('assessment-label').textContent=requirementsSource==='custom'?'Evaluate my mission requirements':'Evaluate illustrative mission requirements';
  document.querySelector('.illustrative-requirements').textContent=requirementsSource==='custom'?'User-defined requirements; no flight or hardware certification implied.':'Illustrative mission requirements — not real lander specifications.';
  byId('opportunity-scope').textContent=requirementsEnabled?'Before launch · three study points · unchanged selected limits':'Compare confirmed Sun + Earth time · no mission limits applied';
  byId('decision-evidence').hidden=!requirementsEnabled;
  byId('environment-overview').hidden=requirementsEnabled;
  document.querySelector('.story-progress').hidden=!requirementsEnabled||!delayStoryEnabled;
  byId('story-status').hidden=!requirementsEnabled;byId('story-next').hidden=!requirementsEnabled;byId('story-witness').hidden=!requirementsEnabled;
  const jump=document.querySelector('.decision-jump');jump.href=requirementsEnabled?'#decision-evidence':'#explain';jump.textContent=requirementsEnabled?'See all mission requirements and proof ↓':'How to read these measurements ↓';
  exportButton.textContent=requirementsEnabled?'↓ Decision certificate':'↓ Environment record';
  byId('results-title').textContent=requirementsEnabled?'Mission decisions':'Environmental evidence';
  byId('decision-list').hidden=!requirementsEnabled;
  byId('comparison-edit-limits').textContent=requirementsEnabled?'Edit these requirements in Advanced ↗':'Add mission requirements in Advanced ↗';
  document.querySelector('label[for="comparison-duration"]').firstChild.textContent=requirementsEnabled?'Shared mission duration ':'Shared view duration ';
  document.querySelector('label[for="visual-arrival"]').firstChild.textContent=requirementsEnabled&&delayStoryEnabled?'Original arrival ':'Arrival ';
  byId('visual-duration').setAttribute('aria-label',requirementsEnabled?'Mission duration in hours':'Environment view duration in hours; blank uses 12 hours');
  for(const study of studies)study.panel.hidden=!requirementsEnabled||!bundle?.sites.some(s=>s.id===SENSITIVITY_STUDY_SITE);
}

function environmentalMeasurements(root,mission,{timelines=false}={}){
  const measurements=mission.metrics??missionMetrics(mission,findSite(mission.siteId));root.replaceChildren();
  const grid=element('div','environment-measurements');
  for(const [channel,key,label]of [['sun','visibleRangeSeconds','Sun-center visibility'],['earth','visibleRangeSeconds','Earth-center visibility'],['joint','visibleRangeSeconds','Together'],['sun','longestBlockedRangeSeconds','Longest Sun unavailability'],['earth','longestBlockedRangeSeconds','Longest Earth obstruction'],['joint','longestVisibleRangeSeconds','Longest continuous overlap']]){
    const range=measurements[channel][key],card=element('div',`environment-measurement ${channel}`);card.dataset.metric=`${channel}-${key}`;card.dataset.lower=range[0];card.dataset.upper=range[1];
    card.append(element('span','',label),element('strong','',durationRange(range)));card.title=range.map(durationClock).join(' to ');grid.append(card);
  }
  root.append(grid);
  if(timelines){
    const lines=element('div','environment-lines');
    for(const [key,title]of [['sun','Sun'],['earth','Earth'],['joint','Both']]){
      const line=element('div','environment-line');line.dataset.channel=key;line.append(element('span','',title));const track=element('div','story-joint-track');
      for(const [a,b,state]of mission.timeline[key]){const bar=element('span',`timeline-piece timeline-${state}`);bar.style.left=`${100*(a-mission.start)/(mission.end-mission.start)}%`;bar.style.width=`${100*(b-a)/(mission.end-mission.start)}%`;bar.title=`${title} ${state}: ${formatTime(a)} to ${formatTime(b)}`;track.append(bar);}
      const head=element('span','timeline-playhead story-joint-playhead');head.dataset.start=mission.start;head.dataset.end=mission.end;track.append(head);line.append(track);lines.append(line);
    }root.append(lines);
  }
  root.append(element('p','environment-note',`${timelines?'Timelines show retained interval labels; ranges also enclose both refinements. ':''}Center visibility is not electrical power or a working radio link.`));
  return measurements;
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
  const caution=siteCaution(site.id);if(caution)detail.append(element('p','',caution));
}

function siteCaution(id){
  const slope=renderingNotes?.sites.find(s=>s.siteId===id)?.slope;
  return slope?.status==='COMPUTED'&&slope.slopeDeg>15?`Steep study point: ${slope.slopeDeg.toFixed(1)}° local DEM gradient. A region center, not an approved landing pad.`:'';
}

function loadDemo(communications = true,environmentOnly=false) {
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
  scheduleAnchor={nominal:demo.nominal,durationHours:demo.durationHours};
  explicitSchedule={earliest:false,latest:false};
  requirementsEnabled=!environmentOnly;requirementsSource='example';comparisonOptions=null;delayStoryEnabled=!environmentOnly;
  syncAssessment();
  selected='nominal';
  updateSiteDetail();
  loadingPreset=true;try{evaluate();}finally{loadingPreset=false;}
}

function readInputs() {
  const durationHours = readNumber('duration');
  if (durationHours <= 0) throw new Error('Mission length must be greater than zero.');
  const allowedEnd = bundle.coverage[1] - durationHours * 3600;
  const nominal=readTime('nominal');
  const automatic=resolveAutomaticSchedule(bundle.coverage,{nominal,durationHours,
    earliest:readTime('earliest')??bundle.coverage[0],latest:readTime('latest')??allowedEnd},scheduleAnchor,explicitSchedule);
  const {earliest,latest}=automatic;
  byId('earliest').value=inputTime(earliest);byId('latest').value=inputTime(latest);
  scheduleAnchor={nominal,durationHours};
  for(const key of ['earliest','latest'])byId(key).dataset.automatic=String(!explicitSchedule[key]);
  byId('schedule-origin').textContent=`Allowed starts: ${formatTime(earliest)} to ${formatTime(latest)}. ${explicitSchedule.earliest||explicitSchedule.latest?'Your explicitly edited bounds are retained.':'Automatic bounds follow cached coverage after arrival or duration changes.'}`;
  const gridMinutes = readNumber('grid');
  if (earliest > latest) throw new Error('The earliest allowable start must be at or before the latest start.');
  return {
    siteId: byId('site').value,
    nominal,
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
  guidedPhase=typeof value==='string'?value:'recommended';
  renderMissionStory();
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
  summary.hidden = !requirementsEnabled||!summary.childElementCount;
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
  updateExperienceFrame(site,sample,mission);
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
    latestSceneFrame={site,sample:null,states:{sun:'unknown',earth:'unknown'}};
    sceneController?.setFrame(latestSceneFrame);
    byId('hero-play').disabled=true;
    byId('hero-time').disabled=true;
    byId('hero-visibility').textContent='No cached geometry in the selected mission. Bodies are withheld; no position is extrapolated.';
    byId('scene-clock').textContent='GEOMETRY UNAVAILABLE IN THIS MISSION';
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
  if (!form.reportValidity()) {isEdited=true;invalidateExperience();exportButton.disabled=true;return false;}
  try {
    const nextInputs = readInputs();
    if(!loadingPreset&&inputs&&(inputs.nominal!==nextInputs.nominal||inputs.siteId!==nextInputs.siteId||inputs.durationHours!==nextInputs.durationHours))delayStoryEnabled=false;
    const nextResult = runMission(bundle,requirementsEnabled?nextInputs:environmentInputs(nextInputs));
    clearOpportunities();
    cancelSceneEntry();
    isEdited = false;
    inputs = nextInputs;
    result = nextResult;
    if(typeof selected==='number'?!result.alternatives[selected]:!result[selected])selected='nominal';
    guidedPhase=selected;
    renderDecisions();
    renderComparison();
    renderAlternatives();
    renderInspection();
    renderFeasibility();
    renderMissionStory();
    byId('form-status').textContent = '';
    byId('results').setAttribute('aria-busy', 'false');
    exportButton.disabled = false;
    return true;
  } catch (error) {
    isEdited = true;
    invalidateExperience();
    if (result) for (const study of studies) resetStudy(study, selectedMission());
    byId('form-status').textContent = error instanceof Error ? error.message : 'The mission could not be evaluated.';
    if(productMode==='explore'){byId('workspace-notice').hidden=false;byId('workspace-notice').textContent=byId('form-status').textContent;}
    exportButton.disabled = true;
    return false;
  }
}

function clearOpportunities(){
  ++opportunityRequest;opportunityReport=null;
  byId('landing-opportunities').hidden=true;byId('landing-opportunities').setAttribute('aria-busy','false');
  byId('find-opportunities').disabled=false;byId('find-opportunities').textContent='Find landing opportunities';
}

async function searchOpportunities(){
  if(!applyVisualArrival())return;
  pausePlayback();const requestedInputs=inputs,request=++opportunityRequest,root=byId('landing-opportunities');
  root.hidden=productMode!=='explore';root.setAttribute('aria-busy','true');root.dataset.kind='SEARCHING';
  byId('opportunities-status').textContent='Checking supported sites with your unchanged requirements…';
  byId('opportunities-basis').textContent='This is a new-arrival search before launch; the landing delay is not added.';
  byId('opportunity-options').replaceChildren();byId('opportunity-other').hidden=true;
  byId('find-opportunities').disabled=true;byId('find-opportunities').textContent='Checking landing opportunities…';
  try{
    const finder=requirementsEnabled?findLandingOpportunities:findVisibilityOpportunities;
    const report=await finder(bundle,requestedInputs,{cancelled:()=>request!==opportunityRequest||inputs!==requestedInputs,
      yieldControl:()=>new Promise(resolve=>setTimeout(resolve,0))});
    if(request!==opportunityRequest||inputs!==requestedInputs)return;
    opportunityReport=report;renderOpportunities(report);
    if(productMode==='explore')root.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  }catch(error){
    if(request!==opportunityRequest||error.name==='AbortError')return;
    root.dataset.kind='ERROR';byId('opportunities-status').textContent=`Search not run: ${error.message}`;
  }finally{
    if(request===opportunityRequest){root.setAttribute('aria-busy','false');byId('find-opportunities').disabled=false;byId('find-opportunities').textContent='Find landing opportunities';}
  }
}

function renderOpportunities(report){
  const root=byId('landing-opportunities');root.hidden=productMode!=='explore';root.dataset.kind=report.kind;
  root.dataset.candidates=report.search.candidateCount;root.dataset.requestedArrival=report.requested.nominal;
  if(!report.requirementsApplied){
    byId('opportunities-title').textContent={VISIBILITY_FOUND:'Explore visibility opportunities',UNRESOLVED:'Joint visibility remains unresolved',NO_JOINT:'No joint visibility established on this grid',NO_DATA:'Outside complete cached coverage',SCHEDULE_EMPTY:'No eligible date in your schedule'}[report.kind];
    byId('opportunities-status').textContent=report.search.candidateCount
      ?`${report.counts.WITH_JOINT} options have confirmed overlap · ${report.counts.UNRESOLVED} have unresolved overlap · ${report.counts.NO_JOINT} have none in the model. No mission requirements applied.`
      :report.kind==='NO_DATA'?'No complete observation window fits the cached November data. Choose a covered date or a shorter view; no mission verdict is implied.'
        :'No sampled start at or after this arrival fits your allowed schedule. Edit the allowed dates to explore further.';
    byId('opportunities-basis').textContent=report.search.candidateCount
      ?`${report.requested.durationHours} h views · ${report.search.gridMinutes}-minute start grid. Each site shows the most confirmed Sun + Earth time; earlier UTC breaks ties. Unresolved time can change the physical ranking.`
      :`Available evidence: ${formatTime(bundle.coverage[0])} to ${formatTime(bundle.coverage[1])}, exclusive end. Requested duration: ${report.requested.durationHours} h.`;
    const cards=byId('opportunity-options');cards.replaceChildren();
    for(const view of report.options){
      const card=element('article','opportunity-card');Object.assign(card.dataset,{site:view.siteId,start:view.start,status:'ENVIRONMENT'});
      card.append(element('p','eyebrow',view.metrics.joint.visibleRangeSeconds[0]>0?'Confirmed Sun + Earth overlap':view.metrics.joint.visibleRangeSeconds[1]>0?'Unresolved possible overlap':'No joint visibility at this sample'),element('h3','',findSite(view.siteId).name),element('p','opportunity-date',shortTime(view.start)));
      const measurements=element('div','');environmentalMeasurements(measurements,view);card.append(measurements);
      const warning=siteCaution(view.siteId);if(warning)card.append(element('p','comparison-caution',warning));
      const button=element('button','outline','Explore this arrival →');button.type='button';button.addEventListener('click',()=>{
        byId('site').value=view.siteId;byId('nominal').value=inputTime(view.start);selected='nominal';
        if(evaluate()){showGuidedPhase('nominal');sceneController?.selectSite(view.siteId,{focus:false});byId('experience').scrollIntoView({block:'start',behavior:'instant'});}
      });card.append(button);cards.append(card);
    }
    byId('opportunity-other').hidden=true;return;
  }
  const titles={PASS_FOUND:'Passing arrivals found',NO_PASS:'No checked arrival passes',UNRESOLVED:'No passing arrival proven',NO_DATA:'No complete mission in cached data',SCHEDULE_EMPTY:'No eligible start inside your allowed schedule'};
  byId('opportunities-title').textContent=titles[report.kind];
  byId('opportunities-status').textContent=report.search.candidateCount
    ?`${report.counts.PASS} passing · ${report.counts.FAIL} failed · ${report.counts.INDETERMINATE} unresolved site-and-time options. ${report.kind==='UNRESOLVED'?'Uncertainty prevents ruling out a passing window.':report.kind==='NO_PASS'?'This applies only to the checked grid, sites and requirements.':''}`
    :report.kind==='NO_DATA'?'The chosen arrival, allowed dates or mission duration leave no complete mission inside the November cache. No environmental PASS or FAIL has been invented.'
      :'Your schedule contains no eligible starts at or after this arrival. This is a scheduling exclusion, not a lunar-environment failure.';
  byId('opportunities-basis').textContent=report.search.candidateCount
    ?`${report.requested.durationHours} h mission · ${report.search.sites.length} supported study points · starts every ${report.search.gridMinutes} min, ${shortTime(report.search.firstStart)} to ${shortTime(report.search.lastStart)}. All selected limits retained. ${report.coverageClipped?'Only fully covered missions were searched; the grid phase is unchanged.':''}`
    :`Available evidence: ${formatTime(bundle.coverage[0])} to ${formatTime(bundle.coverage[1])} (exclusive end). Allowed starts: ${formatTime(report.requested.earliest)} to ${formatTime(report.requested.latest)}.`;
  const cards=byId('opportunity-options');cards.replaceChildren();
  const passingIds=new Set(report.options.map(m=>m.siteId));
  const rows=[...report.options.map(mission=>({mission,label:'First confirmed pass at this site'})),
    ...bundle.sites.filter(s=>!passingIds.has(s.id)).map(site=>{
      const uncertain=report.unresolved.find(m=>m.siteId===site.id),near=report.nearMisses.find(r=>r.mission.siteId===site.id);
      return uncertain?{mission:uncertain,label:'Unresolved sampled arrival'}:near?{mission:near.mission,label:'Fewest broken rules at this site'}:null;
    }).filter(Boolean)];
  for(const {mission,label} of rows){
    const card=element('article','opportunity-card');Object.assign(card.dataset,{site:mission.siteId,start:mission.start,status:mission.status});
    card.append(element('p','eyebrow',label),element('h3','',findSite(mission.siteId).name),statusChip(mission.status),element('p','opportunity-date',shortTime(mission.start)));
    const joint=mission.constraints.find(c=>c.id==='min_joint_total');
    if(joint)card.append(element('p','opportunity-joint',`${evidenceTime(joint.range[0])} confirmed Sun + Earth`));
    card.append(element('p','opportunity-rule',optionDecisionText(mission)));
    const caution=siteCaution(mission.siteId);if(caution)card.append(element('p','comparison-caution',caution));
    const view=element('button','outline','View this arrival →');view.type='button';view.addEventListener('click',()=>{
      byId('site').value=mission.siteId;byId('nominal').value=inputTime(mission.start);selected='nominal';
      if(evaluate()){showGuidedPhase('nominal');sceneController?.selectSite(mission.siteId,{focus:false});byId('experience').scrollIntoView({block:'start',behavior:'instant'});}
    });card.append(view);cards.append(card);
  }
  const other=byId('opportunity-near-misses');other.replaceChildren();
  for(const {mission,failedRules} of report.nearMisses){
    const row=element('p','',`${findSite(mission.siteId).name} · ${shortTime(mission.start)} · ${failedRules.length} broken ${failedRules.length===1?'rule':'rules'}: ${failedRules.map(c=>{const v=constraintEvidence(c);return `${v.title}: ${v.metricText}, required ${v.requirementText}; margin ${v.marginText}`;}).join('; ')}.`);other.append(row);
  }
  for(const mission of report.unresolved)other.append(element('p','',`${findSite(mission.siteId).name} · ${shortTime(mission.start)}: ${optionDecisionText(mission)} No PASS is established.`));
  if(report.nearMisses.length)other.prepend(element('p','secondary','Near misses are ordered by fewer proven broken rules, then earlier UTC. This is not a safety score, and no requirement was relaxed.'));
  byId('opportunity-other').hidden=!other.childElementCount;
}

function chooseTarget(value) {
  target = value;
  for (const key of ['sun', 'earth']) byId(`view-${key}`).setAttribute('aria-pressed', String(key === value));
  if (result) renderPlot(selectedMission());
}

async function downloadCertificate() {
  if(!requirementsEnabled){
    downloadJson(makeEnvironmentRecord(bundle,selectedMission(),{releaseSha:applicationRelease.application_release_sha}),`lunaris-environment-${selectedMission().siteId}.json`);return;
  }
  exportButton.disabled = true;
  const requestedInputs = inputs;
  const requestedResult = result;
  const requestedMatrix = matrix;
  const requestedConfigurations=configurationReport;
  const requestedRequirementsSource=requirementsSource;
  const requestedRole=typeof selected==='number'?'alternative':selected;
  const requestedAlternativeIndex=typeof selected==='number'?selected:null;
  const requestedRelease={...applicationRelease};
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
    const certificate = await makeCertificate(bundle, requestedInputs, requestedResult,{
      role:requestedRole,alternativeIndex:requestedAlternativeIndex,
      releaseSha:requestedRelease.application_release_sha,publicUrl:requestedRelease.public_url});
    certificate.same_input_site_comparison = compareSites(bundle, requestedInputs);
    certificate.requirements_origin=requestedRequirementsSource==='custom'?'user-defined':'illustrative-example';
    certificate.visibility_summary = missionOverview(mission);
    certificate.inspected_mission = {role:requestedRole,alternativeIndex:requestedAlternativeIndex,siteId:mission.siteId,start:mission.start,end:mission.end,status:mission.status};
    certificate.mission_visibility_metrics = missionMetrics(mission,findSite(mission.siteId));
    certificate.date_site_comparison = requestedMatrix;
    if(requestedConfigurations?.mission===mission&&requestedConfigurations.inputs===requestedInputs)certificate.one_factor_configurations=requestedConfigurations.report;
    if(inspection) certificate.display_inspection=inspection;
    if (evidence.position) certificate.position_study = evidence.position;
    if (evidence.terrain) certificate.terrain_study = evidence.terrain;
    if (evidence.height) {
      const { scenario_ids, scenario_results, robustness_scope, robust_status, ...metadata } = evidence.height;
      Object.assign(certificate, { scenario_ids, scenario_results, robustness_scope, robust_status });
      for (const [key, value] of Object.entries(metadata)) certificate[`height_study_${key}`] = value;
    }
    downloadJson(certificate,`lunaris-certificate-v2-${requestedRole}-${mission.siteId}-${new Date(mission.start*1000).toISOString().slice(0,16).replaceAll(':','')}.json`);
  } catch (error) {
    byId('form-status').textContent = error instanceof Error ? error.message : 'The certificate could not be exported.';
  } finally {
    if (requestedInputs === inputs && !isEdited) exportButton.disabled = false;
  }
}

function downloadJson(record,filename){
  const resource=URL.createObjectURL(new Blob([`${JSON.stringify(record,null,2)}\n`],{type:'application/json'}));
  const anchor=element('a');anchor.href=resource;anchor.download=filename;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(resource),60000);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  requirementsEnabled=true;syncAssessment();
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
  invalidateExperience();
  byId('form-status').textContent = 'Evaluate the updated inputs to refresh the decisions.';
});
byId('communication-demo').addEventListener('click', () => {setExpert(true);loadDemo(true);});
byId('solar-demo').addEventListener('click',()=>{setExpert(true);loadDemo(false);});
byId('expert-toggle').addEventListener('click',()=>setExpert(byId('top').hidden));
for(const button of document.querySelectorAll('[data-workspace]'))button.addEventListener('click',()=>setProductMode(button.dataset.workspace));
byId('compare-return').addEventListener('click',()=>setProductMode('explore'));
byId('comparison-edit-limits').addEventListener('click',()=>{setExpert(true);byId('max-sun').focus();});
byId('comparison-duration').addEventListener('change',()=>{
  const hours=Number(byId('comparison-duration').value);
  if(!Number.isFinite(hours)||hours<=0){byId('comparison-duration').value=inputs.durationHours;byId('comparison-difference').textContent='Duration not changed. Choose a positive shared mission duration.';return;}
  byId('duration').value=hours;evaluate();
});
byId('add-comparison-option').addEventListener('click',()=>{if(comparisonOptions?.length===2){comparisonOptions.push({...comparisonOptions[1],key:'C'});renderOptionComparison();}});
byId('remove-comparison-option').addEventListener('click',()=>{comparisonOptions=comparisonOptions?.slice(0,2);renderOptionComparison();});
function applyVisualArrival(){
  const field=byId('visual-arrival');
  if(!field.value||!Number.isFinite(Date.parse(`${field.value}Z`))){
    field.setCustomValidity('Choose a valid original arrival in UTC.');field.reportValidity();
    byId('workspace-notice').hidden=false;byId('workspace-notice').textContent='Arrival not changed. Choose a valid UTC date and time, then apply it.';return false;
  }
  const duration=byId('visual-duration').value===''?12:Number(byId('visual-duration').value);
  if(!Number.isFinite(duration)||duration<=0){byId('workspace-notice').hidden=false;byId('workspace-notice').textContent='Choose a positive mission duration. Arrival and mission have not changed.';return false;}
  field.setCustomValidity('');byId('workspace-notice').hidden=true;
  byId('nominal').value=field.value;byId('duration').value=duration;byId('visual-duration').value=duration;selected='nominal';if(!evaluate())return false;showGuidedPhase('nominal');return true;
}
byId('visual-date-go').addEventListener('click',applyVisualArrival);
for(const id of ['visual-arrival','visual-duration'])byId(id).addEventListener('change',applyVisualArrival);
for(const key of ['earliest','latest'])for(const event of ['input','change'])byId(key).addEventListener(event,()=>{explicitSchedule[key]=Boolean(byId(key).value);});
byId('find-opportunities').addEventListener('click',searchOpportunities);
byId('opportunity-limits').addEventListener('click',()=>{setExpert(true);byId('latest').focus();});
byId('apply-requirements').addEventListener('change',()=>{
  requirementsEnabled=byId('apply-requirements').checked;syncAssessment();clearOpportunities();
  if(!requirementsEnabled)delayStoryEnabled=false;
  if(!requirementsEnabled&&selected!=='nominal'){
    const current=selectedMission();byId('site').value=current.siteId;byId('nominal').value=inputTime(current.start);selected='nominal';guidedPhase='nominal';evaluate();
  }else evaluate();
});
byId('start-delay-demo').addEventListener('click',()=>{loadDemo();setProductMode('explore');});
for(const id of ['max-sun','max-earth','min-total','min-continuous'])byId(id).addEventListener('input',()=>{requirementsSource='custom';syncAssessment();});
document.querySelector('.scene-site-picker').addEventListener('focusin',()=>pausePlayback());
byId('visual-arrival').addEventListener('input',()=>{byId('visual-arrival').setCustomValidity('');clearOpportunities();});
byId('visual-duration').addEventListener('input',clearOpportunities);
for(const link of document.querySelectorAll('.main-nav a'))link.addEventListener('click',()=>{
  if(link.getAttribute('href')!=='#experience')setExpert(true);
});
byId('scene-fallback').addEventListener('click',()=>{setExpert(true);byId('console').scrollIntoView({block:'start'});});
byId('explore-site').addEventListener('click',enterSurface);
byId('mode-surface').addEventListener('click',enterSurface);
byId('reset-orbit').addEventListener('click',()=>sceneController?.focus('overview'));
byId('mode-orbital').addEventListener('click',()=>{++sceneIntent;requestedExperienceMode='orbital';pausePlayback();sceneController?.setMode('orbital');setExperienceMode('orbital');});
byId('visual-site').addEventListener('change',()=>selectVisualSite(byId('visual-site').value));
byId('hero-play').addEventListener('click',async()=>{
  if(experienceMode==='orbital'){await enterSurface();sceneController?.focus(latestSceneFrame?.states.earth==='visible'?'earth':'sun');}
  if(!isEdited)startPlayback();
});
byId('hero-pause').addEventListener('click',()=>pausePlayback());
byId('guide-open').addEventListener('click',()=>{pausePlayback();byId('mission-story').scrollIntoView({block:'start'});});
byId('hero-reset').addEventListener('click',()=>{pausePlayback('Reset to the first cached sample in this domain.');byId('probe-slider').value=0;updateProbe();});
byId('hero-speed').addEventListener('change',()=>{
  byId('sky-speed').value=byId('hero-speed').value;
  if(playing){pausePlayback();startPlayback();}
});
byId('hero-time').addEventListener('input',()=>{pausePlayback();byId('probe-slider').value=byId('hero-time').value;updateProbe();});
for(const [id,target] of [['focus-earth','earth'],['focus-sun','sun'],['focus-terrain','site']])byId(id).addEventListener('click',()=>sceneController?.focus(target));
byId('focus-earth').addEventListener('click',()=>{byId('earth-inset').hidden=true;});
byId('close-earth-inset').addEventListener('click',()=>{earthReferenceRequested=false;byId('earth-inset').hidden=true;});
for(const button of document.querySelectorAll('[data-story]'))button.addEventListener('click',()=>showGuidedPhase(button.dataset.story));
byId('story-next').addEventListener('click',runRescueAction);
byId('verified-demo').addEventListener('click',()=>{loadDemo();showGuidedPhase('nominal');enterSurface();});
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
    applicationRelease=await fetch('./release.json').then(r=>r.ok?r.json():applicationRelease).catch(()=>applicationRelease);
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
    loadDemo(true,true);
    initializeExperience();
    void fetch('./data/rendering-notes.json').then(r=>r.ok?r.json():null).then(notes=>{
      if(notes?.bundlePayloadSha256!==bundle.manifest?.bundleSha256)return;
      renderingNotes=notes;updateSiteDetail();
      if(chart?.samples.length)updateProbe();
    }).catch(()=>{});
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
    setExpert(true);
    byId('scene-status').textContent=`Mission evidence unavailable: ${error.message}. Reload the page or use the checked offline release.`;
    byId('workspace-notice').hidden=false;
    byId('workspace-notice').textContent=byId('scene-status').textContent;
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
  if(siteCaution(row.siteId))card.append(element('p','comparison-caution',siteCaution(row.siteId)));
  const explore=element('button','outline','Explore this site ↗');explore.type='button';explore.addEventListener('click',()=>{selectVisualSite(row.siteId);setProductMode('explore');});card.append(explore);
  const details=element('details','comparison-details');details.append(element('summary','','All visibility durations and numerical bounds'));
  for(const [key,label] of [['nominal','Original arrival'],['delayed','Delayed arrival']]) {
   const mission=row[key]; const line=element('p','comparison-arrival'); line.append(`${label} · ${shortTime(mission.start)} `,statusChip(mission.status));card.append(line);
   const narrative=missionStory({[key]:mission},key);
   card.append(element('p','comparison-reason',mission.status==='PASS'?'The active visibility rules are proven within the bounds shown below.':narrative.message));
   const joint=visibilitySummary(mission.timeline.joint,mission.start,mission.end).seconds;
   card.append(element('p','comparison-joint',`${hours(joint.visible/3600)} confirmed with Sun + Earth`));
   const rules=element('div','compact-requirements');renderRequirementCards(rules,mission,true);card.append(rules);
   details.append(element('h4','',label));
   for(const [channel,title] of timelineChannels) {
    const m=visibilitySummary(mission.timeline[channel],mission.start,mission.end).seconds;
    const line=element('p','comparison-metric',`${title}: ${hours(m.visible/3600)} confirmed; ${hours((m.uncertain+m.unknown)/3600)} unresolved`);
    line.dataset.phase=key;line.dataset.channel=channel;line.dataset.visibleSeconds=m.visible;details.append(line);
   }
   const bounded=missionMetrics(mission,findSite(row.siteId));
   for(const [channel,metric,title] of [['sun','longestBlockedRangeSeconds','Longest sunlight-unqualified'],['earth','longestBlockedRangeSeconds','Longest Earth blockage'],['joint','longestVisibleRangeSeconds','Longest joint opportunity']]) {
    const range=bounded[channel][metric],line=element('p','comparison-metric',`${title}: ${durationRange(range)}`);
    line.dataset.phase=key;line.dataset.metric=`${channel}-${metric}`;line.dataset.lower=range[0];line.dataset.upper=range[1];details.append(line);
   }
   details.append(element('p','telemetry-note',`Numerical refinement: ${bounded.refinementStatus}. Agreement of sampled grids is not total physical accuracy. Ranges enclose retained/coarse/fine models, not statistical confidence.`));
  }
  card.append(details);
  root.append(card);
 }
 renderOptionComparison();
}

function optionDecisionText(mission){
  if(mission.startAllowed===false)return 'Outside the allowed start schedule. Inspect environmental rules separately; this is not a lunar-condition verdict.';
  const rule=mission.constraints.find(c=>c.status==='FAIL')??mission.constraints.find(c=>c.status==='INDETERMINATE')??mission.constraints.slice().sort((a,b)=>a.margin-b.margin)[0];
  if(!rule)return 'No supported requirement evidence is available.';
  const v=constraintEvidence(rule);
  return `${mission.status==='PASS'?'Closest passing limit':rule.status==='FAIL'?'Broken rule':'Unresolved rule'}: ${v.title.toLowerCase()} ${v.metricText}; required ${v.requirementText}. Signed margin ${v.marginText}.`;
}

function renderOptionComparison(focus){
  if(!inputs)return;
  byId('compare-workspace-title').textContent=requirementsEnabled?'Which arrival works for this mission?':'How do these lunar arrivals differ?';
  document.querySelector('#compare-workspace .eyebrow').textContent=requirementsEnabled?'Same requirements · independent arrivals':'Measured conditions · independent arrivals';
  byId('compare-input-summary').textContent=requirementsEnabled?`Independent sites and UTC arrivals · one shared ${inputs.durationHours} h mission. Requirements and allowed start bounds stay the same for every option.`:`Compare Sun, Earth and joint visibility over the same ${inputs.durationHours} h interval. No mission requirements applied.`;
  comparisonOptions??=[{key:'A',siteId:inputs.siteId,start:inputs.nominal},{key:'B',siteId:requirementsEnabled?inputs.siteId:(bundle.sites.find(s=>s.id!==inputs.siteId)??bundle.sites[0]).id,start:inputs.nominal+(requirementsEnabled?inputs.delayHours*3600:0)}];
  const root=byId('option-comparison');root.replaceChildren();root.dataset.count=comparisonOptions.length;
  if(isEdited){root.append(element('p','notice','Shared settings have unevaluated changes. Evaluate them in Advanced before comparing options.'));byId('comparison-difference').textContent='No updated comparison is established.';return;}
  byId('comparison-duration').value=inputs.durationHours;
  const reference=evaluateStart(bundle,requirementsEnabled?inputs:environmentInputs(inputs),inputs.siteId,inputs.nominal);
  const shortRuleNames={max_sun_block:'Sun gap',max_earth_block:'Earth gap',min_joint_total:'Together',min_joint_continuous:'Uninterrupted'};
  byId('comparison-shared-limits').textContent=requirementsEnabled?`${requirementsSource==='custom'?'Your selected requirements':'Illustrative, not lander specifications'}: ${reference.constraints.map(c=>`${shortRuleNames[c.id]??c.id} ${constraintEvidence(c).requirementText}`).join(' · ')}.`:'Environmental measurements only. Enable requirements in Mission, or evaluate your own limits in Advanced, for a mission verdict.';
  const evaluations=[];
  for(const option of comparisonOptions){
    const card=element('article','option-card');card.dataset.option=option.key;
    card.append(element('h2','',`Option ${option.key}`));
    const siteLabel=element('label','',`Landing study point`),siteSelect=element('select');siteSelect.id=`comparison-site-${option.key}`;
    for(const site of bundle.sites){const entry=element('option','',site.name);entry.value=site.id;siteSelect.append(entry);}siteSelect.value=option.siteId;
    siteSelect.addEventListener('change',()=>{option.siteId=siteSelect.value;renderOptionComparison({key:option.key,field:'site'});});siteLabel.htmlFor=siteSelect.id;siteLabel.append(siteSelect);
    const dateLabel=element('label','','Arrival · UTC'),date=element('input');date.type='datetime-local';date.step='1';date.id=`comparison-arrival-${option.key}`;date.value=Number.isFinite(option.start)?inputTime(option.start):'';
    date.addEventListener('change',()=>{option.start=Date.parse(`${date.value}Z`)/1000;renderOptionComparison({key:option.key,field:'arrival'});});dateLabel.htmlFor=date.id;dateLabel.append(date);
    const selectors=element('div','option-selectors');selectors.append(siteLabel,dateLabel);card.append(selectors);
    let mission;
    try{if(!Number.isFinite(option.start))throw Error('Choose a valid UTC arrival.');mission=evaluateStart(bundle,requirementsEnabled?inputs:environmentInputs(inputs),option.siteId,option.start);}
    catch(error){card.append(element('p','notice',`${error.message} No result is claimed.`));root.append(card);continue;}
    evaluations.push({key:option.key,mission});Object.assign(card.dataset,{site:option.siteId,start:option.start,end:mission.end,status:mission.status,cause:mission.startAllowed===false?'schedule':'environment'});
    const status=element('p','option-status');if(requirementsEnabled)status.append(statusChip(mission.status));else {card.dataset.status='ENVIRONMENT';status.append(element('span','measurement-label','Visibility measurements'));}card.append(status);
    if(mission.startAllowed===false)card.append(element('p','schedule-exclusion','Outside allowed schedule — environmental results are separate.'));
    if(siteCaution(option.siteId))card.append(element('p','comparison-caution',siteCaution(option.siteId)));
    const bounded=missionMetrics(mission,findSite(option.siteId));
    const joint=requirementsEnabled?mission.constraints.find(c=>c.id==='min_joint_total'):null;
    const jointSeconds=joint?joint.range[0]*3600:bounded.joint.visibleRangeSeconds[0];
    card.append(element('p','option-joint',`${durationClock(jointSeconds)} confirmed Sun + Earth`));
    if(!requirementsEnabled){
      card.append(element('p','option-outage',`Sun-center visibility: ${durationRange(bounded.sun.visibleRangeSeconds)}. Earth-center visibility: ${durationRange(bounded.earth.visibleRangeSeconds)}.`));
      card.append(element('p','option-outage',`Longest Sun unavailability: ${durationRange(bounded.sun.longestBlockedRangeSeconds)}. Earth obstruction: ${durationRange(bounded.earth.longestBlockedRangeSeconds)}.`));
      card.append(element('p','option-reason',`Continuous Sun + Earth overlap: ${durationRange(bounded.joint.longestVisibleRangeSeconds)}. Bounds retain unresolved time; geometry does not establish power or radio performance.`));
    }
    if(requirementsEnabled)for(const [id,label]of [['max_sun_block','Longest Sun unavailability'],['max_earth_block','Longest Earth obstruction']]){
      const rule=mission.constraints.find(c=>c.id===id),view=constraintEvidence(rule);
      card.append(element('p','option-outage',`${label}: ${rule.range[0]===rule.range[1]?evidenceTime(rule.metric):view.rangeText}${rule.status==='INDETERMINATE'?' · unresolved':''}.`));
    }
    if(requirementsEnabled)card.append(element('p','option-reason',optionDecisionText(mission)));
    const viewButton=element('button','primary','View this option →');viewButton.id=`comparison-view-${option.key}`;viewButton.type='button';viewButton.disabled=isEdited;
    viewButton.addEventListener('click',()=>{
      if(isEdited){byId('comparison-difference').textContent='Evaluate pending shared settings in Advanced before loading an option.';return;}
      byId('site').value=option.siteId;byId('nominal').value=inputTime(option.start);selected='nominal';updateSiteDetail();
      if(evaluate()){showGuidedPhase('nominal');setProductMode('explore');byId('workspace-notice').hidden=false;byId('workspace-notice').textContent=`Option ${option.key} is now the original planned arrival. Delay/recovery and exports use this new plan.`;}
    });
    card.append(viewButton,element('p','option-load-note','Use as the new Mission arrival.'));
    if(requirementsEnabled){const rules=element('div','compact-requirements');renderRequirementCards(rules,mission,true);
      const ruleDetails=element('details','option-rules');ruleDetails.append(element('summary','',`${mission.constraints.length} requirement results`),rules);card.append(ruleDetails);}root.append(card);
  }
  byId('add-comparison-option').hidden=comparisonOptions.length===3;byId('remove-comparison-option').hidden=comparisonOptions.length!==3;
  const pass=evaluations.filter(({mission})=>mission.status==='PASS'),uncertain=evaluations.filter(({mission})=>mission.status==='INDETERMINATE'),excluded=evaluations.filter(({mission})=>mission.startAllowed===false);
  let difference;
  if(!requirementsEnabled)difference=`Confirmed simultaneous time: ${evaluations.map(({key,mission})=>`Option ${key} ${durationRange(missionMetrics(mission,findSite(mission.siteId)).joint.visibleRangeSeconds)}`).join(' · ')}. Larger lower bounds establish more confirmed overlap in these views, not a safer landing. No mission requirements applied.`;
  else if(evaluations.length!==comparisonOptions.length)difference='Complete a supported site and valid arrival for each option before comparing them.';
  else if(excluded.length===evaluations.length)difference='No option fits the allowed start schedule. That is a scheduling exclusion, not proof of unfavorable lunar conditions.';
  else if(!pass.length)difference=`${evaluations.length===2?'Neither option passes.':'No option passes.'} ${uncertain.length?'Uncertainty prevents a confirmed passing comparison.':'The selected rules or start schedule reject these options.'} Read each option’s specific rule and margin above.`;
  else{
    const failed=evaluations.filter(({mission})=>mission.status==='FAIL'&&mission.startAllowed!==false);
    difference=`${pass.map(x=>`Option ${x.key}`).join(' and ')} ${pass.length>1?'pass':'passes'} the same requirements. ${failed.map(({key,mission})=>{const c=mission.constraints.find(c=>c.status==='FAIL');if(!c)return `Option ${key} fails a mission-level check.`;const v=constraintEvidence(c);return `Option ${key} breaks ${v.title.toLowerCase()}: ${v.metricText}, required ${v.requirementText}.`;}).join(' ')}${uncertain.length?` ${uncertain.map(x=>`Option ${x.key}`).join(' and ')} remains unresolved; that is not a proven environmental failure.`:''}${excluded.length?` ${excluded.map(x=>`Option ${x.key}`).join(' and ')} is outside the allowed schedule.`:''} ${pass.length>1?evaluations.map(({key,mission})=>{const c=mission.constraints.find(c=>c.id==='min_joint_total');return c?`${key}: ${evidenceTime(c.range[0])} confirmed joint time.`:'';}).join(' '):''} No general landing-safety ranking is established.`;
  }
  byId('comparison-difference').textContent=difference;
  if(focus)byId(`comparison-${focus.field}-${focus.key}`)?.focus({preventScroll:true});
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
 root.append(element('p','secondary',`Established resolved-state events are measured from the selected mission start, may lie after its end, and stop at missing data or the cache boundary ${formatTime(bundle.coverage[1])}. Earlier uncertain pockets may conceal additional unproved crossings. Brackets retain crossing uncertainty; DEM resolution and refinement limitations still apply.`));
}

function pausePlayback(message) {
  if(!message && playing) message='Paused · inspect cached samples with the time slider or arrow keys.';
  clearTimeout(playbackTimer); playing=false;
  byId('sky-play')?.setAttribute('aria-pressed','false');
  byId('hero-play')?.setAttribute('aria-pressed','false');
  if(message && byId('playback-status')) byId('playback-status').textContent=message;
}

function startPlayback() {
  if(!chart || isEdited || chart.samples.length<2) return;
  pausePlayback();
  const slider=byId('probe-slider');
  if(Number(slider.value)>=chart.samples.length-1) slider.value=0;
  playing=true;byId('sky-play').setAttribute('aria-pressed','true');
  byId('hero-play').setAttribute('aria-pressed','true');
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
  const root=byId('live-telemetry');root.dataset.time=sample[0];
  if(telemetryMission===mission&&root.querySelector('.duration-details')){
    for(const [id,value]of [['sun-elevation',sample[2]],['earth-elevation',sample[5]],['sun-clearance',terrainClearance(sample,'sun')],['earth-clearance',terrainClearance(sample,'earth')]]){
      const card=root.querySelector(`[data-metric='${id}']`);card.dataset.value=precise(value);card.querySelector('.telemetry-value').textContent=Number.isFinite(value)?`${value.toFixed(2)}°`:'Unknown';
    }
    for(const channel of ['sun','earth']){
      const found=refinedEvents(site,channel,sample[0],bundle.coverage);
      for(const key of ['loss','reacquisition']){
        const countdown=transitionCountdown(found,key,sample[0]),item=root.querySelector(`[data-channel='${channel}'][data-event='${key}']`);
        item.dataset.kind=countdown.kind;
        item.textContent=countdown.kind==='bounded'?`${key} in ${durationRange(countdown.remaining)} (numerical enclosure)`:countdown.kind==='unresolved'?`${key}: timing unresolved, ${shortTime(countdown.interval[0])} to ${shortTime(countdown.interval[1])}; countdown withheld`:`${key}: not established before a gap or cache end`;
        if(countdown.interval){item.dataset.start=countdown.interval[0];item.dataset.end=countdown.interval[1];}else{delete item.dataset.start;delete item.dataset.end;}
      }
    }
    return;
  }
  telemetryMission=mission;root.replaceChildren();
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
  matrix=feasibilityMatrix(bundle,requirementsEnabled?inputs:environmentInputs(inputs));
  const scroll=element('div','heatmap-scroll');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','Scrollable daily site feasibility table');
  const table=element('table','feasibility-table'),head=element('thead'),header=element('tr');
  const corner=element('th','','Study point / UTC day');corner.scope='col';header.append(corner);
  for(const start of matrix.starts) {
    const th=element('th','',new Date(start*1000).getUTCDate());th.scope='col';th.title=formatTime(start);header.append(th);
  }
  head.append(header);table.append(head);
  const body=element('tbody');
  const detail=element('div','heatmap-detail');detail.setAttribute('role','status');
  detail.textContent=requirementsEnabled?'Select a cell to inspect its exact start, decision, constraint margins and warnings. Cross-site dates are prelaunch concept comparisons.':'Cells show confirmed Sun + Earth hours at daily sampled starts. Select one for bounded measurements. A visibility calendar is not a mission-safety assessment.';
  for(const row of matrix.rows) {
    const tr=element('tr');const label=element('th','',row.name);label.scope='row';tr.append(label);
    for(const mission of row.cells) {
      const td=element('td');
      const button=element('button',`feasibility-cell status-${mission.status.toLowerCase()}`,{PASS:'P',FAIL:'F',INDETERMINATE:'?'}[mission.status]);
      button.type='button';button.dataset.site=row.siteId;button.dataset.start=mission.start;button.dataset.status=mission.status;
      if(!mission.startAllowed){button.textContent='S';button.className='feasibility-cell schedule-excluded';button.dataset.schedule='excluded';}
      let description=`${row.name}, ${formatTime(mission.start)}, ${mission.status}${!mission.startAllowed?', outside the allowed schedule; inspect environmental results separately':''}`;
      if(!requirementsEnabled){
        const range=missionMetrics(mission,findSite(row.siteId)).joint.visibleRangeSeconds;
        button.className='feasibility-cell visibility-cell';button.dataset.status='ENVIRONMENT';
        button.textContent=range[0]>0?number.format(range[0]/3600):range[1]>0?'?':'0';
        button.style.background=`rgba(92,168,181,${.08+.3*Math.min(1,range[0]/(mission.end-mission.start))})`;
        description=`${row.name}, ${formatTime(mission.start)}, confirmed joint visibility ${durationRange(range)}. No mission requirements applied.`;
        if(mission.startAllowed===false){button.textContent='S';button.className='feasibility-cell schedule-excluded';description+=' Outside allowed schedule.';}
      }
      button.title=description;button.setAttribute('aria-label',description);
      button.addEventListener('click',()=>{
        for(const active of root.querySelectorAll('[aria-pressed]')) active.setAttribute('aria-pressed','false');
        button.setAttribute('aria-pressed','true');detail.replaceChildren();
        const heading=element('p');heading.append(element('strong','',`${row.name} · ${shortTime(mission.start)} `));if(requirementsEnabled)heading.append(statusChip(mission.status));detail.append(heading);
        if(requirementsEnabled)for(const c of mission.constraints) detail.append(element('p','secondary',`${constraintName(c.id)} · ${c.status} · ${hours(c.margin,true)} signed margin · ${durationRange(c.range.map(h=>h*3600))} modeled`));
        else {const metrics=element('div','');environmentalMeasurements(metrics,mission);detail.append(metrics);}
        for(const warning of [...mission.scheduleWarnings,...mission.coverageWarnings])detail.append(element('p','secondary',warning));
        const use=element('button','outline','Use this site and start in concept study');use.type='button';
        use.addEventListener('click',()=>{
          byId('site').value=row.siteId;byId('nominal').value=inputTime(mission.start);updateSiteDetail();evaluate();selectDecision('nominal');
          setProductMode('explore');byId('experience').scrollIntoView({block:'start'});
        });detail.append(use);
      });td.append(button);tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);scroll.append(table);root.append(scroll,detail);
  byId('feasibility-note').textContent=`${matrix.starts.length} dates × ${matrix.rows.length} sites · starts every ${matrix.stepHours} h at ${new Date(inputs.nominal*1000).toISOString().slice(11,19)} UTC · ${inputs.durationHours} h fixed mission. P = PASS, F = FAIL, ? = INDETERMINATE, S = outside allowed schedule (not an environmental verdict). All hard limits and the allowed start range remain unchanged. The last date may be censored by the cache end. ${matrix.basis}`;
  if(!requirementsEnabled)byId('feasibility-note').textContent=`${matrix.starts.length} dates × ${matrix.rows.length} sites · daily starts at ${new Date(inputs.nominal*1000).toISOString().slice(11,19)} UTC · ${inputs.durationHours} h views. Numbers = confirmed Sun + Earth hours; ? = unresolved possible overlap; S = outside your schedule. No mission requirements applied. The last view may cross the cache end.`;
}

function setExpert(enabled) {
  setProductMode(enabled?'analyst':'explore',false);
  byId('expert-toggle').setAttribute('aria-expanded',String(enabled));
  byId('expert-toggle').textContent=enabled?'Close analyst mode':'Analyst mode';
  document.body.classList.toggle('expert-mode',enabled);
}

function setProductMode(mode,scroll=true){
  if(mode!==productMode)++rescueAnimation;
  productMode=mode;
  byId('experience').hidden=mode==='compare'||mode==='analyst';
  byId('compare-workspace').hidden=mode!=='compare';
  byId('landing-opportunities').hidden=mode!=='explore'||!opportunityReport;
  byId('top').hidden=mode!=='analyst';
  byId('experience').dataset.workspace=mode;
  for(const button of document.querySelectorAll('[data-workspace]'))button.setAttribute('aria-pressed',String(button.dataset.workspace===mode));
  if(mode==='analyst'&&result)renderPlot(selectedMission());
  if(mode==='compare'&&inputs)renderOptionComparison();
  if(scroll)scrollTo({top:0,behavior:'instant'});
}

function setExperienceMode(mode) {
  experienceMode=mode;
  byId('experience').dataset.mode=mode;
  for(const key of ['orbital','surface'])byId(`mode-${key}`).setAttribute('aria-pressed',String(key===mode));
  byId('surface-focus').hidden=false;
  byId('focus-terrain').textContent=mode==='surface'?'Explore terrain':'Focus study points';
  byId('scene-transport').hidden=false;
  byId('mission-story').hidden=false;
  byId('scene-mode-label').textContent=mode==='surface'?'NASA LOLA RELIEF · ILLUSTRATIVE GRAIN + LIGHTING':'NASA LRO / ORBITAL EXPLORATION';
  byId('explore-site').textContent=mode==='surface'?'Drag to look around · scroll to zoom':'Explore this surface →';
  if(sceneController&&!sceneDisabled)byId('scene-status').textContent=mode==='orbital'?'Drag to orbit; scroll or pinch to zoom. Scroll outside the scene to move the page. Select a study point to approach the surface.':'Surface view · actual LOLA relief at the recorded observer height. Drag to look; scroll or pinch to zoom. Scroll outside the scene to move the page.';
}

function setSceneStatus(event) {
  byId('scene-status').textContent=event.message??String(event);
  if(event.kind==='ready')byId('experience').dataset.ready='true';
  if(event.kind==='error') {
    sceneDisabled=true;
    byId('experience').dataset.ready='false';
    byId('scene-status').textContent=`3D graphics unavailable. ${event.message??''} The accessible 2D planner remains fully functional.`;
    byId('workspace-notice').hidden=false;byId('workspace-notice').textContent=byId('scene-status').textContent;
    setExpert(true);
  }
}

async function initializeExperience() {
  byId('orbital-story-slot').append(byId('mission-story'));
  byId('experience').insertBefore(byId('decision-evidence'),document.querySelector('.experience-status'));
  byId('comparison-panels').append(byId('feasibility'));
  const audit=element('details','site-audit');audit.append(element('summary','','Three-site original/delayed audit'),byId('compare'));byId('top').append(audit);
  byId('scene-mount').append(byId('scene-poster'));
  byId('scene-mount').append(byId('earth-inset'));
  byId('scene-mount').append(byId('surface-focus'),byId('rescue-transition'));
  document.querySelector('.scene-stage').append(byId('scene-transport'));
  document.querySelector('.story-footer details').append(byId('verified-demo'));
  if(byId('explain'))byId('experience').append(byId('explain'));
  const options=bundle.sites.map(site=>{const option=element('option','',site.name);option.value=site.id;return option;});
  byId('visual-site').replaceChildren(...options);
  byId('visual-site').disabled=false;
  byId('mode-surface').disabled=false;
  byId('explore-site').disabled=false;
  showGuidedPhase('nominal');
  setExperienceMode('orbital');
  sceneLoading=import('./scene3d.mjs').then(module=>module.createMissionScene({container:byId('scene-mount'),bundle,
    onSiteSelect:siteId=>selectVisualSite(siteId),onModeChange:setExperienceMode,onStatus:setSceneStatus}));
  try {
    sceneController=await sceneLoading;
    if(sceneDisabled){sceneController.dispose();return;}
    sceneController.selectSite(visualSiteId??inputs.siteId,{focus:false});
    if(latestSceneFrame)sceneController.setFrame(latestSceneFrame);
    byId('experience').dataset.ready='true';
  } catch(error) {setSceneStatus({kind:'error',message:error.message});}
}

function selectVisualSite(siteId) {
  if(!findSite(siteId)||!result)return;
  pausePlayback();
  byId('site').value=siteId;updateSiteDetail();evaluate();showGuidedPhase('nominal');
  sceneController?.selectSite(siteId);
}

async function enterSurface() {
  if(!result)return;
  pausePlayback();
  if(isEdited){byId('scene-status').textContent='Evaluate the updated inputs in Expert mode before entering the surface scene.';setExpert(true);return;}
  const intent=++sceneIntent;requestedExperienceMode='surface';
  byId('explore-site').disabled=true;
  try {
    if(!sceneController && sceneLoading)sceneController=await sceneLoading;
    if(intent!==sceneIntent||requestedExperienceMode!=='surface'||isEdited)return;
    if(sceneDisabled||!sceneController){setExpert(true);return;}
    await sceneController.selectSite(selectedMission().siteId);
    if(intent!==sceneIntent||isEdited)return;
    await sceneController.setMode('surface');
    if(latestSceneFrame)sceneController.setFrame(latestSceneFrame);
    byId('experience').scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  } catch(error){setSceneStatus({kind:'error',message:error.message});}
  finally{byId('explore-site').disabled=false;}
}

function updateExperienceFrame(site,sample,mission) {
  latestSceneFrame=sceneFrame(site,sample,bundle.coverage);
  if(isEdited)latestSceneFrame.states={sun:'unknown',earth:'unknown'};
  if(visualSiteId!==site.id) {
    visualSiteId=site.id;
    sceneController?.selectSite(site.id);
  }
  byId('visual-site').value=site.id;
  if(document.activeElement!==byId('visual-arrival'))byId('visual-arrival').value=inputTime(inputs.nominal);
  if(document.activeElement!==byId('visual-duration'))byId('visual-duration').value=inputs.durationHours;
  byId('visual-site-detail').textContent=`${Math.abs(site.lat).toFixed(4)}° S · ${site.lon.toFixed(4)}° E · ${site.heightM} m observer${siteCaution(site.id)?` · ${siteCaution(site.id)}`:''}`;
  sceneController?.setFrame(latestSceneFrame);
  byId('earth-inset').hidden=!earthReferenceRequested||latestSceneFrame.states.earth!=='visible';
  byId('scene-clock').textContent=formatTime(sample[0]);
  const slider=byId('hero-time');slider.max=byId('probe-slider').max;slider.value=byId('probe-slider').value;
  slider.disabled=isEdited;
  byId('hero-time-label').parentElement.firstChild.textContent=byId('time-scope').value==='coverage'?'November clock · 30-minute samples ':requirementsEnabled?'Mission clock · 30-minute samples ':'View clock · 30-minute samples ';
  slider.setAttribute('aria-valuetext',formatTime(sample[0]));
  byId('hero-time-label').textContent=formatTime(sample[0]);
  byId('hero-speed').value=byId('sky-speed').value;
  byId('hero-play').disabled=isEdited||!chart||chart.samples.length<2;
  const visibility=byId('hero-visibility');visibility.replaceChildren();
  for(const [key,title] of [['sun','Sun'],['earth','Earth']]) {
    const state=latestSceneFrame.states[key],label=state==='visible'?'visible':state==='blocked'?'hidden by terrain':'unresolved · body hidden';
    const elevation=sample?.[key==='sun'?2:5];
    // Plain-language time to the next established change, from the same bounded events as Advanced.
    const wanted=isEdited?null:state==='visible'?'loss':state==='blocked'?'reacquisition':null;
    let next='';
    if(wanted) {
      const countdown=transitionCountdown(refinedEvents(site,key,sample[0],bundle.coverage),wanted,sample[0]);
      const name=wanted==='loss'?(key==='sun'?'sunset':'Earthset'):(key==='sun'?'sunrise':'Earthrise');
      next=countdown.kind==='bounded'?`${name} in ${durationRange(countdown.remaining)}`
        :countdown.kind==='unresolved'?`${name} timing cannot be resolved (between ${shortTime(countdown.interval[0])} and ${shortTime(countdown.interval[1])})`
          :`no ${name} established in the cached data`;
    }
    const item=element('span','',`${title}${Number.isFinite(elevation)?` ${elevation.toFixed(1)}° elevation`:''} · ${label}${next?` · ${next}`:''}`);
    item.dataset.state=state;item.dataset.target=key;if(wanted)item.dataset.nextEvent=wanted;visibility.append(item);
  }
  for(const key of ['sun','earth']){
    const d=latestSceneFrame.sample,az=d?.[key==='sun'?1:4],el=d?.[key==='sun'?2:5];
    const item=visibility.querySelector(`[data-target='${key}']`);
    if(item&&Number.isFinite(az)&&Number.isFinite(el))item.title=`Bearing ${az.toFixed(1)}° / elevation ${el.toFixed(1)}° above the level horizon. Rise and set mean the body center crossing the terrain skyline. 30-minute cached direction; geometry only.`;
  }
  for(const head of document.querySelectorAll('.story-joint-playhead')){
    const start=Number(head.dataset.start),end=Number(head.dataset.end);head.hidden=sample[0]<start||sample[0]>=end;head.style.left=`${100*(sample[0]-start)/(end-start)}%`;
  }
  // Small read-only evidence on the mount enables UI/data parity verification.
  byId('scene-mount').dataset.time=sample[0];
  byId('scene-mount').dataset.missionStart=mission.start;
}

function invalidateExperience() {
  clearOpportunities();
  ++rescueAnimation;
  cancelSceneEntry();
  pausePlayback();
  byId('hero-play').disabled=true;
  byId('story-status').textContent='STALE';byId('story-status').className='status status-indeterminate';
  byId('story-next').disabled=true;for(const button of document.querySelectorAll('[data-story]'))button.disabled=true;
  if(latestSceneFrame){latestSceneFrame={...latestSceneFrame,states:{sun:'unknown',earth:'unknown'}};sceneController?.setFrame(latestSceneFrame);}
  byId('story-explanation').textContent='Mission inputs changed. Evaluate them in Expert mode to refresh this story.';
  byId('hero-visibility').textContent='Inputs changed · displayed bodies withheld until re-evaluation.';
  if(inputs)renderOptionComparison();
  evidenceMission=null;highlightedConstraintId=null;
  byId('evidence-summary').textContent='Inputs changed. No current mission decision is established until re-evaluation.';
  byId('decision-requirements').replaceChildren();byId('decision-timeline').replaceChildren();
  byId('environment-overview').replaceChildren(element('p','','Inputs changed. Apply a valid arrival to refresh the measurements.'));
  byId('evidence-focus-label').textContent='Previous requirement evidence withheld.';
  byId('evidence-physical-reason').textContent='';byId('recovery-choice').hidden=true;
}

function showGuidedPhase(phase) {
  if(isEdited)return;
  configurationsRequested=phase==='recommended';
  byId('time-scope').value='mission';
  guidedPhase=phase;
  if(result?.[phase])selectDecision(phase);
  else renderMissionStory();
}

function renderMissionStory() {
  if(!result||isEdited)return;
  syncAssessment();
  if(!requirementsEnabled){
    const mission=selectedMission();
    Object.assign(byId('mission-story').dataset,{start:mission.start,site:mission.siteId,status:'ENVIRONMENT'});
    document.querySelector('.experience-intro .eyebrow').textContent=`${inputs.durationHours}-HOUR ENVIRONMENT VIEW`;
    byId('story-date').textContent=`${shortTime(mission.start)} → ${shortTime(mission.end)}`;
    byId('story-title').textContent='Sun and Earth visibility';byId('story-explanation').textContent='';byId('story-status').textContent='';
    if(mission.start<bundle.coverage[0]||mission.end>bundle.coverage[1]){
      byId('story-title').textContent='Outside complete cached coverage';
      byId('story-explanation').textContent='The full view is not covered by the November data. Unknown time is not a prediction of sunlight or contact availability.';
    }
    byId('story-joint').hidden=true;byId('configuration-summary').hidden=true;
    byId('story-requirements').textContent='Sun-center visibility: the Sun’s center clears terrain and Earth’s apparent disc. Earth-center line of sight: a geometric direction to Earth’s center. Both at once: joint visibility. Full-disc illumination, electrical power and radio performance are not established.';
    document.querySelector('.story-footer summary').textContent='Visibility definitions';
    environmentalMeasurements(byId('environment-overview'),mission,{timelines:true});return;
  }
  byId('story-joint').hidden=false;document.querySelector('.story-footer summary').textContent='Illustrative mission requirements';
  byId('story-next').disabled=false;for(const button of document.querySelectorAll('[data-story]'))button.disabled=false;
  const inspectedResult=typeof selected==='number'?{...result,[guidedPhase]:selectedMission()}:result;
  const story=missionStory(inspectedResult,guidedPhase);
  document.querySelector('.experience-intro .eyebrow').textContent=`A ${inputs.durationHours}-HOUR MISSION AT THE LUNAR SOUTH POLE`;
  byId('mission-story').dataset.start=story.start??'';
  byId('mission-story').dataset.site=story.siteId??'';
  byId('mission-story').dataset.status=story.status;
  for(const button of document.querySelectorAll('[data-story]'))button.setAttribute('aria-pressed',String(button.dataset.story===guidedPhase));
  byId('story-title').textContent=story.heading;
  if(!delayStoryEnabled)byId('story-title').textContent='Arrival assessment';
  byId('story-explanation').textContent=story.message;
  const mission=selectedMission();
  if(mission.status==='PASS'){
    const joint=mission.constraints.find(c=>c.id==='min_joint_total');
    if(joint)byId('story-explanation').textContent=`Proven Sun + Earth: ${constraintEvidence(joint).metricText}. All ${mission.constraints.length} rules are proven below.`;
  }
  if(mission.start<bundle.coverage[0]||mission.end>bundle.coverage[1])byId('story-explanation').textContent='The full mission extends outside the November cache. Complete visibility is not known; choose a covered arrival or duration.';
  else if(mission.startAllowed===false)byId('story-explanation').textContent='This arrival is outside your allowed start schedule. Scheduling exclusion is separate from the environmental results below.';
  byId('story-date').textContent=story.start!==undefined?`${shortTime(story.start)} · ${inputs.durationHours} h mission`:'No confirmed start inside the search range';
  const status=byId('story-status');status.textContent=story.status;status.className=`status status-${{PASS:'pass',FAIL:'fail',INDETERMINATE:'indeterminate'}[story.status]??'unavailable'}`;
  if(guidedPhase==='recommended'&&!result.recommended){
    const noData=result.search.from>bundle.coverage[1]-inputs.durationHours*3600||result.search.to<bundle.coverage[0];
    const empty=result.search.candidateCount===0;
    status.textContent=noData?'NO DATA':empty?'NO ELIGIBLE START':result.counts.INDETERMINATE?'UNRESOLVED':'NO PASS ON GRID';
    byId('story-title').textContent='No confirmed recovery';
    byId('story-explanation').textContent=noData?'The delayed arrival or recovery range falls outside complete cached coverage. Choose supported dates; no recovery verdict can be established.'
      :empty?'Your allowed schedule contains no eligible start after the delay. Edit the allowed dates; this is not an environmental failure.'
        :result.counts.INDETERMINATE?`${result.counts.INDETERMINATE} starts remain unresolved; ${result.counts.FAIL} failed the selected limits. No passing recovery is proven on this grid.`
          :`All ${result.counts.FAIL} checked options fail the selected limits. Change the allowed dates or requirements; no passing start was manufactured.`;
  }
  byId('story-witness').textContent=story.witness?`From ${shortTime(story.witness[0])} to ${shortTime(story.witness[1])}.` : '';
  byId('story-next').textContent=guidedPhase==='nominal'?`Simulate ${inputs.delayHours}-hour delay`:guidedPhase==='delayed'?'Find next confirmed window':'Replay planned landing';
  if(!delayStoryEnabled)byId('story-next').textContent=`Simulate ${inputs.delayHours}-hour delay (optional)`;
  byId('story-requirements').textContent=`${inputs.durationHours} h mission. At most ${inputs.maxSunHours} h without qualified sunlight and ${inputs.maxEarthHours} h with Earth hidden.${inputs.minJointHours!==null?` At least ${inputs.minJointHours} h with both visible.`:''}${inputs.minContinuousJointHours!==null?` Including one uninterrupted ${inputs.minContinuousJointHours} h window.`:''} These geometric requirements do not establish electrical power, a radio link or landing safety.`;
  renderStoryJoint(story);
  renderDecisionEvidence(mission);
  void renderConfigurations();
}

function renderRequirementCards(root,mission,compact=false){
  root.replaceChildren();
  for(const item of mission.constraints){
    const view=constraintEvidence(item),card=element('div','requirement-card');card.setAttribute('role','group');
    Object.assign(card.dataset,{constraint:item.id,status:item.status,threshold:item.threshold,metric:item.metric,margin:item.margin,
      range:JSON.stringify(item.range??null),marginRange:JSON.stringify(item.marginRange??null)});
    const heading=element(compact?'strong':'button','requirement-name',view.title);
    if(!compact){heading.type='button';heading.setAttribute('aria-controls','decision-timeline');heading.addEventListener('click',()=>{highlightedConstraintId=item.id;renderDecisionEvidence(mission);});}
    const head=element('div','requirement-head');head.append(heading,statusChip(item.status));card.append(head);
    const values=element('div',compact?'compact-requirement-values':'requirement-values');
    for(const [label,value]of [['Limit',view.requirementText],['Result',view.metricText],['Margin',view.marginText]]){
      const pair=element('div');pair.append(element('span','',label),element('strong','',value));values.append(pair);
    }
    card.append(values);
    if(item.status==='INDETERMINATE')card.append(element('p','requirement-range',`Unresolved result: ${view.rangeText}. Margin: ${view.marginRangeText}.`));
    if(!compact)card.title=`${view.explanation} Supported result ${view.rangeText}; margin ${view.marginRangeText}. ${item.metricBasis??'Model result'}. ${item.uncertainty??''}`;
    card.dataset.selected=String(!compact&&highlightedConstraintId===item.id);
    root.append(card);
  }
}

function renderDecisionEvidence(mission){
  if(!requirementsEnabled){byId('decision-evidence').hidden=true;return;}
  const root=byId('decision-evidence');root.dataset.start=mission.start;root.dataset.site=mission.siteId;
  if(evidenceMission!==mission){evidenceMission=mission;highlightedConstraintId=mission.constraints.find(c=>c.status==='FAIL')?.id??null;}
  byId('evidence-plan').textContent=`${findSite(mission.siteId)?.name??mission.siteId} · ${shortTime(mission.start)} → ${shortTime(mission.end)}`;
  const warnings=[...(mission.scheduleWarnings??[]),...(mission.coverageWarnings??[])];
  byId('evidence-summary').textContent=`${mission.status}. ${mission.status==='PASS'?'All active visibility requirements are proven within the supported bounds.':mission.status==='FAIL'?(mission.constraints.some(c=>c.status==='FAIL')?'A proven failed rule rejects this arrival; each other rule retains its own status.':'The start is excluded by the allowed mission schedule; this is not an unfavorable-environment verdict.'):'No overall mission pass is proven; uncertainty or coverage still prevents a decision.'}`;
  byId('evidence-schedule').hidden=mission.startAllowed!==false;
  byId('evidence-schedule').textContent='Outside allowed schedule. The four environmental requirements are evaluated independently below.';
  byId('evidence-refinement').textContent=`Numerical refinement: ${mission.refinement?.status??'not established'}. This describes grid agreement, not physical model accuracy; unresolved intervals remain unresolved.`;
  const notes=byId('evidence-warnings');notes.hidden=!warnings.length;notes.querySelector('div').replaceChildren(...warnings.map(w=>element('p','',w)));
  renderRequirementCards(byId('decision-requirements'),mission);
  const selectedRule=mission.constraints.find(c=>c.id===highlightedConstraintId),view=selectedRule?constraintEvidence(selectedRule):null;
  const segments=constraintSegments(selectedRule),timeline=byId('decision-timeline');timeline.replaceChildren();
  for(const [channel,title]of timelineChannels){
    const row=element('div','evidence-timeline-row'),track=element('div','evidence-timeline-track');track.dataset.channel=channel;
    if(view?.channel===channel)track.dataset.selected='true';
    for(const [a,b,state]of mission.timeline[channel]){
      const span=element('span',`timeline-piece timeline-${state}`);span.style.left=`${100*(a-mission.start)/(mission.end-mission.start)}%`;span.style.width=`${100*(b-a)/(mission.end-mission.start)}%`;
      span.title=`${state}: ${formatTime(a)} to ${formatTime(b)}`;track.append(span);
    }
    if(view?.channel===channel)for(const [a,b]of segments){
      const left=Math.max(mission.start,a),right=Math.min(mission.end,b);if(left>=right)continue;
      const span=element('span','constraint-highlight');Object.assign(span.dataset,{channel,start:left,end:right,status:selectedRule.status});
      span.style.left=`${100*(left-mission.start)/(mission.end-mission.start)}%`;span.style.width=`${100*(right-left)/(mission.end-mission.start)}%`;track.append(span);
    }
    const head=element('span','timeline-playhead story-joint-playhead');head.dataset.start=mission.start;head.dataset.end=mission.end;
    const time=currentTime??mission.start;head.hidden=time<mission.start||time>=mission.end;head.style.left=`${100*(time-mission.start)/(mission.end-mission.start)}%`;track.append(head);
    row.append(element('span','',title),track);timeline.append(row);
  }
  timeline.append(element('p','evidence-time-label',`${shortTime(mission.start)} → ${shortTime(mission.end)} · green = qualified, gray = unqualified, amber = unresolved`));
  byId('evidence-focus-label').textContent=selectedRule?`${view.title}: ${selectedRule.status==='INDETERMINATE'?'possible span only; unresolved, not a confirmed outage. ':selectedRule.id.startsWith('max_')?(selectedRule.status==='FAIL'?'Proven violating span. ':'Possible outage bound, not a confirmed shadow. '):'Qualifying-window evidence. '}${segments.length?segments.map(([a,b])=>`${shortTime(a)} to ${shortTime(b)}`).join('; '):'No qualifying interval is established for this rule; no interval has been invented.'}`:'Select a requirement to highlight its evidence. All channels use the same mission and UTC clock.';
  byId('evidence-physical-reason').textContent=view?.reason??'Sun and Earth visibility change as their directions move relative to the selected site’s terrain horizon.';
  const choice=byId('recovery-choice');choice.hidden=guidedPhase!=='recommended'||typeof selected==='number'||mission!==result.recommended;
  if(!choice.hidden){
    let counts=prefixCountCache.get(result);
    if(!counts){counts={FAIL:0,INDETERMINATE:0,PASS:0};for(let t=result.search.from;t<mission.start;t+=inputs.gridMinutes*60)for(const id of result.search.sites)counts[evaluateStart(bundle,inputs,id,t).status]++;prefixCountCache.set(result,counts);}
    const wait=(mission.start-result.delayed.start)/3600;
    choice.textContent=`Why this date: first confirmed start on the ${inputs.gridMinutes}-minute grid${inputs.gridMinutes===60?' (hourly)':''}. Wait ${Math.floor(wait/24)} d ${number.format(wait%24)} h after the delayed arrival. Earlier sampled site/starts: ${counts.FAIL} FAIL, ${counts.INDETERMINATE} INDETERMINATE, ${counts.PASS} PASS. Uncertain earlier starts do not prove an earlier window is impossible. The mission requirements were not relaxed.`;
  }
}

function cancelSceneEntry(){++sceneIntent;requestedExperienceMode=experienceMode;if(experienceMode==='orbital')sceneController?.setMode('orbital');}
async function runRescueAction(){
  if(isEdited||!result)return;
  delayStoryEnabled=true;syncAssessment();
  clearOpportunities();
  const target=guidedPhase==='nominal'?'delayed':guidedPhase==='delayed'?'recommended':'nominal';
  if(target==='nominal'||!result[target]){showGuidedPhase(target);return;}
  const animation=++rescueAnimation,requestedInputs=inputs,from=currentTime??selectedMission().start,to=result[target].start;
  byId('story-next').disabled=true;byId('rescue-transition').hidden=false;
  byId('rescue-transition').textContent=target==='delayed'?`Advancing the landing clock by ${inputs.delayHours} hours…`:'Moving to the next confirmed mission window…';
  try{
    await enterSurface();
    for(let attempt=0;attempt<100&&sceneController?.inspect().mode!=='surface';attempt++)await new Promise(r=>setTimeout(r,20));
    if(animation!==rescueAnimation||requestedInputs!==inputs||isEdited)return;
    if(sceneController&&sceneController.inspect().mode==='surface'&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
      byId('time-scope').value='coverage';renderPlot(selectedMission());
      const start=nearestSample(chart.samples,from,chart.domain)??0,end=nearestSample(chart.samples,to,chart.domain);
      if(end!==null)for(let step=0;step<=48;step++){
        if(animation!==rescueAnimation||requestedInputs!==inputs||isEdited)return;
        byId('probe-slider').value=Math.round(start+(end-start)*step/48);updateProbe();
        byId('rescue-transition').textContent=`${target==='delayed'?`${inputs.delayHours}-hour landing delay`:'Checking later arrivals'} · ${formatTime(currentTime)}`;
        await new Promise(r=>setTimeout(r,45));
      }
    }
    if(animation===rescueAnimation&&requestedInputs===inputs&&!isEdited){showGuidedPhase(target);sceneController?.focus(target==='delayed'?'sun':'earth');}
  }catch(error){byId('scene-status').textContent=`The guided scene could not animate: ${error.message}. The evaluated mission remains available.`;}
  finally{byId('rescue-transition').hidden=true;if(!isEdited)byId('story-next').disabled=false;}
}
function durationClock(seconds){const s=Math.round(seconds);return `${Math.floor(s/3600)} h ${String(Math.floor(s%3600/60)).padStart(2,'0')} min ${String(s%60).padStart(2,'0')} s`;}
function renderStoryJoint(story){
  const mission=typeof selected==='number'?selectedMission():result[guidedPhase];
  const root=byId('story-joint');root.replaceChildren();if(!mission)return;
  const summary=visibilitySummary(mission.timeline.joint,mission.start,mission.end).seconds;
  root.append(element('p','joint-duration',`${durationClock(summary.visible)} with Sun + Earth`));
  const track=element('div','story-joint-track');track.setAttribute('aria-label','Joint sunlight and Earth-center visibility intervals');
  for(const [a,b,state]of mission.timeline.joint){const segment=element('span',`timeline-piece timeline-${state}`);segment.style.left=`${100*(a-mission.start)/(mission.end-mission.start)}%`;segment.style.width=`${100*(b-a)/(mission.end-mission.start)}%`;segment.title=`${state}: ${formatTime(a)} to ${formatTime(b)}`;track.append(segment);}
  const playhead=element('span','timeline-playhead story-joint-playhead');playhead.dataset.start=mission.start;playhead.dataset.end=mission.end;track.append(playhead);root.append(track);
  if(guidedPhase==='recommended'&&result.recommended){
    const wait=(result.recommended.start-result.delayed.start)/3600;
    root.append(element('p','recovery-wait',`Wait after delay: ${Math.floor(wait/24)} d ${number.format(wait%24)} h.`));
  }
  const detail=element('details');detail.append(element('summary','','Visibility uncertainty'),element('p','',`${durationClock(summary.uncertain+summary.unknown)} unresolved. This is center visibility, not generated power or a working radio link.`));root.append(detail);
}

async function renderConfigurations(){
  const request=++configurationRequest,container=byId('configuration-summary');
  configurationReport=null;container.hidden=!requirementsEnabled||!result.recommended||guidedPhase!=='recommended'||!configurationsRequested;
  if(container.hidden)return;
  const mission=selectedMission(),requestedInputs=inputs;
  if(mission.siteId!=='de-gerlache-rim'){container.textContent='Extra height, position and terrain checks are available only at de Gerlache Rim 1.';return;}
  container.textContent='Checking changes in observer height, position and terrain…';
  try{
    const [module,height,position,terrain]=await Promise.all([import('./configurations.mjs'),...['height','position','terrain'].map(name=>fetch(`./data/${name}-study.json`).then(r=>{if(!r.ok)throw Error('Scenario data unavailable');return r.json();}))]);
    const report=await module.evaluateConfigurations(bundle,{height,position,terrain},requestedInputs,mission);
    if(request!==configurationRequest||requestedInputs!==inputs||mission!==selectedMission()||isEdited)return;
    configurationReport={inputs:requestedInputs,mission,report};
    container.replaceChildren(element('strong','',`${report.pass_count} of ${report.total} tested variations meet the limits.`));
    const list=element('details');list.append(element('summary','','What was tested?'),element('p','','One baseline, two observer heights, two position offsets and two terrain surfaces. Each change was tested separately, not in combination. This is no guarantee for other conditions.'));
    for(const item of report.cases){const p=element('p','',`${item.label??item.id}: ${item.status}`);if(item.source){const a=element('a','',' · source');a.href=typeof item.source==='string'?item.source:item.source.url??'#';p.append(a);}list.append(p);}container.append(list);
  }catch(error){if(request===configurationRequest)container.textContent=`Configuration assessment unavailable: ${error.message}. No all-configuration pass is claimed.`;}
}

// Read-only snapshot for reproducible renderer/data parity tests.
export function inspectExperience() {return sceneController?.inspect()??null;}
