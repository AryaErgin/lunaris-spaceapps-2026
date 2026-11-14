// Display navigation only. All positions remain actual cached geometry rows.
export function playbackSamples(site, mission, coverage, scope = 'mission') {
  const lo = scope === 'coverage' ? coverage[0] : Math.max(coverage[0], mission.start);
  const hi = scope === 'coverage' ? coverage[1] : Math.min(coverage[1], mission.end);
  return (site.geometry ?? []).filter(row => row[0] >= lo && row[0] < hi);
}

export function nearestSample(samples, time, domain) {
  if (!Number.isFinite(time) || time < domain[0] || time >= domain[1] || !samples.length) return null;
  let index = null, distance = Infinity;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i][0] < domain[0] || samples[i][0] >= domain[1]) continue;
    const candidate = Math.abs(samples[i][0] - time);
    if (candidate < distance) { index = i; distance = candidate; }
  }
  return index;
}

export function transitionCountdown(events, key, instant) {
  const interval = events?.[key];
  if (!interval || interval[1] < instant) return { kind: 'unavailable' };
  if (events.unresolved?.includes(key) || interval[1] - interval[0] >= 120) {
    return { kind: 'unresolved', interval };
  }
  return { kind: 'bounded', interval, remaining: interval.map(t => Math.max(0, t - instant)) };
}

export function terrainClearance(sample, target) {
  const [elevation, horizon] = target === 'sun' ? [2,3] : [5,6];
  return Number.isFinite(sample[elevation]) && Number.isFinite(sample[horizon])
    ? sample[elevation] - sample[horizon] : null;
}
