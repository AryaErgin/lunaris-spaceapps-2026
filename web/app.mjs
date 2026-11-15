import { compareSites, communicationDemo, visibilitySummary, refinedEvents } from './overview.mjs';
import { makeCertificate, runMission, evaluateStart } from './engine.mjs';
import { feasibilityMatrix, missionMetrics } from './operations.mjs';
import { playbackSamples, nearestSample, transitionCountdown, terrainClearance } from './playback.mjs';
import { renderHorizon } from './horizon.mjs';
import { createAtlas } from './atlas.mjs';
import { sceneFrame, missionStory } from './scene-model.mjs';
import {constraintEvidence,constraintSegments,evidenceTime} from './decision-evidence.mjs';
import {resolveAutomaticSchedule,findLandingOpportunities,findVisibilityOpportunities,makeEnvironmentRecord,environmentInputs} from './opportunities.mjs';
import {visibilityConclusion,comparisonConclusion,opportunityConclusion,conciseDuration,firstScreenConclusion} from './explanations.mjs';
import {coverageLabel,coverageTicks,utcMonthWindow,searchQualification,isCachedTime} from './coverage.mjs';
import {automaticSearchOptions} from './search-scope.mjs';
import {opportunityRange,opportunityPage,opportunityRequestInputs} from './opportunity-view.mjs';
import {createLandingAssessmentCache} from './landing-assessment.mjs';

import {NOTABLE_SITES,referenceDirections,skyAt,elevationSeries,nextLevelCrossing,levelSummary,validCoordinate} from './anysite.mjs';

const byId = (id) => document.getElementById(id);
const form = byId('mission-form');
const exportButton = byId('export');
const decisionList = byId('decision-list');
const number = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const dateOnly = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
});
const compactTime = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
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
let landingAssessment;
let inputs;
let result;
let selected = 'nominal';
let target = 'sun';
let chart;
let lastPlotWidth;
let isEdited = false;
let atlas;
let matrix;
let calendarMonth=null,calendarArrival=null;
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
let opportunityRows=[];
let opportunityPageIndex=0;
const opportunitySmallScreen=matchMedia('(max-width:740px)');
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
  document.body.dataset.delayStory=String(delayStoryEnabled);
  const actions=byId('mission-actions');
  // Mission actions have a stable place in the scene, independent of assessment mode.
  document.body.classList.toggle('environment-only',!requirementsEnabled);
  byId('apply-requirements').checked=requirementsEnabled;
  byId('assessment-label').textContent=requirementsSource==='custom'?'Evaluate my mission requirements':'Evaluate illustrative mission requirements';
  document.querySelector('.illustrative-requirements').textContent=requirementsSource==='custom'?'User-defined requirements; no flight or hardware certification implied.':'Illustrative mission requirements — not real lander specifications.';
  byId('opportunity-scope').textContent=requirementsEnabled?`Before launch · ${bundle?.sites?.length??'supported'} study points · unchanged selected limits`:'Compare confirmed Sun + Earth time · no mission limits applied';
  byId('decision-evidence').hidden=!requirementsEnabled;
  byId('environment-overview').hidden=requirementsEnabled;
  byId('story-uncertainty').hidden=!requirementsEnabled;
  document.querySelector('.story-progress').hidden=!requirementsEnabled||!delayStoryEnabled;
  byId('story-status').hidden=!requirementsEnabled;byId('story-next').hidden=!requirementsEnabled;byId('story-witness').hidden=!requirementsEnabled;
  const jump=document.querySelector('.decision-jump');jump.href=requirementsEnabled?'#decision-evidence':'#explain';jump.textContent=requirementsEnabled?'See all mission requirements and proof ↓':'How to read these measurements ↓';
  exportButton.textContent=requirementsEnabled?'↓ Decision certificate':'↓ Environment record';
  byId('results-title').textContent=requirementsEnabled?'Mission decisions':'Environmental evidence';
  byId('decision-list').hidden=!requirementsEnabled;
  byId('comparison-edit-limits').textContent=requirementsEnabled?'Edit shared requirements':'Add optional requirements';
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
  const details=element('details','measurement-details');details.append(element('summary','','Visibility durations and bounds'),grid);
  details.append(element('p','environment-note','Bounds retain unresolved time and both numerical refinements. Total overlap can include separate periods; continuous overlap is uninterrupted.'));
  root.append(details);
  if(timelines){
    const lines=element('div','environment-lines');
    for(const [key,title]of [['sun','Sun'],['earth','Earth'],['joint','Both']]){
      const line=element('div','environment-line');line.dataset.channel=key;line.append(element('span','',title));const track=element('div','story-joint-track');
      for(const [a,b,state]of mission.timeline[key]){const bar=element('span',`timeline-piece timeline-${state}`);bar.style.left=`${100*(a-mission.start)/(mission.end-mission.start)}%`;bar.style.width=`${100*(b-a)/(mission.end-mission.start)}%`;bar.title=`${title} ${state}: ${formatTime(a)} to ${formatTime(b)}`;track.append(bar);}
      const head=element('span','timeline-playhead story-joint-playhead');head.dataset.start=mission.start;head.dataset.end=mission.end;track.append(head);line.append(track);lines.append(line);
    }root.append(lines);
    const key=element('p','timeline-key');
    for(const [style,label] of [['','in view'],['unresolved','unresolved'],['hidden','not in view']]){const item=element('span','');item.append(element('i',style),label);key.append(item);}
    root.append(key);
  }
  if(timelines)details.append(element('p','environment-note','Timelines show retained interval labels; duration ranges also enclose both refinements.'));
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
  calendarMonth=demo.nominal;calendarArrival=demo.nominal;
  updateSiteDetail();
  loadingPreset=true;try{evaluate();}finally{loadingPreset=false;}
  sceneController?.selectSite(demo.siteId,{focus:false});
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
  summary.textContent = `${scope} · ${search.gridMinutes ?? inputs.gridMinutes}-minute grid${Number.isFinite(count) ? ` · ${count} evaluated` : ''}${range}. ${searchQualification(search)}`.trim();
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
    renderLandingAssessment(mission.siteId,mission.start);
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
    renderAnySite();
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
    const evaluationInputs=requirementsEnabled?nextInputs:environmentInputs(nextInputs);
    const nextResult = runMission(bundle,evaluationInputs,automaticSearchOptions(bundle,evaluationInputs));
    clearOpportunities();
    cancelSceneEntry();
    isEdited = false;
    inputs = nextInputs;
    result = nextResult;
    // Committed inputs win even when validation left a compact field focused.
    // Playback updates still avoid interrupting a draft until it is applied.
    byId('visual-arrival').value=inputTime(inputs.nominal);
    byId('visual-duration').value=inputs.durationHours;
    for(const key of ['max-sun','max-earth','min-total','min-continuous'])byId(`quick-${key}`).value=byId(key).value;
    byId('quick-requirements-status').textContent='';
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
  ++opportunityRequest;opportunityReport=null;opportunityRows=[];opportunityPageIndex=0;
  byId('landing-opportunities').hidden=true;byId('landing-opportunities').setAttribute('aria-busy','false');
  byId('find-opportunities').disabled=false;byId('find-opportunities').textContent='Find landing opportunities';
  byId('opportunity-search-range').disabled=false;byId('opportunity-pagination').hidden=true;
}

function invalidateOpportunityRange(){
  ++opportunityRequest;opportunityReport=null;opportunityRows=[];opportunityPageIndex=0;
  const root=byId('landing-opportunities');root.dataset.kind='STALE';root.setAttribute('aria-busy','false');delete root.dataset.candidates;
  byId('opportunities-status').textContent='Dates changed. Search to update the opportunities.';
  byId('opportunities-basis').textContent='';byId('opportunities-counts').textContent='The previous results no longer describe these search inputs.';byId('opportunities-ranking').textContent='';
  byId('opportunity-options').replaceChildren();byId('opportunity-other').hidden=true;byId('opportunity-pagination').hidden=true;
  byId('find-opportunities').disabled=false;byId('find-opportunities').textContent='Find landing opportunities';byId('opportunity-search-range').disabled=false;
}

async function searchOpportunities({explicitRange=false}={}){
  if(!explicitRange&&!applyVisualArrival())return;
  const root=byId('landing-opportunities');let range;
  try{
    if(explicitRange){
      if(!inputs||isEdited)throw Error('Apply the current mission inputs before searching. Your arrival has not changed.');
      range=opportunityRange(byId('opportunity-from').value,byId('opportunity-to').value,byId('opportunity-grid').value);
    }
  }catch(error){root.dataset.kind='ERROR';byId('opportunities-status').textContent=`Search not run: ${error.message}`;return;}
  pausePlayback();const sourceInputs=inputs,requestedInputs=explicitRange?opportunityRequestInputs(bundle,inputs,range,explicitSchedule):inputs,request=++opportunityRequest;
  if(!explicitRange){
    const from=Math.max(inputs.nominal,inputs.earliest),to=Math.max(from,Math.min(inputs.latest,bundle.coverage[1]-inputs.durationHours*3600,from+30*86400));
    byId('opportunity-from').value=inputTime(from);byId('opportunity-to').value=inputTime(to);byId('opportunity-grid').value=inputs.gridMinutes;
  }
  root.hidden=productMode!=='explore';root.setAttribute('aria-busy','true');root.dataset.kind='SEARCHING';
  byId('opportunities-eyebrow').textContent=requirementsEnabled?`YOUR REQUIREMENTS · ${bundle.sites.length} STUDY SITES · BEFORE LAUNCH`:`${bundle.sites.length} STUDY SITES · ${coverageLabel(bundle.coverage)}`;
  byId('opportunities-status').textContent=requirementsEnabled?'Checking sites against your selected requirements…':'Finding confirmed Sun and Earth visibility…';
  byId('opportunities-counts').textContent='Search in progress.';byId('opportunities-ranking').textContent='';
  byId('opportunities-basis').textContent='';
  byId('opportunity-options').replaceChildren();byId('opportunity-other').hidden=true;byId('opportunity-pagination').hidden=true;
  byId('opportunity-search-range').disabled=true;
  byId('find-opportunities').disabled=true;byId('find-opportunities').textContent='Checking landing opportunities…';
  try{
    const finder=requirementsEnabled?findLandingOpportunities:findVisibilityOpportunities;
    const report=await finder(bundle,requestedInputs,{...(explicitRange?{searchRange:{from:range.from,to:range.to},collectAll:true}:{searchWindowDays:30}),cancelled:()=>request!==opportunityRequest||inputs!==sourceInputs,
      yieldControl:()=>new Promise(resolve=>setTimeout(resolve,0))});
    if(request!==opportunityRequest||inputs!==sourceInputs)return;
    opportunityReport=report;opportunityPageIndex=0;renderOpportunities(report);
    if(productMode==='explore')root.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  }catch(error){
    if(request!==opportunityRequest||error.name==='AbortError')return;
    root.dataset.kind='ERROR';byId('opportunities-status').textContent=`Search not run: ${error.message}`;
  }finally{
    if(request===opportunityRequest){root.setAttribute('aria-busy','false');byId('find-opportunities').disabled=false;byId('find-opportunities').textContent='Find landing opportunities';byId('opportunity-search-range').disabled=false;}
  }
}

function renderOpportunities(report){
  const root=byId('landing-opportunities');root.hidden=productMode!=='explore';root.dataset.kind=report.kind;
  root.dataset.candidates=report.search.candidateCount;root.dataset.requestedArrival=report.requested.nominal;
  byId('opportunities-counts').textContent=report.search.candidateCount?`${report.search.candidateCount} site/start combinations evaluated. ${Object.entries(report.counts).map(([key,count])=>`${key.replaceAll('_',' ').toLowerCase()}: ${count}`).join(' · ')}.`:'No eligible site/start combination was evaluated.';
  byId('opportunities-ranking').textContent=`${report.search.gridMinutes}-minute sampled starts. ${searchQualification(report.search)}`;
  const rangeLabel=`${report.requested.durationHours} h views · ${report.search.gridMinutes}-minute starts.`;
  if(report.search.candidateCount)byId('opportunities-ranking').textContent+=` Checked UTC: ${formatTime(report.search.firstStart)} to ${formatTime(report.search.lastStart)}.`;
  const siteLabel=`${report.search.sites.length} terrain-aware study points.`;
  const allStarts=Array.isArray(report.allOptions);
  if(allStarts)byId('opportunities-ranking').textContent+=` All confirmed sampled starts are listed, earliest first; neighboring windows may overlap. Availability between starts is not established.`;
  if(!report.requirementsApplied){
    byId('opportunities-title').textContent={VISIBILITY_FOUND:'Explore visibility opportunities',UNRESOLVED:'Joint visibility remains unresolved',NO_JOINT:'No joint visibility established on this grid',NO_DATA:'Outside complete cached coverage',SCHEDULE_EMPTY:'No eligible date in your schedule',GRID_EMPTY:'No sampled start in this range'}[report.kind];
    byId('opportunities-status').textContent=report.kind==='GRID_EMPTY'?'No grid start fits the covered range. Choose a smaller interval between starts or widen the UTC range.':opportunityConclusion(report,id=>findSite(id).name);
    byId('opportunities-basis').textContent=`${rangeLabel} ${siteLabel}`;
    if(allStarts&&report.allOptions.length)byId('opportunities-status').textContent=`${report.allOptions.length} confirmed Sun + Earth opportunities at ${new Set(report.allOptions.map(view=>view.siteId)).size} sites.`;
    opportunityRows=(allStarts?report.allOptions:report.options).map(view=>({view}));
    renderOpportunityPage();
    const other=byId('opportunity-near-misses');other.replaceChildren();
    if(allStarts)for(const view of report.options.filter(view=>view.metrics.joint.visibleRangeSeconds[0]===0&&view.metrics.joint.visibleRangeSeconds[1]>0))other.append(element('p','',`${findSite(view.siteId).name}: no simultaneous Sun and Earth time is confirmed at its best checked start; unresolved terrain visibility may allow more.`));
    byId('opportunity-other').hidden=!other.childElementCount;return;
  }
  const titles={PASS_FOUND:'Passing arrivals found',NO_PASS:'No checked arrival passes',UNRESOLVED:'No passing arrival proven',NO_DATA:'No complete mission in cached data',SCHEDULE_EMPTY:'No eligible start inside your allowed schedule',GRID_EMPTY:'No sampled start in this range'};
  byId('opportunities-title').textContent=titles[report.kind];
  byId('opportunities-status').textContent=report.kind==='PASS_FOUND'
    ?allStarts?`${report.allOptions.length} starts meet your requirements at ${new Set(report.allOptions.map(m=>m.siteId)).size} sites.`:`Confirmed passing arrivals were found at ${report.options.length} ${report.options.length===1?'site':'sites'}, with every selected requirement unchanged.`
    :report.kind==='NO_PASS'?'No checked arrival meets all selected requirements. Near misses below explain which rules fail.'
      :report.kind==='UNRESOLVED'?'No passing arrival is proven. Unresolved intervals prevent ruling out earlier opportunities.'
        :report.kind==='NO_DATA'?'No complete mission fits the available cached data. Choose a covered range or a shorter mission.'
          :report.kind==='GRID_EMPTY'?'No grid start fits the covered range. Choose a smaller interval between starts or widen the UTC range.'
          :'No eligible start fits your allowed schedule. This is a scheduling exclusion, not adverse lunar conditions.';
  byId('opportunities-basis').textContent=`${rangeLabel} ${siteLabel}`;
  const passingIds=new Set(report.options.map(m=>m.siteId));
  opportunityRows=allStarts?report.allOptions.map(mission=>({mission,label:'Confirmed passing start'})):[...report.options.map(mission=>({mission,label:'First confirmed pass at this site'})),
    ...bundle.sites.filter(s=>!passingIds.has(s.id)).map(site=>{
      const uncertain=report.unresolved.find(m=>m.siteId===site.id),near=report.nearMisses.find(r=>r.mission.siteId===site.id);
      return uncertain?{mission:uncertain,label:'Unresolved sampled arrival'}:near?{mission:near.mission,label:'Fewest broken rules at this site'}:null;
    }).filter(Boolean)];
  renderOpportunityPage();
  const other=byId('opportunity-near-misses');other.replaceChildren();
  for(const {mission,failedRules} of report.nearMisses){
    const row=element('p','',`${findSite(mission.siteId).name} · ${shortTime(mission.start)} · ${failedRules.length} broken ${failedRules.length===1?'rule':'rules'}: ${failedRules.map(c=>{const v=constraintEvidence(c);return `${v.title}: ${v.metricText}, required ${v.requirementText}; margin ${v.marginText}`;}).join('; ')}.`);other.append(row);
  }
  for(const mission of report.unresolved)other.append(element('p','',`${findSite(mission.siteId).name} · ${shortTime(mission.start)}: ${optionDecisionText(mission)} No PASS is established.`));
  if(report.nearMisses.length)other.prepend(element('p','secondary','Near misses are ordered by fewer proven broken rules, then earlier UTC. This is not a safety score, and no requirement was relaxed.'));
  byId('opportunity-other').hidden=!other.childElementCount;
}

function renderOpportunityPage({focus=false}={}){
  if(!opportunityReport)return;
  const page=opportunityPage(opportunityRows.length,opportunityPageIndex,opportunitySmallScreen.matches?5:10);opportunityPageIndex=page.index;
  const cards=byId('opportunity-options');cards.replaceChildren();cards.dataset.page=page.index+1;cards.dataset.total=page.total;cards.dataset.pageSize=page.size;
  for(const {view,mission,label} of opportunityRows.slice(page.start,page.end)){
    if(view){
      const card=element('article','opportunity-card');Object.assign(card.dataset,{site:view.siteId,start:view.start,status:'ENVIRONMENT'});
      card.append(element('p','eyebrow',view.metrics.joint.visibleRangeSeconds[0]>0?'Sun + Earth':view.metrics.joint.visibleRangeSeconds[1]>0?'Unresolved overlap':'No joint visibility'),element('h3','',findSite(view.siteId).name),element('p','opportunity-date',shortTime(view.start)));
      const conclusion=visibilityConclusion(view.metrics,view.end-view.start);
      card.append(element('p','opportunity-joint',firstScreenConclusion(view.metrics,view.end-view.start).headline));
      const measurements=element('div','');environmentalMeasurements(measurements,view);const details=measurements.firstElementChild;details.classList.add('opportunity-details');details.querySelector('summary').textContent='See visibility details';
      details.append(element('p','opportunity-rule',conclusion.reason));
      const warning=siteCaution(view.siteId);if(warning)details.append(element('p','comparison-caution',warning));card.append(details);
      const button=element('button','outline','Explore');button.type='button';button.addEventListener('click',()=>{
        byId('site').value=view.siteId;byId('nominal').value=inputTime(view.start);selected='nominal';
        if(evaluate()){showGuidedPhase('nominal');sceneController?.selectSite(view.siteId,{focus:false});byId('experience').scrollIntoView({block:'start',behavior:'instant'});}
      });card.append(button);cards.append(card);continue;
    }
    const card=element('article','opportunity-card');Object.assign(card.dataset,{site:mission.siteId,start:mission.start,status:mission.status});
    card.append(element('p','eyebrow',label),element('h3','',findSite(mission.siteId).name),statusChip(mission.status),element('p','opportunity-date',shortTime(mission.start)));
    const joint=mission.constraints.find(c=>c.id==='min_joint_total');
    if(joint)card.append(element('p','opportunity-joint',`${evidenceTime(joint.range[0])} confirmed Sun + Earth`));
    if(mission.status!=='PASS')card.append(element('p','opportunity-rule',optionDecisionBrief(mission)));
    const measurements=element('div','');environmentalMeasurements(measurements,mission);const details=measurements.firstElementChild;details.classList.add('opportunity-details');details.querySelector('summary').textContent='See requirements and visibility';
    for(const constraint of mission.constraints.filter(c=>['max_sun_block','max_earth_block','min_joint_total','min_joint_continuous'].includes(c.id))){const evidence=constraintEvidence(constraint);details.append(element('p','',`${evidence.title}: ${evidence.metricText}; required ${evidence.requirementText}; margin ${evidence.marginText} · ${constraint.status}.`));}
    const caution=siteCaution(mission.siteId);if(caution)details.append(element('p','comparison-caution',caution));card.append(details);
    const viewButton=element('button','outline','Explore');viewButton.type='button';viewButton.addEventListener('click',()=>{
      byId('site').value=mission.siteId;byId('nominal').value=inputTime(mission.start);selected='nominal';
      if(evaluate()){showGuidedPhase('nominal');sceneController?.selectSite(mission.siteId,{focus:false});byId('experience').scrollIntoView({block:'start',behavior:'instant'});}
    });card.append(viewButton);cards.append(card);
  }
  const pager=byId('opportunity-pagination');pager.hidden=!page.total;
  byId('opportunity-previous').disabled=page.index===0;byId('opportunity-next').disabled=page.index===page.pages-1;
  byId('opportunity-page-status').textContent=`${page.total?page.start+1:0}–${page.end} of ${page.total} · Page ${page.index+1} of ${page.pages}`;
  if(focus){pager.scrollIntoView({block:'nearest',behavior:'instant'});(byId('opportunity-next').disabled?byId('opportunity-previous'):byId('opportunity-next')).focus({preventScroll:true});}
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
    certificate.same_input_site_comparison = compareSites(bundle, requestedInputs,automaticSearchOptions(bundle,requestedInputs));
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
  if(evaluate())revealMissionResult();
});
function revealMissionResult(){
  setProductMode('explore');
  scrollTo({top:0,behavior:'instant'});
  byId('story-status').focus({preventScroll:true});
}
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
byId('comparison-edit-limits').addEventListener('click',()=>{setProductMode('explore');byId('mission-options').open=true;byId('mission-requirements-editor').open=true;byId('quick-max-sun').focus();});
byId('apply-quick-requirements').addEventListener('click',()=>{
  const keys=['max-sun','max-earth','min-total','min-continuous'];
  for(const key of keys){const field=byId(`quick-${key}`);field.required=key.startsWith('max-');if(!field.reportValidity())return;}
  for(const key of keys)byId(key).value=byId(`quick-${key}`).value;
  requirementsEnabled=true;requirementsSource='custom';
  if(evaluate()){
    byId('quick-requirements-status').textContent='Your requirements are applied to Mission, Compare and the next search.';
    revealMissionResult();
  }
});
byId('comparison-duration').addEventListener('change',()=>{
  const hours=Number(byId('comparison-duration').value);
  if(!Number.isFinite(hours)||hours<=0){byId('comparison-duration').value=inputs.durationHours;byId('comparison-difference').textContent='Duration not changed. Choose a positive shared mission duration.';return;}
  byId('duration').value=hours;evaluate();
});
byId('add-comparison-option').addEventListener('click',()=>{if(comparisonOptions?.length===2){comparisonOptions.push({...comparisonOptions[1],key:'C'});renderOptionComparison();}});
byId('remove-comparison-option').addEventListener('click',()=>{comparisonOptions=comparisonOptions?.slice(0,2);renderOptionComparison();});
for(const [id,direction] of [['calendar-previous','previous'],['calendar-next','next']])byId(id).addEventListener('click',()=>{
  if(!bundle||!inputs)return;
  const destination=utcMonthWindow(bundle.coverage,calendarMonth??inputs.nominal)[direction];
  if(destination===null)return;
  calendarMonth=destination;renderFeasibility();
});
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
byId('opportunity-range-form').addEventListener('submit',event=>{event.preventDefault();void searchOpportunities({explicitRange:true});});
for(const id of ['opportunity-from','opportunity-to','opportunity-grid'])byId(id).addEventListener('input',invalidateOpportunityRange);
for(const [id,direction] of [['opportunity-previous',-1],['opportunity-next',1]])byId(id).addEventListener('click',()=>{opportunityPageIndex+=direction;renderOpportunityPage({focus:true});});
opportunitySmallScreen.addEventListener('change',()=>{
  if(!opportunityReport)return;
  const first=opportunityPageIndex*Number(byId('opportunity-options').dataset.pageSize??10);
  opportunityPageIndex=Math.floor(first/(opportunitySmallScreen.matches?5:10));renderOpportunityPage();
});
byId('opportunity-limits').addEventListener('click',()=>{setExpert(true);byId('latest').focus();});
byId('apply-requirements').addEventListener('change',()=>{
  requirementsEnabled=byId('apply-requirements').checked;syncAssessment();clearOpportunities();
  if(!requirementsEnabled)delayStoryEnabled=false;
  if(!requirementsEnabled&&selected!=='nominal'){
    const current=selectedMission();byId('site').value=current.siteId;byId('nominal').value=inputTime(current.start);selected='nominal';guidedPhase='nominal';evaluate();
  }else if(evaluate()&&requirementsEnabled)revealMissionResult();
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
byId('explore-site').addEventListener('click',()=>{pausePlayback();byId('delay-demo-confirm').showModal();});
byId('delay-demo-load').addEventListener('click',()=>{
  byId('delay-demo-confirm').close('load');
  loadDemo();setProductMode('explore');showGuidedPhase('nominal');
  scrollTo({top:0,behavior:'instant'});byId('story-next').focus({preventScroll:true});
});
byId('mode-surface').addEventListener('click',enterSurface);
byId('night-visibility').addEventListener('click',()=>{
  const enabled=byId('night-visibility').getAttribute('aria-pressed')!=='true';
  if(!sceneController||sceneDisabled||!sceneController.setEnhancedNight(enabled))return;
  byId('night-visibility').setAttribute('aria-pressed',String(enabled));
  byId('night-visibility').textContent=enabled?'Night assist: ON':'Night assist';
  updateSceneCaption();
  byId('scene-status').textContent=enabled?'Artificial night fill is on so you can inspect dark terrain. This is not sunlight, Earthshine or a shadow calculation.':'Night assist off. Direct light is withheld unless Sun-center visibility is confirmed. A faint artificial fill preserves the terrain silhouette.';
});
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
// Full-cache playback uses the visible 24 h/s speed; it never changes the evaluated arrival.
let autoMonthSpeed=false;
function setHeroScope(scope){
  if(byId('time-scope').value===scope||isEdited)return;
  if(scope==='coverage'){autoMonthSpeed=true;byId('sky-speed').value='48';}
  byId('time-scope').value=scope;byId('time-scope').dispatchEvent(new Event('change'));
}
byId('hero-scope-stay').addEventListener('click',()=>setHeroScope('mission'));
byId('hero-scope-month').addEventListener('click',()=>setHeroScope('coverage'));
function showOtherSites(){
  setProductMode('explore',false);const panel=byId('any-site');panel.open=true;renderAnySite();
  panel.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  byId('any-site-select').focus({preventScroll:true});
}
byId('more-sites').addEventListener('click',showOtherSites);
byId('compare-more-sites').addEventListener('click',showOtherSites);
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
byId('analysis-tools').addEventListener('toggle',()=>{if(byId('analysis-tools').open&&result)renderPlot(selectedMission());});
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
    landingAssessment=createLandingAssessmentCache(bundle);
    if (!bundle.sites?.length || bundle.coverage?.length !== 2 || !bundle.coverage.every(Number.isFinite)) {
      throw new Error('The offline bundle is incomplete.');
    }
    const [start, end] = bundle.coverage;
    byId('bundle-range').textContent = dateOnly.formatRange(start * 1000, (end-1) * 1000);
    byId('bundle-range').title = `${formatTime(start)} to ${formatTime(end)}`;
    byId('bundle-note').textContent = `${bundle.sites.length} study point${bundle.sites.length === 1 ? '' : 's'} · NASA LOLA terrain · JPL ephemerides`;
    byId('visual-coverage').textContent=`UTC · ${coverageLabel(bundle.coverage)}`;
    byId('visual-coverage').title=`${formatTime(start)} to ${formatTime(end)}, exclusive end.`;
    byId('visual-supported-scope').textContent=`${bundle.sites.length} listed study points and ${coverageLabel(bundle.coverage)} have evaluated cached terrain-aware calculations.`;
    document.querySelector('#any-site-chart').setAttribute('aria-label',`Level-horizon Sun and Earth elevation across ${coverageLabel(bundle.coverage)}`);
    byId('any-site-range-note').textContent=`Height above the level horizon across ${coverageLabel(bundle.coverage)}. The vertical line is the view clock; the final axis tick is the exclusive cache end.`;
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
    setupAnySite();
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
 for(const row of compareSites(bundle,inputs,automaticSearchOptions(bundle,inputs))) {
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
 if(productMode==='compare'||comparisonOptions)renderOptionComparison();
}

function optionDecisionText(mission){
  if(mission.startAllowed===false)return 'Outside the allowed start schedule. Inspect environmental rules separately; this is not a lunar-condition verdict.';
  const rule=mission.constraints.find(c=>c.status==='FAIL')??mission.constraints.find(c=>c.status==='INDETERMINATE')??mission.constraints.slice().sort((a,b)=>a.margin-b.margin)[0];
  if(!rule)return 'No supported requirement evidence is available.';
  const v=constraintEvidence(rule);
  return `${mission.status==='PASS'?'Closest passing limit':rule.status==='FAIL'?'Broken rule':'Unresolved rule'}: ${v.title.toLowerCase()} ${v.metricText}; required ${v.requirementText}. Signed margin ${v.marginText}.`;
}

function optionDecisionBrief(mission){
  if(mission.startAllowed===false)return 'This arrival is outside your allowed schedule. Its environmental conditions are shown separately.';
  if(mission.status==='PASS')return `All ${mission.constraints.length} selected requirements are proven for this view.`;
  const rule=mission.constraints.find(c=>c.status==='FAIL')??mission.constraints.find(c=>c.status==='INDETERMINATE');
  if(!rule)return 'The available evidence cannot establish this mission.';
  const view=constraintEvidence(rule);
  return `${view.title}: ${view.metricText}; your selected limit is ${view.requirementText}.${rule.status==='INDETERMINATE'?' Unresolved time prevents a definite answer.':''}`;
}

function renderOptionComparison(focus){
  if(!inputs)return;
  byId('compare-workspace-title').textContent=requirementsEnabled?'Which arrival meets your requirements?':'Compare lunar arrivals';
  comparisonOptions??=[{key:'A',siteId:inputs.siteId,start:inputs.nominal},{key:'B',siteId:requirementsEnabled?inputs.siteId:(bundle.sites.find(s=>s.id!==inputs.siteId)??bundle.sites[0]).id,start:inputs.nominal+(requirementsEnabled?inputs.delayHours*3600:0)}];
  const root=byId('option-comparison');root.replaceChildren();root.dataset.count=comparisonOptions.length;
  if(isEdited){root.append(element('p','notice','Shared settings have unevaluated changes. Evaluate them in Advanced before comparing options.'));byId('comparison-difference').textContent='No updated comparison is established.';return;}
  byId('comparison-duration').value=inputs.durationHours;
  const reference=evaluateStart(bundle,requirementsEnabled?inputs:environmentInputs(inputs),inputs.siteId,inputs.nominal);
  const shortRuleNames={max_sun_block:'Sun gap',max_earth_block:'Earth gap',min_joint_total:'Together',min_joint_continuous:'Uninterrupted'};
  byId('comparison-shared-limits').textContent=requirementsEnabled?`${requirementsSource==='custom'?'Your selected requirements':'Illustrative, not NASA specifications'}: ${reference.constraints.map(c=>`${shortRuleNames[c.id]??c.id} ${constraintEvidence(c).requirementText}`).join(' · ')}.`:'Visibility comparison. No mission requirements applied.';
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
    const bounded=missionMetrics(mission,findSite(option.siteId));
    const complete=mission.start>=bundle.coverage[0]&&mission.end<=bundle.coverage[1];
    evaluations.push({key:option.key,name:findSite(option.siteId)?.name,mission,metrics:bounded,complete});Object.assign(card.dataset,{site:option.siteId,start:option.start,end:mission.end,status:mission.status,cause:mission.startAllowed===false?'schedule':'environment'});
    const status=element('p','option-status');if(requirementsEnabled){status.append(statusChip(mission.status));card.append(status);}else card.dataset.status='ENVIRONMENT';
    if(mission.startAllowed===false)card.append(element('p','schedule-exclusion','Outside allowed schedule — environmental results are separate.'));
    const joint=requirementsEnabled?mission.constraints.find(c=>c.id==='min_joint_total'):null;
    const jointSeconds=joint?joint.range[0]*3600:bounded.joint.visibleRangeSeconds[0];
    card.append(element('p','option-joint',firstScreenConclusion(bounded,mission.end-mission.start,{complete}).headline));
    const explanation=visibilityConclusion(bounded,mission.end-mission.start,{complete});
    card.append(element('p','option-reason',requirementsEnabled?optionDecisionBrief(mission):explanation.reason));
    const measurementRoot=element('div','');environmentalMeasurements(measurementRoot,mission);card.append(measurementRoot);
    if(siteCaution(option.siteId))measurementRoot.querySelector('details').append(element('p','comparison-caution',siteCaution(option.siteId)));
    if(requirementsEnabled)for(const [id,label]of [['max_sun_block','Longest Sun unavailability'],['max_earth_block','Longest Earth obstruction']]){
      const rule=mission.constraints.find(c=>c.id===id),view=constraintEvidence(rule);
      measurementRoot.querySelector('details').append(element('p','option-outage',`${label}: ${rule.range[0]===rule.range[1]?evidenceTime(rule.metric):view.rangeText}${rule.status==='INDETERMINATE'?' · unresolved':''}.`));
    }
    const viewButton=element('button','primary','Explore this option →');viewButton.id=`comparison-view-${option.key}`;viewButton.type='button';viewButton.disabled=isEdited;
    viewButton.addEventListener('click',()=>{
      if(isEdited){byId('comparison-difference').textContent='Evaluate pending shared settings in Advanced before loading an option.';return;}
      byId('site').value=option.siteId;byId('nominal').value=inputTime(option.start);selected='nominal';updateSiteDetail();
      if(evaluate()){showGuidedPhase('nominal');setProductMode('explore');byId('workspace-notice').hidden=true;}
    });
    card.append(viewButton);
    if(requirementsEnabled){const rules=element('div','compact-requirements');renderRequirementCards(rules,mission,true);
      const ruleDetails=element('details','option-rules');ruleDetails.append(element('summary','',`${mission.constraints.length} requirement results`),rules);card.append(ruleDetails);}root.append(card);
  }
  byId('add-comparison-option').hidden=comparisonOptions.length===3;byId('remove-comparison-option').hidden=comparisonOptions.length!==3;
  const pass=evaluations.filter(({mission})=>mission.status==='PASS'),uncertain=evaluations.filter(({mission})=>mission.status==='INDETERMINATE'),excluded=evaluations.filter(({mission})=>mission.startAllowed===false);
  let difference;
  if(evaluations.length!==comparisonOptions.length)difference='Comparison incomplete. Choose a supported site and valid arrival for each option.';
  else if(!requirementsEnabled)difference=comparisonConclusion(evaluations,comparisonOptions.length)+(excluded.length?' Some starts are outside the allowed schedule; visibility measurements remain separate.':'');
  else if(excluded.length===evaluations.length)difference='No option fits the allowed start schedule. That is a scheduling exclusion, not proof of unfavorable lunar conditions.';
  else if(!pass.length)difference=`${evaluations.length===2?'Neither option passes.':'No option passes.'} ${uncertain.length?'Uncertainty prevents a confirmed passing comparison.':'The selected rules or start schedule reject these options.'} Each card explains the limiting requirement.`;
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

// Level-horizon sky for curated and custom lunar coordinates. No terrain, so no visibility claim.
let anySiteSeries=null,anySiteStudy=null,anySiteKey='';
const compass=azimuth=>['north','north-east','east','south-east','south','south-west','west','north-west'][Math.round(azimuth/45)%8];
function spanText(seconds){
  const s=Math.max(0,seconds),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return [d?`${d} d`:'',h?`${h} h`:'',!d&&m?`${m} min`:''].filter(Boolean).join(' ')||'under a minute';
}
function anySiteTarget(){
  const latField=byId('any-site-lat'),lonField=byId('any-site-lon'),lat=Number(latField.value),lon=Number(lonField.value);
  if(latField.value===''||lonField.value===''||!validCoordinate(lat,lon))return null;
  const known=[...NOTABLE_SITES,...bundle.sites].find(site=>site.id===byId('any-site-select').value);
  return {lat,lon,name:known?known.name:`${Math.abs(lat)}° ${lat<0?'S':'N'}, ${lon}° E`,source:known?.source,study:Boolean(known)&&bundle.sites.includes(known)};
}
function setupAnySite(){
  const select=byId('any-site-select'),groups=new Map();
  const group=label=>{if(!groups.has(label)){const node=document.createElement('optgroup');node.label=label;groups.set(label,node);select.append(node);}return groups.get(label);};
  for(const site of NOTABLE_SITES){const option=element('option','',`${site.name} · ${site.year}`);option.value=site.id;group(site.group).append(option);}
  for(const site of bundle.sites){const option=element('option','',`${site.name} · level horizon only`);option.value=site.id;group('South-pole study points').append(option);}
  const custom=element('option','','Custom coordinate');custom.value='custom';select.append(custom);
  const choose=()=>{
    const site=[...NOTABLE_SITES,...bundle.sites].find(entry=>entry.id===select.value);
    if(site){byId('any-site-lat').value=site.lat;byId('any-site-lon').value=site.lon;}
    // Context globe selections are educational only; never replace the study-point mission.
    const contextId=NOTABLE_SITES.some(point=>point.id===select.value)?select.value:null;
    sceneController?.selectContextSite(contextId,{focus:contextId!==null&&sceneController?.inspect().contextSiteId!==contextId});
    renderAnySite(true);
  };
  select.addEventListener('change',choose);
  for(const id of ['any-site-lat','any-site-lon'])byId(id).addEventListener('input',()=>{select.value='custom';sceneController?.selectContextSite(null,{focus:false});renderAnySite(true);});
  byId('any-site').addEventListener('toggle',()=>renderAnySite(true));
  select.value=NOTABLE_SITES[0].id;choose();
}
function drawAnySiteChart(){
  const svg=byId('any-site-chart'),[start,end]=bundle.coverage;svg.replaceChildren();
  byId('any-site-days').replaceChildren(...coverageTicks(bundle.coverage).map(tick=>{
    const label=element('span','',tick.label);label.title=formatTime(tick.time)+(tick.time===end?' (exclusive cache end)':'');return label;
  }));
  const x=time=>1000*(time-start)/(end-start),y=elevation=>100-elevation/90*100;
  svg.append(svgElement('line',{x1:0,x2:1000,y1:100,y2:100,class:'any-site-zero'}));
  for(const [series,style] of [[anySiteStudy,' study'],[anySiteSeries,'']])if(series)for(const key of ['earth','sun']){
    const path=series.map((point,index)=>`${index?'L':'M'}${x(point.time).toFixed(1)} ${y(point[key]).toFixed(1)}`).join('');
    svg.append(svgElement('path',{d:path,class:`any-site-line ${key}${style}`}));
  }
  svg.append(svgElement('line',{x1:0,x2:0,y1:0,y2:200,class:'any-site-playhead'}));
}
function renderAnySite(rebuild=false){
  if(!bundle||!byId('any-site').open)return;
  const target=anySiteTarget(),root=byId('any-site-result');
  if(!target){
    anySiteSeries=null;anySiteKey='';byId('any-site-chart').replaceChildren();byId('any-site-contrast').textContent='';byId('any-site-source').hidden=true;
    root.replaceChildren(element('p','any-site-empty','Enter a latitude from −90 to 90 and a longitude from −180 to 360 degrees east.'));return;
  }
  const {rows}=referenceDirections(bundle);
  const study=findSite(inputs?.siteId),sameAsStudy=!study||(study.lat===target.lat&&study.lon===target.lon),key=`${target.lat}|${target.lon}|${study?.id}`;
  if(rebuild||!anySiteSeries||key!==anySiteKey){
    anySiteKey=key;anySiteSeries=elevationSeries(bundle,target.lat,target.lon);
    anySiteStudy=sameAsStudy?null:elevationSeries(bundle,study.lat,study.lon);drawAnySiteChart();
    const legend=byId('any-site-study-key');legend.hidden=sameAsStudy;legend.textContent=sameAsStudy?'':`Dashed: ${study.name}, same level-horizon model`;
    const sun=levelSummary(anySiteSeries,'sun'),earth=levelSummary(anySiteSeries,'earth'),percent=value=>`${Math.round(value*100)}%`;
    byId('any-site-contrast').textContent=`Across ${coverageLabel(bundle.coverage)}, the Sun is above the level horizon ${percent(sun.aboveFraction)} of sampled times here and climbs to ${sun.max.toFixed(0)}°. `
      +(earth.aboveFraction===1?`Earth never leaves the sky: it stays between ${earth.min.toFixed(0)}° and ${earth.max.toFixed(0)}°.`
        :earth.aboveFraction===0?'Earth never rises here: this site faces away from Earth, so a relay would be needed.'
          :`Earth hovers near the horizon, between ${earth.min.toFixed(1)}° and ${earth.max.toFixed(1)}°, and is above the level horizon ${percent(earth.aboveFraction)} of the time.`)
      +(target.study?' Terrain-aware results for this study point are in the planner above.':'');
    const link=byId('any-site-source');link.hidden=!target.source?.startsWith('https://');if(!link.hidden)link.href=target.source;
  }
  const time=currentTime??inputs?.nominal??bundle.coverage[0],cadence=rows[1].time-rows[0].time;
  const head=byId('any-site-chart').querySelector('.any-site-playhead');
  if(!isCachedTime(bundle.coverage,time)){
    root.replaceChildren(element('p','any-site-empty','The view clock is outside the cached date range. No Sun or Earth direction is calculated for this time.'));
    root.dataset.time='';if(head)head.style.display='none';return;
  }
  const sampleIndex=Math.max(0,Math.min(rows.length-1,Math.round((time-rows[0].time)/cadence))),sky=skyAt(rows[sampleIndex],target.lat,target.lon);
  root.replaceChildren();root.dataset.time=sky?.time??'';
  if(!sky){root.append(element('p','any-site-empty','No cached direction exists at this time.'));if(head)head.style.display='none';return;}
  root.append(element('p','any-site-when',`${target.name} · ${shortTime(sky.time)}`));
  for(const [key,title] of [['sun','Sun'],['earth','Earth']]){
    const {azimuth,elevation}=sky[key],card=element('div',`any-site-body ${key}`),crossing=nextLevelCrossing(anySiteSeries,key,sky.time);
    Object.assign(card.dataset,{body:key,elevation:elevation.toFixed(4),azimuth:azimuth.toFixed(4)});
    card.append(element('span','any-site-label',title),
      element('strong','',`${Math.abs(elevation).toFixed(1)}° ${elevation<0?'below':'above'} the level horizon`),
      element('span','',`Toward the ${compass(azimuth)} · bearing ${azimuth.toFixed(0)}°`),
      element('span','any-site-next',crossing?`Estimated ${crossing.kind==='sets'?'drop below':'rise above'} the level horizon in ${spanText(crossing.time-sky.time)}`
        :`Stays ${elevation>0?'above':'below'} the level horizon in the remaining cached samples`));
    if(!sameAsStudy){
      const there=skyAt(rows[sampleIndex],study.lat,study.lon)[key].elevation;
      card.append(element('span','any-site-versus',`${study.name} at this moment: ${Math.abs(there).toFixed(1)}° ${there<0?'below':'above'}`));
    }
    root.append(card);
  }
  if(head){head.style.display='';const position=1000*(sky.time-bundle.coverage[0])/(bundle.coverage[1]-bundle.coverage[0]);head.setAttribute('x1',position);head.setAttribute('x2',position);}
}

function arrivalOffset(seconds) {
  const size=Math.abs(seconds),d=Math.floor(size/86400),h=Math.floor(size%86400/3600),m=Math.floor(size%3600/60);
  const text=[d?`${d} d`:'',h?`${h} h`:'',m?`${m} min`:''].filter(Boolean).join(' ');
  return !text?'at arrival':seconds>0?`${text} after arrival`:`${text} before arrival`;
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
  if(calendarArrival!==inputs.nominal){calendarArrival=inputs.nominal;calendarMonth=inputs.nominal;}
  const month=utcMonthWindow(bundle.coverage,calendarMonth??inputs.nominal);
  byId('calendar-month').textContent=month.label;
  byId('calendar-previous').disabled=month.previous===null;byId('calendar-next').disabled=month.next===null;
  matrix=feasibilityMatrix(bundle,requirementsEnabled?inputs:environmentInputs(inputs),{range:month.range});
  const scroll=element('div','heatmap-scroll');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label',`Scrollable daily site feasibility table for ${month.label}`);
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
  byId('feasibility-note').textContent=`${month.label} · ${matrix.starts.length} dates × ${matrix.rows.length} sites · starts every ${matrix.stepHours} h at ${new Date(inputs.nominal*1000).toISOString().slice(11,19)} UTC · ${inputs.durationHours} h fixed mission. P = PASS, F = FAIL, ? = INDETERMINATE, S = outside allowed schedule (not an environmental verdict). All hard limits and the allowed start range remain unchanged. The last date may be censored by the cache end. ${matrix.basis}`;
  if(!requirementsEnabled)byId('feasibility-note').textContent=`${month.label} · ${matrix.starts.length} dates × ${matrix.rows.length} sites · daily starts at ${new Date(inputs.nominal*1000).toISOString().slice(11,19)} UTC · ${inputs.durationHours} h views. Numbers = confirmed Sun + Earth hours; ? = unresolved possible overlap; S = outside your schedule. No mission requirements applied. The last view may cross the cache end.`;
}

function setExpert(enabled) {
  if(enabled)byId('analysis-tools').open=true;
  setProductMode(enabled?'analyst':'explore',false);
  byId('expert-toggle').setAttribute('aria-expanded',String(enabled));
  byId('expert-toggle').textContent=enabled?'Close analyst mode':'Analyst mode';
  document.body.classList.toggle('expert-mode',enabled);
}

function setProductMode(mode,scroll=true){
  if(mode!==productMode)++rescueAnimation;
  productMode=mode;
  document.body.dataset.workspace=mode;
  byId('experience').hidden=mode==='compare'||mode==='analyst';
  byId('compare-workspace').hidden=mode!=='compare';
  byId('landing-opportunities').hidden=mode!=='explore'||!opportunityReport;
  byId('top').hidden=mode!=='analyst';
  byId('experience').dataset.workspace=mode;
  for(const button of document.querySelectorAll('[data-workspace]'))button.setAttribute('aria-pressed',String(button.dataset.workspace===mode));
  if(mode==='analyst'&&result&&byId('analysis-tools').open)renderPlot(selectedMission());
  if(mode==='compare'&&inputs)renderOptionComparison();
  if(scroll)scrollTo({top:0,behavior:'instant'});
}

function updateSceneCaption(){
  const enhanced=byId('night-visibility').getAttribute('aria-pressed')==='true';
  byId('scene-mode-label').textContent=experienceMode==='surface'
    ?(enhanced?'NASA LOLA · ARTIFICIAL NIGHT FILL':'NASA LOLA · CENTER-GATED DISPLAY LIGHTING')
    :'NASA LRO / ORBITAL EXPLORATION';
}

function setExperienceMode(mode) {
  experienceMode=mode;
  byId('experience').dataset.mode=mode;
  for(const key of ['orbital','surface'])byId(`mode-${key}`).setAttribute('aria-pressed',String(key===mode));
  byId('surface-focus').hidden=false;
  byId('focus-terrain').textContent=mode==='surface'?'Terrain':'Study sites';
  byId('focus-terrain').setAttribute('aria-label',mode==='surface'?'Explore the modeled lunar terrain':'Focus the lunar study points');
  byId('scene-transport').hidden=false;
  byId('mission-story').hidden=false;
  byId('night-visibility').hidden=mode!=='surface'||sceneDisabled;
  updateSceneCaption();
  byId('explore-site').textContent='Try a 72-hour delay';
  byId('explore-site').setAttribute('aria-label','Load the illustrative 72-hour landing-delay example, with your permission');
  if(sceneController&&!sceneDisabled)byId('scene-status').textContent=mode==='orbital'?'Drag to orbit · Scroll or pinch to zoom':'Drag to look · Scroll or pinch to zoom';
}

function setSceneStatus(event) {
  byId('scene-status').textContent=event.message??String(event);
  if(event.kind==='ready')byId('experience').dataset.ready='true';
  if(event.kind==='error') {
    sceneDisabled=true;
    byId('night-visibility').hidden=true;
    byId('experience').dataset.ready='false';
    byId('scene-status').textContent=`3D graphics unavailable. ${event.message??''} The accessible 2D planner remains fully functional.`;
    byId('workspace-notice').hidden=false;byId('workspace-notice').textContent=byId('scene-status').textContent;
    setExpert(true);
  }
}

async function initializeExperience() {
  byId('option-comparison').before(document.querySelector('.comparison-difference'));
  byId('mission-actions').append(byId('find-opportunities'),byId('explore-site'));
  byId('mission-options-content').append(byId('apply-requirements').closest('label'),byId('mission-requirements-editor'),byId('start-delay-demo'));
  byId('orbital-story-slot').append(byId('mission-story'));
  // Evidence stays below the scene in normal document flow.
  byId('comparison-panels').append(byId('feasibility'));
  const audit=element('details','site-audit');audit.append(element('summary','',`${bundle.sites.length}-site original/delayed audit`),byId('compare'));byId('top').append(audit);
  byId('scene-mount').append(byId('scene-poster'),document.querySelector('.scene-mode-switch'));
  byId('scene-mount').append(byId('earth-inset'));
  byId('scene-mount').append(byId('surface-focus'),byId('rescue-transition'));
  // Transport is part of the scene composition in the source markup.
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
    onSiteSelect:siteId=>selectVisualSite(siteId),onContextSelect:point=>{
      byId('any-site-select').value=point.id;
      byId('any-site-select').dispatchEvent(new Event('change'));
      showOtherSites();
    },onModeChange:setExperienceMode,onStatus:setSceneStatus}));
  try {
    sceneController=await sceneLoading;
    if(sceneDisabled){sceneController.dispose();return;}
    const coordinateCaption=byId('scene-mount').querySelector('.mission-scene-caption');
    if(coordinateCaption)byId('scene-coordinate-caption').append(coordinateCaption);
    const markerLegend=byId('scene-mount').querySelector('.mission-marker-legend');
    if(markerLegend)byId('scene-coordinate-caption').append(markerLegend);
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
  byId('mode-surface').disabled=true;
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
  finally{byId('mode-surface').disabled=false;}
}

function renderLandingAssessment(siteId,time,{pending=false}={}) {
  const root=byId('hero-landing-verdict');
  if(!root||!inputs)return;
  pending ||= isEdited;
  const view=!requirementsEnabled?{status:null,reason:'Requirements not applied'}
    :pending?{status:'INDETERMINATE',reason:'Inputs changed. Apply your changes to refresh this assessment.'}
      :landingAssessment.assess(inputs,siteId,time,{requirementsApplied:true});
  Object.assign(root.dataset,{status:view.status??'NOT_APPLIED',start:Number.isFinite(time)?String(time):'',site:siteId??''});
  root.replaceChildren(element('span','hero-landing-verdict-label','If landing now:'));
  if(view.status)root.append(statusChip(view.status));
  else root.append(element('strong','','Requirements not applied'));
  root.append(element('span','hero-landing-verdict-detail',view.status
    ?`${shortTime(time)} · ${inputs.durationHours} h. ${view.reason}`
    :'The view clock explores the sky. Apply mission requirements to assess a landing at this time.'));
  if(view.status)root.append(element('span','hero-landing-verdict-scope',`${requirementsSource==='custom'?'Your requirements':'Illustrative requirements'}. Selected arrival stays unchanged.`));
}

function updateExperienceFrame(site,sample,mission) {
  renderLandingAssessment(site.id,sample[0]);
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
  // The clock reads relative to the chosen arrival, so scrubbing cannot be mistaken for changing it.
  const sinceArrival=arrivalOffset(sample[0]-mission.start),wholeMonth=byId('time-scope').value==='coverage';
  slider.setAttribute('aria-valuetext',`${formatTime(sample[0])}, ${sinceArrival}`);
  byId('hero-time-label').textContent=`${shortTime(sample[0])} · ${sinceArrival}`;
  byId('hero-time-label').title='The scene moves in 30-minute steps. Your arrival and stay do not change.';
  byId('hero-time-start').textContent=wholeMonth&&chart?.domain?shortTime(chart.domain[0]):`Arrival · ${shortTime(mission.start)}`;
  byId('hero-time-end').textContent=wholeMonth&&chart?.domain?shortTime(chart.domain[1]):`End of stay · ${shortTime(mission.end)}`;
  if(!wholeMonth&&autoMonthSpeed){autoMonthSpeed=false;byId('sky-speed').value='4';}
  byId('hero-speed').value=byId('sky-speed').value;
  byId('hero-scope-stay').setAttribute('aria-pressed',String(!wholeMonth));byId('hero-scope-month').setAttribute('aria-pressed',String(wholeMonth));
  const lanes=byId('hero-lanes'),laneKey=`${mission.siteId}|${mission.start}|${mission.end}`;
  lanes.removeAttribute('aria-hidden');
  lanes.hidden=wholeMonth||isEdited;
  if(!lanes.hidden&&lanes.dataset.key!==laneKey){
    lanes.dataset.key=laneKey;lanes.replaceChildren();
    for(const [key,title] of [['sun','Sun'],['earth','Earth']]){
      const lane=element('div','hero-lane'),track=element('button','hero-lane-track');lane.dataset.channel=key;
      track.type='button';track.dataset.channel=key;
      const summary=visibilitySummary(mission.timeline[key],mission.start,mission.end).seconds;
      const total=mission.end-mission.start,unresolved=summary.uncertain+summary.unknown;
      const compactDuration=seconds=>conciseDuration(seconds).replace(/\s+\d+\s+s$/,'');
      const caption=summary.visible===total?'Visible for the whole stay':summary.blocked===total?'Blocked for the whole stay'
        :`${compactDuration(summary.visible)} confirmed${unresolved>0?` · ${compactDuration(unresolved)} unresolved`:''}`;
      const meanings={visible:'center visible',blocked:'center blocked',uncertain:'unresolved visibility',unknown:'missing data'};
      track.setAttribute('aria-label',`${title}: ${caption}. ${conciseDuration(summary.blocked)} blocked; ${conciseDuration(unresolved)} unresolved or missing. Click a time to inspect the nearest cached sample. Enter inspects the current time; the time slider supports arrow-key scrubbing.`);
      track.title=`${title}: ${caption}. Solid color is visible; dark is blocked; diagonal stripes are unresolved; crosshatching is missing data.`;
      const captionNode=element('span','hero-lane-caption',caption),strip=element('span','hero-lane-strip timeline-unknown');
      captionNode.setAttribute('aria-hidden','true');strip.setAttribute('aria-hidden','true');
      for(const [a,b,state] of mission.timeline[key]){
        const piece=element('span',`timeline-piece timeline-${state}`);
        Object.assign(piece.dataset,{start:a,end:b,state});
        piece.title=`${title}: ${meanings[state]??'missing data'} · ${formatTime(a)} to ${formatTime(b)}`;
        piece.style.left=`${100*(a-mission.start)/total}%`;piece.style.width=`${100*(b-a)/total}%`;strip.append(piece);
      }
      const head=element('span','timeline-playhead story-joint-playhead hero-lane-playhead');
      head.dataset.start=mission.start;head.dataset.end=mission.end;strip.append(head);
      const inspection=element('span','hero-lane-inspection');inspection.id=`hero-${key}-inspection`;inspection.hidden=true;
      inspection.setAttribute('role','status');inspection.setAttribute('aria-live','off');track.setAttribute('aria-describedby',inspection.id);
      const inspectTime=(time,announce=false)=>{
        const interval=mission.timeline[key].find(([a,b])=>a<=time&&time<b);
        inspection.setAttribute('aria-live',announce?'polite':'off');
        inspection.textContent=interval?`${title}: ${meanings[interval[2]]??'missing data'} · ${formatTime(interval[0])} to ${formatTime(interval[1])}. View: ${formatTime(time)}.`
          :`${title}: no interval established at ${formatTime(time)}. No visibility is assumed.`;
        inspection.hidden=false;
      };
      const pointerTime=event=>{
        const rect=strip.getBoundingClientRect(),fraction=Math.max(0,Math.min(1,(event.clientX-rect.left)/Math.max(1,rect.width)));
        // Keep the existing half-open mission domain; the right edge selects its last cached sample.
        return Math.min(mission.end-0.001,mission.start+fraction*total);
      };
      track.addEventListener('pointermove',event=>{
        if(!chart)return;const index=nearestSample(chart.samples,pointerTime(event),chart.domain);
        if(index!==null)inspectTime(chart.samples[index][0]);
      });
      track.addEventListener('pointerleave',()=>{if(document.activeElement!==track)inspection.hidden=true;});
      track.addEventListener('focus',()=>inspectTime(currentTime??mission.start));
      track.addEventListener('blur',()=>{inspection.hidden=true;});
      track.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();inspection.hidden=true;}});
      track.addEventListener('click',event=>{
        if(isEdited||!chart)return;const time=event.detail===0?(currentTime??mission.start):pointerTime(event);
        const index=nearestSample(chart.samples,time,chart.domain);if(index===null)return;
        pausePlayback();byId('probe-slider').value=index;updateProbe();inspectTime(chart.samples[index][0],true);
      });
      track.append(captionNode,strip,inspection);
      lane.append(element('span','hero-lane-label',title),track);lanes.append(lane);
    }
  }
  renderAnySite();
  byId('hero-play').disabled=isEdited||!chart||chart.samples.length<2;
  const visibility=byId('hero-visibility'),eventNotes={};visibility.replaceChildren();
  for(const [key,title] of [['sun','Sun'],['earth','Earth']]) {
    const state=latestSceneFrame.states[key],label=state==='visible'?'in view':state==='blocked'?'hidden by terrain':state==='uncertain'?'too close to the skyline to confirm':'no data at this time';
    const elevation=sample?.[key==='sun'?2:5];
    // Plain-language time to the next established change, from the same bounded events as Advanced.
    const wanted=isEdited?null:state==='visible'?'loss':state==='blocked'?'reacquisition':null;
    let next='';
    if(wanted) {
      const countdown=transitionCountdown(refinedEvents(site,key,sample[0],bundle.coverage),wanted,sample[0]);
      const name=wanted==='loss'?(key==='sun'?'sunset':'Earthset'):(key==='sun'?'sunrise':'Earthrise');
      // Only a bounded time is shown as a countdown; unresolved timing stays in the tooltip with its bracket.
      // A bounded time reads as a countdown; an unresolved one shows its bracket, rounded outward to the minute.
      const minute=seconds=>compactTime.format(seconds*1000).replace(',','');
      if(countdown.kind==='bounded')next=`${name} in ${durationRange(countdown.remaining)}`;
      else if(countdown.kind==='unresolved'){
        const from=minute(Math.floor(countdown.interval[0]/60)*60),to=minute(Math.ceil(countdown.interval[1]/60)*60);
        next=`${name} unresolved: ${from}–${from.slice(0,6)===to.slice(0,6)?to.slice(7):to} UTC`;
      }
      eventNotes[key]=countdown.kind==='bounded'?''
        :countdown.kind==='unresolved'?` The ${name} time cannot be pinned down more closely than ${shortTime(countdown.interval[0])} to ${shortTime(countdown.interval[1])}.`
          :` No ${name} is established in the remaining cached data.`;
    }
    const item=element('span','hero-body');item.append(element('strong','',`${title} ${label}`));
    if(Number.isFinite(elevation))item.append(element('small','',`${Math.abs(elevation).toFixed(1)}° ${elevation<0?'below':'above'} the level horizon`));
    if(next)item.append(element('small','hero-next',next.replace(/^./,first=>first.toUpperCase())));
    item.dataset.state=state;item.dataset.target=key;if(wanted)item.dataset.nextEvent=wanted;visibility.append(item);
  }
  for(const key of ['sun','earth']){
    const d=latestSceneFrame.sample,az=d?.[key==='sun'?1:4],el=d?.[key==='sun'?2:5];
    const item=visibility.querySelector(`[data-target='${key}']`);
    if(item&&Number.isFinite(az)&&Number.isFinite(el))item.title=`Bearing ${az.toFixed(1)}°, elevation ${el.toFixed(1)}° above the level horizon.${eventNotes[key]??''} Rise and set mean the body center crossing the terrain skyline. 30-minute cached direction; geometry only.`;
  }
  for(const head of document.querySelectorAll('.story-joint-playhead')){
    const start=Number(head.dataset.start),end=Number(head.dataset.end);head.hidden=sample[0]<start||sample[0]>=end;head.style.left=`${100*(sample[0]-start)/(end-start)}%`;
  }
  // Small read-only evidence on the mount enables UI/data parity verification.
  byId('scene-mount').dataset.time=sample[0];
  byId('scene-mount').dataset.missionStart=mission.start;
}

function invalidateExperience() {
  renderLandingAssessment(inputs?.siteId,currentTime,{pending:true});
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
  if(inputs&&(productMode==='compare'||comparisonOptions))renderOptionComparison();
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
    byId('story-date').textContent=`${findSite(mission.siteId).name} · ${shortTime(mission.start)} · ${inputs.durationHours} h view`;
    const conclusion=firstScreenConclusion(missionMetrics(mission,findSite(mission.siteId)),mission.end-mission.start,{complete:mission.start>=bundle.coverage[0]&&mission.end<=bundle.coverage[1]});
    byId('story-title').textContent=conclusion.headline;byId('story-explanation').textContent=conclusion.reason;byId('story-status').textContent='';
    // Each body's own time in view, as a confirmed minimum, beside the joint headline.
    const own=missionMetrics(mission,findSite(mission.siteId)),stay=mission.end-mission.start,durations=byId('story-durations');
    const inView=range=>{const lo=Math.floor(range[0]/60)*60;return lo>=stay?'whole stay':lo<60?(range[1]>=60?'not confirmed':'none'):`${range[1]-range[0]>=60?'at least ':''}${conciseDuration(lo)}`;};
    durations.hidden=!(mission.start>=bundle.coverage[0]&&mission.end<=bundle.coverage[1]);
    durations.replaceChildren(...[['sun','Sun in view'],['earth','Earth in view']].map(([key,label])=>{
      const item=element('span',`story-duration ${key}`),value=inView(own[key].visibleRangeSeconds);item.dataset.channel=key;
      item.setAttribute('aria-label',`${label}: ${value}`);item.append(`${label.split(' ')[0]}: `,element('strong','',value));return item;}));
    byId('story-joint').hidden=true;byId('configuration-summary').hidden=true;
    byId('story-requirements').textContent='Sun-center visibility: the Sun’s center clears terrain and Earth’s apparent disc. Earth-center line of sight: a geometric direction to Earth’s center. Both at once: joint visibility. Full-disc illumination, electrical power and radio performance are not established.';
    document.querySelector('.story-footer summary').textContent='Visibility definitions';
    environmentalMeasurements(byId('environment-overview'),mission,{timelines:true});return;
  }
  byId('story-durations').hidden=true;
  byId('story-joint').hidden=false;document.querySelector('.story-footer summary').textContent='Illustrative mission requirements';
  byId('story-next').disabled=false;for(const button of document.querySelectorAll('[data-story]'))button.disabled=false;
  const inspectedResult=typeof selected==='number'?{...result,[guidedPhase]:selectedMission()}:result;
  const story=missionStory(inspectedResult,guidedPhase);
  document.querySelector('.experience-intro .eyebrow').textContent=`A ${inputs.durationHours}-HOUR MISSION AT THE LUNAR SOUTH POLE`;
  byId('mission-story').dataset.start=story.start??'';
  byId('mission-story').dataset.site=story.siteId??'';
  byId('mission-story').dataset.status=story.status;
  for(const button of document.querySelectorAll('[data-story]')){button.setAttribute('aria-pressed',String(button.dataset.story===guidedPhase));button.dataset.status=result[button.dataset.story]?.status??'NONE';}
  byId('story-title').textContent=story.heading;
  if(!delayStoryEnabled)byId('story-title').textContent='Arrival assessment';
  byId('story-explanation').textContent=story.message;
  const mission=selectedMission();
  if(mission.status==='PASS'){
    const joint=mission.constraints.find(c=>c.id==='min_joint_total');
    if(joint)byId('story-explanation').textContent=`Proven Sun + Earth: ${constraintEvidence(joint).metricText}. All ${mission.constraints.length} rules are proven below.`;
  }
  if(mission.start<bundle.coverage[0]||mission.end>bundle.coverage[1])byId('story-explanation').textContent='The full mission extends outside the displayed cached coverage. Complete visibility is not known; choose a covered arrival or duration.';
  else if(mission.startAllowed===false)byId('story-explanation').textContent='This arrival is outside your allowed start schedule. Scheduling exclusion is separate from the environmental results below.';
  byId('story-date').textContent=story.start!==undefined?`${shortTime(story.start)} · ${inputs.durationHours} h · ${requirementsSource==='custom'?'your requirements':'illustrative requirements'}`:'No confirmed start inside the search range';
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
    if(result.search.windowLimited)byId('story-explanation').textContent+=' '+searchQualification(result.search);
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
    choice.textContent=`Why this date: first confirmed start on the ${inputs.gridMinutes}-minute grid${inputs.gridMinutes===60?' (hourly)':''}. Wait ${Math.floor(wait/24)} d ${number.format(wait%24)} h after the delayed arrival. Earlier sampled site/starts: ${counts.FAIL} FAIL, ${counts.INDETERMINATE} INDETERMINATE, ${counts.PASS} PASS. Uncertain earlier starts do not prove an earlier window is impossible. The mission requirements were not relaxed. ${searchQualification(result.search)}`.trim();
  }
}

function cancelSceneEntry(){++sceneIntent;requestedExperienceMode=experienceMode;if(experienceMode==='orbital')sceneController?.setMode('orbital');}
async function runRescueAction(){
  if(isEdited||!result)return;
  delayStoryEnabled=true;syncAssessment();
  clearOpportunities();
  const target=guidedPhase==='nominal'?'delayed':guidedPhase==='delayed'?'recommended':'nominal';
  if(target==='nominal'||!result[target]){showGuidedPhase(target);return;}
  // Graphics are optional. A failed renderer must not cancel the existing
  // evaluated decision by routing through enterSurface / a workspace change.
  if(sceneDisabled||byId('scene-mount').dataset.terrainStatus==='unavailable'){
    pausePlayback();showGuidedPhase(target);
    byId('scene-status').textContent='3D animation unavailable. Showing the calculated mission result and timelines; the scientific evidence is unchanged.';
    return;
  }
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
  const root=byId('story-joint');root.replaceChildren();byId('story-uncertainty').replaceChildren();if(!mission)return;
  const summary=visibilitySummary(mission.timeline.joint,mission.start,mission.end).seconds;
  root.append(element('p','joint-duration',`${durationClock(summary.visible)} with Sun + Earth`));
  const track=element('div','story-joint-track');track.setAttribute('aria-label','Joint sunlight and Earth-center visibility intervals');
  for(const [a,b,state]of mission.timeline.joint){const segment=element('span',`timeline-piece timeline-${state}`);segment.style.left=`${100*(a-mission.start)/(mission.end-mission.start)}%`;segment.style.width=`${100*(b-a)/(mission.end-mission.start)}%`;segment.title=`${state}: ${formatTime(a)} to ${formatTime(b)}`;track.append(segment);}
  const playhead=element('span','timeline-playhead story-joint-playhead');playhead.dataset.start=mission.start;playhead.dataset.end=mission.end;track.append(playhead);root.append(track);
  if(guidedPhase==='recommended'&&result.recommended){
    const wait=(result.recommended.start-result.delayed.start)/3600;
    root.prepend(element('p','recovery-wait',`Wait after delay: ${Math.floor(wait/24)} d ${number.format(wait%24)} h.`));
  }
  const detail=element('details');detail.append(element('summary','','Visibility uncertainty'),element('p','',`${durationClock(summary.uncertain+summary.unknown)} unresolved. This is center visibility, not generated power or a working radio link.`));byId('story-uncertainty').replaceChildren(detail);
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

// Onboarding saves actual user controls before an explicitly consented preset load.
// No independent evaluator: restoration goes through the normal evaluation path.
const onboardingFields=['site','nominal','duration','delay','max-sun','max-earth','min-total','min-continuous','earliest','latest','grid'];
export function captureOnboardingPlan(){
  if(!bundle||!inputs)return null;
  return {
    fields:Object.fromEntries(onboardingFields.map(id=>[id,byId(id).value])),
    compact:{arrival:byId('visual-arrival').value,duration:byId('visual-duration').value},
    prelaunch:byId('prelaunch').checked,requirementsEnabled,requirementsSource,delayStoryEnabled,
    explicitSchedule:{...explicitSchedule},scheduleAnchor:{...scheduleAnchor},selected,
    comparisonOptions:comparisonOptions?structuredClone(comparisonOptions):null
  };
}
export function restoreOnboardingPlan(saved){
  if(!saved?.fields||!bundle)return false;
  pausePlayback();
  for(const id of onboardingFields)byId(id).value=saved.fields[id];
  byId('prelaunch').checked=saved.prelaunch;
  requirementsEnabled=saved.requirementsEnabled;requirementsSource=saved.requirementsSource;delayStoryEnabled=saved.delayStoryEnabled;
  explicitSchedule={...saved.explicitSchedule};scheduleAnchor={...saved.scheduleAnchor};
  comparisonOptions=saved.comparisonOptions?structuredClone(saved.comparisonOptions):null;selected=saved.selected;
  syncAssessment();updateSiteDetail();
  loadingPreset=true;try{evaluate();}finally{loadingPreset=false;}
  // Preserve uncommitted compact-field drafts as well as the previously evaluated inputs.
  byId('visual-arrival').value=saved.compact.arrival;byId('visual-duration').value=saved.compact.duration;
  // An invalid saved draft is still restored; normal validation keeps it stale,
  // rather than substituting the demonstration or claiming a computed result.
  setProductMode('explore');return true;
}
