import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

// Run from the repository root with Node 24 and Chrome or Chromium.
// Without --fixture, the browser reads the packaged real-data bundle.

const fixture = process.argv.includes('--fixture');
const requireRecovery = process.argv.includes('--require-recovery');
const workspace = process.cwd();
const browserExecutable = process.env.LUNARIS_CHROME || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'chromium');
const contents = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
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
const work = resolve(workspace, 'progress', `ui-${Date.now()}`);
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
    const { writeFile } = await import('node:fs/promises');
    await writeFile(resolve(work, `${name}.png`), Buffer.from(data, 'base64'));
  }

  await browserEval("document.querySelector('#interval-details').open = false; document.querySelector('#reset-demo').click()");
  await screenshot('desktop');
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
  const appOrigin = new URL(url).origin;
  assert.deepEqual(requests.filter((resource) => /^https?:/.test(resource) && new URL(resource).origin !== appOrigin), []);
  console.log(`T14 ${fixture ? 'synthetic UI fixture' : 'real-data dashboard'} passed in headless Chrome. Results: ${phases.map((phase) => actual[phase]?.status ?? 'no recommendation').join(' / ')}. Evidence: ${work}`);
} finally {
  socket?.close();
  browser.kill();
  server.close();
}
