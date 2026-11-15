import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import {utcMonthWindow} from '../web/coverage.mjs';

// Run from the repository root with Node 24 and Chrome or Chromium.
// Without --fixture, the browser reads the packaged real-data bundle.

const fixture = process.argv.includes('--fixture');
const requireRecovery = process.argv.includes('--require-recovery');
const evaluators = { height: 'evaluateHeights', position: 'evaluatePositions', terrain: 'evaluateTerrainRealizations' };
const requestedStudies = Object.keys(evaluators).filter((study) => process.argv.includes(`--${study}`));
assert(!(fixture && requestedStudies.length), 'Sensitivity studies require packaged real data.');
const workspace = process.cwd();
const browserExecutable = process.env.LUNARIS_CHROME || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'chromium');
const contents = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const beginning = Date.parse('2027-01-01T00:00:00Z') / 1000;
const coverage = [beginning, beginning + 10 * 86400];
const mission = {
  siteId: 'example', nominal: beginning, delayHours: 6, durationHours: 24,
  maxSunHours: 4, maxEarthHours: 6, minJointHours: 7, minContinuousJointHours: null,
  earliest: beginning, latest: beginning + 48 * 3600, gridMinutes: 60, mode: 'same-site',
};
const fixtureBundle = {
  version: 'UI fixture', coverage,
  sites: [{ id: 'example', name: 'Synthetic UI test site', region: 'Fixture', lat: -89.1, lon: 125,
    groundM: 25, heightM: 2, source: 'https://example.com/',
    sun: [[0, 23, 'visible'], [23, 30, 'blocked'], [30, 31, 'uncertain'],
      [31, 90, 'visible'], [90, 91, 'unknown'], [91, 240, 'visible']]
      .map(([start, end, state]) => [beginning + start * 3600, beginning + end * 3600, state]),
    earth: [[coverage[0], coverage[1], 'visible']],
    geometry: Array.from({ length: 500 }, (_, index) => [
      beginning + 900 * index, index % 360, Math.sin(index / 30), 0.2,
      index % 360, Math.cos(index / 30), index % 3 === 0 ? null : 0.6,
    ]),
  }],
  manifest: { visibilityDefinitions: { sunlight: 'Synthetic browser fixture.' } }, demo: mission,
};

const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (fixture && path === '/web/data/bundle.json') {
    response.setHeader('Content-Type', 'application/json');
    return response.end(JSON.stringify(fixtureBundle));
  }
  const file = resolve(workspace, `.${path.endsWith('/') ? `${path}index.html` : path}`);
  if (!file.startsWith(`${workspace}${sep}`)) return response.writeHead(403).end();
  try {
    const content = await readFile(file);
    response.setHeader('Content-Type', contents[extname(file)] ?? 'application/octet-stream');
    response.end(content);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/web/`;
const work = resolve(workspace, 'progress', `ui-${Date.now()}-${process.pid}`);
const downloadPath = resolve(work, 'downloads');
const profile = resolve(work, 'chrome-profile');
await mkdir(downloadPath, { recursive: true });
const browser = spawn(browserExecutable, [
  '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--no-first-run', '--disable-extensions', '--disable-background-networking', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserError;
let browserLog = '';
browser.on('error', (error) => { browserError = error; });
browser.stderr.on('data', (chunk) => { browserLog = `${browserLog}${chunk}`.slice(-2400); });

const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function until(action, attempts = 70) {
  for (let index = 0; index < attempts; index++) {
    const value = await action().catch(() => null);
    if (value) return value;
    await sleep(150);
  }
  throw Error('Timed out waiting for browser prerequisite.');
}

let socket;
try {
  const portText = await until(() => readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).catch(() => {
    throw Error(`Could not start ${browserExecutable}. ${browserError?.message ?? ''} ${browserLog}`);
  });
  const port = portText.split(/\r?\n/)[0];
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  socket = new WebSocket(targets.find((entry) => entry.type === 'page').webSocketDebuggerUrl);
  await new Promise((open) => socket.addEventListener('open', open, { once: true }));
  const callbacks = new Map();
  const requests = [];
  const studyRequests = () => requests.filter((request) => /\/(height\.mjs|scenarios\.mjs|(?:height|position|terrain)-study\.json)$/.test(new URL(request).pathname));
  const requestedStudyData = () => studyRequests().filter((request) => request.endsWith('-study.json'));
  let messageId = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
    const callback = callbacks.get(message.id);
    if (callback) {
      callback(message);
      callbacks.delete(message.id);
    }
  });
  function command(method, params = {}) {
    return new Promise((resolveCommand, rejectCommand) => {
      const id = ++messageId;
      callbacks.set(id, (message) => message.error ? rejectCommand(Error(JSON.stringify(message.error))) : resolveCommand(message.result));
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function browserEval(expression) {
    const reply = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return reply.result.value;
  }
  const viewport = { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false };
  await command('Emulation.setDeviceMetricsOverride', viewport);
  await command('Network.enable');
  await command('Page.setDownloadBehavior', { behavior: 'allow', downloadPath });
  await command('Page.navigate', { url });
  await until(() => browserEval(`Boolean(document.querySelector('#export:not([disabled])'))`));
  // The first-load normal scene must show the illustrative PASS without entering the delay demo.
  if (!fixture) {
    const normal=await browserEval(`(() => {
      const badge=document.querySelector('#story-status');
      return {badge:badge.textContent,hidden:badge.hidden,
        display:getComputedStyle(document.querySelector('.story-outcome')).display,
        delay:document.body.dataset.delayStory,title:document.querySelector('#story-title').textContent};
    })()`);
    assert.equal(normal.badge,'PASS','Normal Mission should show its illustrative PASS');
    assert.equal(normal.hidden,false,'Normal Mission PASS must not be hidden');
    assert.notEqual(normal.display,'none','Normal Mission outcome must be visible');
    assert.equal(normal.delay,'false','Normal Mission must stay separate from the delay demo');
    assert.match(normal.title,/At least/,'Normal Mission keeps its environmental headline');
  }
  await browserEval("document.querySelector('#start-delay-demo')?.click()");
  await browserEval("document.querySelector('#interval-details summary').click()");
  await until(() => browserEval("Boolean(document.querySelector('#interval-table tbody tr'))"));

  const extract = (phase) => browserEval(`(() => {
    const card = document.querySelector('[data-decision=${phase}]');
    if (card.disabled) return null;
    card.click();
    const table = [...document.querySelectorAll('tr[data-constraint]')].map((row) => ({
      id: row.dataset.constraint, metric: row.cells[1].dataset.value, threshold: row.cells[2].dataset.value,
      margin: row.cells[3].dataset.value, status: row.cells[4].textContent,
      witness: { ...row.cells[5].dataset }, witnessText: row.cells[5].textContent,
      witnessSegments: [...row.querySelectorAll('.witness-segments li')].map(({ dataset }) => [Number(dataset.start), Number(dataset.end)]),
      displayedValues: [row.cells[1].firstChild.textContent, row.cells[2].textContent, row.cells[3].textContent],
      witnessTimes: [...row.cells[5].querySelectorAll(':scope > div')].map((time) => time.textContent),
    }));
    const timeline = [...document.querySelectorAll('.timeline-row')].map((row) =>
      [...row.querySelectorAll('.timeline-piece')].map(({ dataset }) => [Number(dataset.start), Number(dataset.end), dataset.state]));
    const intervals = [...document.querySelectorAll('#interval-table tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent));
    const refinement = document.querySelector('#refinement-evidence');
    return { start: Number(card.dataset.start), end: Number(card.dataset.end), status: card.lastChild.textContent,
      table, timeline, intervals, warnings: [...document.querySelectorAll('#warnings li')].map((entry) => entry.textContent),
      refinement: refinement.hidden ? null : { status: refinement.dataset.status, shift: Number(refinement.dataset.shift),
        constraints: [...refinement.querySelectorAll('[data-refinement]')].map((line) => [line.dataset.refinement, Number(line.dataset.shift)]) } };
  })()`);

  const phases = ['nominal', 'delayed', 'recommended'];
  const actual = {};
  for (const phase of phases) actual[phase] = await extract(phase);
  await browserEval("document.querySelector('#export').click()");
  const certificateFile = await until(async () => (await readdir(downloadPath)).find((name) => name.endsWith('.json')));
  const certificate = JSON.parse(await readFile(resolve(downloadPath, certificateFile), 'utf8'));
  const { missionMetrics, feasibilityMatrix } = await import('../web/operations.mjs');
  const exportedBundle = fixture ? fixtureBundle : JSON.parse(await readFile(resolve(workspace,'web/data/bundle.json'),'utf8'));
  // New console evidence is bound to the explicitly exported inspected mission.
  const selectedRecord = ['nominal_result','delayed_result','recommended_result'].map(key=>certificate[key])
    .find(record=>record && record.siteId===certificate.inspected_mission.siteId && record.start===certificate.inspected_mission.start);
  assert(selectedRecord,'Export must identify the inspected decision.');
  assert.deepEqual(certificate.mission_visibility_metrics,
    missionMetrics(selectedRecord,exportedBundle.sites.find(s=>s.id===selectedRecord.siteId)));
  assert.deepEqual(certificate.date_site_comparison,feasibilityMatrix(exportedBundle,certificate.inputs,
    {range:utcMonthWindow(exportedBundle.coverage,certificate.inputs.nominal).range}));
  const metricBounds=await browserEval(`[...document.querySelectorAll('#live-telemetry [data-lower]')].map(n=>[n.dataset.metric,Number(n.dataset.lower),Number(n.dataset.upper)])`);
  for(const [name,lo,hi] of metricBounds) {
    const [channel,key]=name.split('-');assert.deepEqual([lo,hi],certificate.mission_visibility_metrics[channel][key]);
  }
  if (fixture || requireRecovery) assert.deepEqual(phases.map((phase) => actual[phase]?.status), ['PASS', 'FAIL', 'PASS']);
  const asEpoch = (label) => Date.parse(label.replace(' UTC', 'Z').replace(' ', 'T')) / 1000;
  const asHours = (label) => Number(label.replace(' h', '').replace('−', '-').replaceAll(',', ''));
  for (const phase of phases) {
    const tested = actual[phase];
    const expected = certificate[`${phase}_result`];
    assert.equal(Boolean(tested), Boolean(expected), phase);
    if (!tested) continue;
    assert.equal(tested.start, expected.start, `${phase} start`);
    assert.equal(tested.end, expected.end, `${phase} end`);
    assert.equal(tested.status, expected.status, `${phase} status`);
    assert.deepEqual(tested.warnings, [...(expected.scheduleWarnings ?? []), ...expected.coverageWarnings], `${phase} warnings`);
    assert.deepEqual(tested.timeline, ['sun', 'earth', 'joint'].map((channel) => expected.timeline[channel]), `${phase} timeline`);
    assert.deepEqual(tested.intervals.map(([start, end]) => [asEpoch(start), asEpoch(end)]),
      expected.timeline.sun.map(([start, end]) => [start, end]), `${phase} visible interval table dates`);
    if (expected.refinement) {
      assert.equal(tested.refinement.status, expected.refinement.status, `${phase} refinement status`);
      assert.equal(tested.refinement.shift, expected.refinement.maxShiftSeconds, `${phase} refinement shift`);
      assert.deepEqual(tested.refinement.constraints, expected.refinement.constraints.map(({ id, maxShiftSeconds }) => [id, maxShiftSeconds]));
    }
    for (const [index, item] of expected.constraints.entries()) {
      const displayed = tested.table[index];
      assert.equal(displayed.id, item.id, `${phase} constraint id`);
      for (const field of ['metric', 'threshold', 'margin', 'status']) {
        assert.equal(displayed[field], String(item[field] ?? ''), `${phase} ${item.id} ${field}`);
      }
      for (const [position, key] of ['metric', 'threshold', 'margin'].entries()) {
        const shown = displayed.displayedValues[position];
        const exact = item[key];
        if (exact == null) assert.equal(shown, '—');
        else if (shown.includes('<')) assert(Math.abs(exact) < .01 && Math.sign(exact) === (shown.startsWith('−') ? -1 : 1));
        else assert(Math.abs(asHours(shown) - exact) <= .00500001, `${phase} ${item.id} ${key} rounded hours`);
      }
      if (item.witness) {
        assert.equal(Number(displayed.witness.start), item.witness[0]);
        assert.equal(Number(displayed.witness.end), item.witness[1]);
        assert.match(displayed.witnessText, /UTC/);
        const times = displayed.witnessTimes.map((value) => asEpoch(value.replace(/^to /, '')));
        assert(times.every((value, index) => Math.abs(value - item.witness[index]) < .0011), `${phase} displayed witness times`);
      }
      if (item.witnessSegments?.length > 1) assert.deepEqual(displayed.witnessSegments, item.witnessSegments);
    }
  }
  const legendAfter = await browserEval("document.querySelector('#view-earth').click(); document.querySelector('.plot .chart-legend').textContent");
  assert.match(legendAfter, /Earth-center elevation/);
  assert.match(await browserEval("document.querySelector('#probe-output').textContent"), /UTC/);

  const screenshots = process.argv.includes('--screenshots');
  async function screenshot(name) {
    if (!screenshots) return;
    const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(resolve(work, `${name}.png`), Buffer.from(data, 'base64'));
  }

  await browserEval("document.querySelector('#interval-details').open = false; document.querySelector('#reset-demo').click()");
  await screenshot('desktop');
  assert.deepEqual(studyRequests(), [], 'Phase B triggered an unrequested optional study fetch');
  if (requestedStudies.length) {
    const realBundle = JSON.parse(await readFile(resolve(workspace, 'web/data/bundle.json'), 'utf8'));
    const selectedMission = certificate.recommended_result;
    const verified = {};
    await browserEval("document.querySelector('[data-decision=recommended]').click()");
    for (const study of requestedStudies) {
      const requestsBeforeOpen = studyRequests();
      await browserEval(`document.querySelector('#${study}-panel > summary').click()`);
      assert.deepEqual(studyRequests(), requestsBeforeOpen, `Opening the optional ${study} panel triggered a data fetch`);
      await browserEval(`document.querySelector('#run-${study}s').click()`);
      await until(() => browserEval(`Boolean(document.querySelector('#${study}-results:not([hidden])'))`));
      const displayed = await browserEval(`(() => {
        const report = document.querySelector('#${study}-results');
        return { status: report.dataset.robustStatus, scenarios: [...report.querySelectorAll('[data-scenario]')].map((card) => ({
          id: card.dataset.scenario, heightM: Number(card.dataset.height), status: card.dataset.status,
          terrain: card.dataset.latitude ? [Number(card.dataset.latitude), Number(card.dataset.longitude), Number(card.dataset.ground)] : null,
          margins: [...card.querySelectorAll('[data-constraint]')].map(({ dataset }) => [dataset.constraint, Number(dataset.margin)]),
        })) };
      })()`);
      assert(requestedStudyData().some((request) => request.endsWith(`/${study}-study.json`)), 'Expected lazy-load of optional data');
      const module = study === 'height' ? await import('../web/height.mjs') : await import('../web/scenarios.mjs');
      const evaluator = module[evaluators[study]];
      const evidence = JSON.parse(await readFile(resolve(workspace, `web/data/${study}-study.json`), 'utf8'));
      const expected = evaluator(realBundle, evidence, certificate.inputs, selectedMission);
      assert.equal(displayed.status, expected.robust_status);
      assert.deepEqual(displayed.scenarios, expected.scenario_results.map((scenario) => ({
        id: scenario.id, heightM: scenario.heightM, status: scenario.status,
        terrain: Number.isFinite(scenario.lat) ? [scenario.lat, scenario.lon, scenario.groundM] : null,
        margins: scenario.constraints.map(({ id, margin }) => [id, margin]),
      })));
      await browserEval(`document.querySelector('#${study}-panel').scrollIntoView({ block: 'center' })`);
      await screenshot(`${study}-desktop`);
      verified[study] = expected;
      console.log(`${study} study browser parity passed: ${displayed.scenarios.map((scenario) => `${scenario.id} ${scenario.status}`).join(', ')}`);
    }
    assert.deepEqual(requestedStudyData().map((request) => new URL(request).pathname.split('/').at(-1)),
      requestedStudies.map((study) => `${study}-study.json`));

    const nextCertificate = async (label) => {
      const folder = resolve(work, `download-${label}`);
      await mkdir(folder, { recursive: true });
      await command('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: folder });
      await browserEval("document.querySelector('#export').click()");
      const file = await until(async () => (await readdir(folder)).find((name) => name.endsWith('.json')));
      const text = await readFile(resolve(folder, file), 'utf8');
      await writeFile(resolve(work, `${label}-certificate.json`), text);
      return JSON.parse(text);
    };
    const enriched = await nextCertificate('sensitivity');
    if (verified.height) {
      const expected = verified.height;
      assert.deepEqual(enriched.scenario_results, expected.scenario_results);
      assert.deepEqual(enriched.scenario_ids, expected.scenario_ids);
      assert.equal(enriched.robust_status, expected.robust_status);
      assert.equal(enriched.height_study_source_hash, expected.source_hash);
      assert.equal(Date.parse(enriched.height_study_mission_start) / 1000, expected.mission_start);
      assert.equal(Date.parse(enriched.height_study_mission_end) / 1000, expected.mission_end);
      assert.equal(enriched.height_study_inspected_decision, 'recommended');
    } else assert.equal(enriched.height_study_source_hash, undefined);
    for (const study of ['position', 'terrain']) {
      const expected = verified[study];
      const report = enriched[`${study}_study`];
      if (expected) {
        assert.deepEqual(report.scenario_results, expected.scenario_results);
        assert.deepEqual(report.scenario_ids, expected.scenario_ids);
        assert.equal(report.robust_status, expected.robust_status);
        assert.equal(report.source_hash, expected.source_hash);
        assert.equal(Date.parse(report.mission_start) / 1000, expected.mission_start);
        assert.equal(Date.parse(report.mission_end) / 1000, expected.mission_end);
        assert.equal(report.inspected_decision, 'recommended');
      } else assert.equal(report, undefined);
    }
    for (const phase of phases) assert.deepEqual(enriched[`${phase}_result`], certificate[`${phase}_result`]);
    await browserEval("document.querySelector('[data-decision=delayed]').click()");
    for (const study of Object.keys(verified)) {
      assert(await browserEval(`document.querySelector('#${study}-results').hidden`), `A new decision retained stale ${study} evidence`);
    }
    const cleared = await nextCertificate('cleared');
    assert.deepEqual(cleared.scenario_results, certificate.scenario_results);
    assert.equal(cleared.height_study_source_hash, undefined);
    assert.equal(cleared.position_study, undefined);
    assert.equal(cleared.terrain_study, undefined);
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 840, deviceScaleFactor: 1, mobile: false });
    await browserEval("document.querySelector('[data-decision=recommended]').click()");
    for (const study of Object.keys(verified)) {
      await browserEval(`document.querySelector('#run-${study}s').click()`);
      await until(() => browserEval(`Boolean(document.querySelector('#${study}-results:not([hidden])'))`));
      await browserEval(`document.querySelector('#${study}-panel').scrollIntoView({ block: 'center' })`);
      await screenshot(`${study}-mobile`);
      assert(await browserEval('document.documentElement.scrollWidth <= innerWidth'), `${study} cards overflow the mobile viewport`);
      await browserEval(`document.querySelector('#${study}-panel').open = false`);
    }
    await browserEval('scrollTo(0, 0)');
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 840, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await screenshot('mobile');
  const overflow = await browserEval(`({ viewport: innerWidth, document: document.documentElement.scrollWidth,
    wide: [...document.querySelectorAll('*')].map((node) => [node.className?.baseVal ?? node.className, node.getBoundingClientRect().right]).filter(([, right]) => right > innerWidth + 3).slice(0, 15) })`);
  assert(overflow.document <= overflow.viewport, JSON.stringify(overflow));
  await browserEval("document.querySelector('#delay').value = 1; document.querySelector('#delay').dispatchEvent(new Event('input', { bubbles: true }));");
  assert(await browserEval("document.querySelector('#export').disabled"));
  await browserEval("document.querySelector('#evaluate').click()");
  assert(await browserEval("!document.querySelector('#export').disabled"));
  await browserEval(`(() => {
    const earliest = document.querySelector('#earliest');
    earliest.value = '2030-01-01T00:00:00';
    earliest.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#evaluate').click();
    document.querySelector('[data-decision=nominal]').click();
  })()`);
  assert.match(await browserEval("document.querySelector('#form-status').textContent"), /earliest allowable start/);
  assert(await browserEval("document.querySelector('#export').disabled"));
  assert(await browserEval("document.querySelector('#run-heights').disabled"),
    'Rejected input allowed a new sensitivity report for the previous result');
  if (!fixture) {
    const coverageData=JSON.parse(await readFile(resolve(workspace,'web/data/bundle.json'),'utf8'));
    const utcInput=seconds=>new Date(seconds*1000).toISOString().slice(0,19);
    await browserEval(`(() => {
      document.querySelector('#reset-demo').click();
      const duration = document.querySelector('#duration');
      duration.value = '1e-20';
      duration.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#evaluate').click();
    })()`);
    assert.match(await browserEval("document.querySelector('#form-status').textContent"), /timestamp resolution/);
    assert(await browserEval("document.querySelector('#export').disabled"));
    await browserEval(`(() => {
      document.querySelector('#reset-demo').click();
      document.querySelector('#nominal').value = ${JSON.stringify(utcInput(coverageData.coverage[1]-7200))};
      document.querySelector('#latest').value = ${JSON.stringify(utcInput(coverageData.coverage[1]+86400))};
      document.querySelector('#delay').value = 0;
      document.querySelector('#evaluate').click();
      document.querySelector('[data-decision=nominal]').click();
    })()`);
    assert.equal(await browserEval("document.querySelector('[data-decision=nominal] .decision-status').textContent"),
      'INDETERMINATE');
    assert.match(await browserEval("document.querySelector('#warnings').textContent"), /outside the cached visibility dates/);
    const data = JSON.parse(await readFile(resolve(workspace, 'web/data/bundle.json'), 'utf8'));
    const { runMission } = await import('../web/engine.mjs');
    const nominal = Date.parse('2026-11-06T12:02:00Z') / 1000;
    const { delayTolerance } = runMission(data, { ...data.demo, nominal, delayHours: 0 });
    assert.equal(delayTolerance.kind, 'lower-bound');
    const endpoint = new Date(delayTolerance.until * 1000).toISOString().replace('T', ' ').replace('Z', ' UTC');
    await browserEval(`(() => {
      document.querySelector('#solar-demo').click();
      document.querySelector('#nominal').value = '2026-11-06T12:02:00';
      document.querySelector('#delay').value = 0;
      document.querySelector('#evaluate').click();
    })()`);
    const summary = await browserEval("document.querySelector('#decision-summary').textContent");
    assert(summary.includes(`Feasible through ${endpoint}`), summary);
    assert.doesNotMatch(summary, /At least \d+(\.\d+)? h/, 'A rounded duration can overstate the lower bound');
  }
  if (!fixture) {
    await browserEval("document.querySelector('#communication-demo').click()");
    const compared = await browserEval(`({cards: [...document.querySelectorAll('#site-comparison article')].map(n=>n.dataset.site),
      earth:document.querySelector('#max-earth').value,joint:document.querySelector('#min-total').value,
      states:[...document.querySelectorAll('[data-decision] .decision-status')].map(n=>n.textContent),
      text:document.querySelector('#visibility-overview').textContent})`);
    const currentBundle=JSON.parse(await readFile(resolve(workspace,'web/data/bundle.json'),'utf8'));
    assert.equal(compared.cards.length,currentBundle.sites.length); assert.equal(new Set(compared.cards).size,currentBundle.sites.length);
    assert.equal(compared.earth,'2'); assert.equal(compared.joint,'6');
    assert.deepEqual(compared.states,['PASS','FAIL','PASS']);
    assert.match(compared.text,/Next established loss/); assert.match(compared.text,/cache/);
    const {compareSites,visibilitySummary}=await import('../web/overview.mjs');
    const {communicationDemo}=await import('../web/overview.mjs');
    const b=JSON.parse(await readFile(resolve(workspace,'web/data/bundle.json'),'utf8'));
    const rows=compareSites(b,communicationDemo(b));
    const visible=await browserEval(`[...document.querySelectorAll('#site-comparison [data-visible-seconds]')].map(n=>[n.closest('article').dataset.site,n.dataset.phase,n.dataset.channel,Number(n.dataset.visibleSeconds)])`);
    for(const [site,phase,channel,seconds] of visible) {
      const m=rows.find(r=>r.siteId===site)[phase];
      assert.equal(seconds,visibilitySummary(m.timeline[channel],m.start,m.end).seconds.visible);
    }
    await screenshot('communications-comparison-mobile');
    assert(await browserEval('document.documentElement.scrollWidth <= innerWidth'));
    const prior=await browserEval("document.querySelector('#probe-slider').focus(); Number(document.querySelector('#probe-slider').value)");
      await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
      await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
      assert.equal(await browserEval("Number(document.querySelector('#probe-slider').value)"),prior+1);
      const sky=await browserEval(`({time:Number(document.querySelector('#local-sky').dataset.time),metrics:[...document.querySelectorAll('#local-sky .sky-metric')].map(n=>[n.dataset.target,Number(n.dataset.azimuth),Number(n.dataset.elevation)]),text:document.querySelector('#local-sky').textContent})`);
      const geometry=b.sites.find(s=>s.id===communicationDemo(b).siteId).geometry.find(r=>r[0]===sky.time);
      assert(geometry);assert.deepEqual(sky.metrics,[['sun',((geometry[1]%360)+360)%360,geometry[2]],['earth',((geometry[4]%360)+360)%360,geometry[5]]]);
      assert.match(sky.text,/Mission refinement/);assert.match(sky.text,/schematic/);
      await browserEval("document.querySelector('#local-sky').scrollIntoView({block:'center'})");
      await screenshot('local-sky-mobile');
      assert(await browserEval('document.documentElement.scrollWidth <= innerWidth'));
      console.log('Comparison parity, binding communication demo and keyboard-synchronized sky passed.');
  }
  if(!fixture) {
    await browserEval("document.querySelector('#reset-demo').click();document.querySelector('[data-decision=nominal]').click()");
    const b=JSON.parse(await readFile(resolve(workspace,'web/data/bundle.json'),'utf8'));
    await until(()=>browserEval(`document.querySelectorAll('.atlas-site-button').length===${b.sites.length}`));
    const {communicationDemo:defaultJointDemo}=await import('../web/overview.mjs');
    const matrixInputs=defaultJointDemo(b);
    const matrix=feasibilityMatrix(b,matrixInputs,{range:utcMonthWindow(b.coverage,matrixInputs.nominal).range});
    const matrixCells=await browserEval(`[...document.querySelectorAll('.feasibility-cell')].map(n=>[n.dataset.site,Number(n.dataset.start),n.dataset.status])`);
    assert.deepEqual(matrixCells,matrix.rows.flatMap(row=>row.cells.map(m=>[row.siteId,m.start,m.status])));
    assert.equal(matrixCells.length,30*b.sites.length,'The November calendar retains all daily starts for every actual site.');
    const playheadStyle=await browserEval("(()=>{const s=getComputedStyle(document.querySelector('.timeline-playhead'));return {position:s.position,width:parseFloat(s.width)}})()");
    assert.equal(playheadStyle.position,'absolute');assert(playheadStyle.width>=1,'Timeline playhead must be visible.');
    const raceFolder=resolve(work,'export-race');await mkdir(raceFolder,{recursive:true});
    await command('Page.setDownloadBehavior',{behavior:'allow',downloadPath:raceFolder});
    const capturedTime=await browserEval("Number(document.querySelector('#local-sky').dataset.time)");
    await browserEval(`document.querySelector('#export').click();document.querySelector('#site').value='${b.sites[0].id}';document.querySelector('#nominal').value='2026-11-02T00:00:00';document.querySelector('#evaluate').click()`);
    const raceFile=await until(async()=>(await readdir(raceFolder)).find(name=>name.endsWith('.json')));
    const raceCertificate=JSON.parse(await readFile(resolve(raceFolder,raceFile),'utf8'));
    assert.equal(raceCertificate.inputs.siteId,b.demo.siteId);
    assert.deepEqual(raceCertificate.date_site_comparison,matrix);
    assert.equal(raceCertificate.display_inspection.sample_utc,capturedTime);
    assert.deepEqual(raceCertificate.display_inspection.sample,b.sites.find(s=>s.id===b.demo.siteId).geometry.find(row=>row[0]===capturedTime));
    await browserEval("document.querySelector('#reset-demo').click();document.querySelector('[data-decision=nominal]').click()");
    const priorSite=await browserEval("document.querySelector('#site').value");
    await browserEval("document.querySelector('#explore-lat').value=-89;document.querySelector('#explore-lon').value=45;document.querySelector('#coordinate-form').requestSubmit()");
    assert.match(await browserEval("document.querySelector('#coordinate-feedback').textContent"),/Unsupported terrain-aware calculation/);
    assert.equal(await browserEval("document.querySelector('#site').value"),priorSite);
    await browserEval("document.querySelector('.atlas-site-button').click()");
    assert.equal(await browserEval("document.querySelector('#site').value"),b.sites[0].id);
    await browserEval("document.querySelector('#reset-demo').click();document.querySelector('[data-decision=nominal]').click()");
    const timeBefore=await browserEval("Number(document.querySelector('#local-sky').dataset.time)");
    await browserEval("document.querySelector('#sky-speed').value=48;document.querySelector('#sky-play').click()");
    await until(()=>browserEval(`Number(document.querySelector('#local-sky').dataset.time)>${timeBefore}`));
    await browserEval("document.querySelector('#sky-pause').click()");
    const paused=await browserEval("Number(document.querySelector('#local-sky').dataset.time)");await sleep(100);
    assert.equal(await browserEval("Number(document.querySelector('#local-sky').dataset.time)"),paused);
    assert.match(await browserEval("document.querySelector('#playback-status').textContent"),/Paused/);
    await browserEval("document.querySelector('#time-scope').value='coverage';document.querySelector('#time-scope').dispatchEvent(new Event('change'))");
    const jump='2026-11-20T10:10:00';
    await browserEval(`document.querySelector('#sky-jump').value='${jump}';document.querySelector('#sky-jump-go').click()`);
    const sampleTime=Date.parse('2026-11-20T10:00:00Z')/1000;
    assert.equal(await browserEval("Number(document.querySelector('#local-sky').dataset.time)"),sampleTime);
    assert(await browserEval("[...document.querySelectorAll('.timeline-playhead')].every(n=>n.hidden)"));
    await browserEval(`document.querySelector('#sky-jump').value=${JSON.stringify(new Date(b.coverage[1]*1000).toISOString().slice(0,19))};document.querySelector('#sky-jump-go').click()`);
    assert.match(await browserEval("document.querySelector('#playback-status').textContent"),/outside/);
    assert.equal(await browserEval("Number(document.querySelector('#local-sky').dataset.time)"),sampleTime);
    await browserEval("document.querySelector('#probe-slider').value=document.querySelector('#probe-slider').max;document.querySelector('#probe-slider').dispatchEvent(new Event('input'))");
    assert.equal(await browserEval("Number(document.querySelector('#local-sky').dataset.time)"),b.coverage[1]-1800);
    await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert(await browserEval("getComputedStyle(document.querySelector('.figure'),'::before').animationName==='none'"),'Reduced motion must stop decorative star drift.');
    await command('Emulation.setDeviceMetricsOverride',viewport);
    await browserEval("document.querySelector('#time-scope').value='mission';document.querySelector('#time-scope').dispatchEvent(new Event('change'));document.querySelector('#console').scrollIntoView({block:'start'})");
    await screenshot('mission-control-desktop');
    await browserEval("document.querySelector('#atlas').scrollIntoView({block:'start'})");await screenshot('terrain-atlas-desktop');
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:840,deviceScaleFactor:1,mobile:false});
    await browserEval("document.querySelector('#console').scrollIntoView({block:'start'})");await screenshot('mission-control-mobile');
    assert(await browserEval('document.documentElement.scrollWidth<=innerWidth'));
    console.log(`Mission console playback/pause, UTC domain censoring, atlas selection/unsupported input, all ${30*b.sites.length} November heatmap cells, metric/export parity and reduced motion passed.`);
  }
  const appOrigin = new URL(url).origin;
  assert.deepEqual(requests.filter((resource) => /^https?:/.test(resource) && new URL(resource).origin !== appOrigin), []);
  console.log(`T14 ${fixture ? 'synthetic UI fixture' : 'real-data dashboard'} passed in headless Chrome. Results: ${phases.map((phase) => actual[phase]?.status ?? 'no recommendation').join(' / ')}. Evidence: ${work}`);
} finally {
  socket?.close();
  browser.kill();
  server.close();
}
