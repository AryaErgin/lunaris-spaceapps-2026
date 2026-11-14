import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackSamples, nearestSample, transitionCountdown, terrainClearance } from '../web/playback.mjs';

const site = { geometry: [0, 1800, 3600, 5400, 7200].map(t => [t, 359, 2, 1, 90, -1, 0]) };
test('playback clips sampled geometry to half-open mission or cache without inventing endpoints', () => {
  assert.deepEqual(playbackSamples(site, {start: 900, end: 5400}, [0, 7200], 'mission').map(r => r[0]), [1800,3600]);
  assert.deepEqual(playbackSamples(site, {start: 900, end: 5400}, [0,7200], 'coverage').map(r => r[0]), [0,1800,3600,5400]);
  assert.deepEqual(playbackSamples(site, {start: 8000, end: 9000}, [0,7200], 'mission'), []);
});
test('date jumping chooses a real nearest sample, earlier on ties, and refuses outside domain', () => {
  assert.equal(nearestSample(site.geometry, 2600, [0,7200]), 1);
  assert.equal(nearestSample(site.geometry, 2700, [0,7200]), 1);
  assert.equal(nearestSample(site.geometry, 7200, [0,7200]), null);
  assert.equal(nearestSample([], 2, [0,10]), null);
  assert.equal(nearestSample(site.geometry, -1, [0,7200]), null);
});
test('transition countdown exposes numeric bracket only for resolved corresponding events', () => {
  const events = {loss:[110,150], reacquisition:null, unresolved:[]};
  assert.deepEqual(transitionCountdown(events, 'loss',100), {kind:'bounded',remaining:[10,50],interval:[110,150]});
  assert.deepEqual(transitionCountdown(events, 'loss',120).remaining,[0,30]);
  assert.equal(transitionCountdown({...events,unresolved:['loss']},'loss',100).kind,'unresolved');
  assert.equal(transitionCountdown(events,'reacquisition',100).kind,'unavailable');
  assert.equal(transitionCountdown(events,'loss',160).kind,'unavailable');
});
test('clearance is center elevation minus terrain trace and missing terrain remains unknown', () => {
  assert.equal(terrainClearance(site.geometry[0], 'sun'),1);
  assert.equal(terrainClearance(site.geometry[0], 'earth'),-1);
  assert.equal(terrainClearance([0,10,2,null,20,3,1], 'sun'),null);
});
