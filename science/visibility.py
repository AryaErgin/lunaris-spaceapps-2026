"""Conservative interval extraction with angular motion and terrain enclosures."""

from math import asin, cos, floor, radians, sin

import numpy as np

from science.ephemerides import azimuth_elevation

# Model domain is restricted to November 2026. Bounds allow for lunar
# rotation plus target inertial motion, parallax and reception corrections.
RATE_DEG_PER_S = 0.03 / 60
EARTH_RADIUS_MIN_KM = 6356.75
EARTH_RADIUS_MAX_KM = 6378.137
ANGULAR_PADDING_DEG = 0.00001


def _add(result, start, end, state):
    if result and result[-1][1] == start and result[-1][2] == state:
        result[-1][1] = end
    else:
        result.append([start, end, state])


def sector_bounds(azimuth, width, low, high, gap):
    bins = len(low)
    if width >= 180:
        return float(low.min()), float(high.max()), float(gap.max())
    begin = floor((azimuth - width) * bins / 360)
    final = floor((azimuth + width) * bins / 360)
    if begin == final:
        i = begin % bins
        return float(low[i]), float(high[i]), float(gap[i])
    index = np.arange(begin, final + 1) % bins
    return float(low[index].min()), float(high[index].max()), float(gap[index].max())


def _separation(sun, earth):
    u, v = np.asarray(sun), np.asarray(earth)
    product = np.sum(u * v, axis=-1)
    return np.rad2deg(np.arctan2(np.linalg.norm(np.cross(u, v), axis=-1), product))


def earth_occultation(sun, earth, radius_km=EARTH_RADIUS_MAX_KM):
    """Positive if the Sun center misses the Earth bounding disc."""
    return _separation(sun, earth) - np.rad2deg(np.arcsin(radius_km / np.linalg.norm(earth, axis=-1)))


class Visibility:
    def __init__(self, ephemeris, lat, lon, observer_radius):
        self.ephemeris = ephemeris
        self.observer = (lat, lon, observer_radius)
        self.samples = {}
        self.max_sampled_rate = {"sun": 0., "earth": 0.}

    def cache(self, timestamps, *, measure=False):
        missing = sorted(set(timestamps) - self.samples.keys())
        if not missing:
            return
        sun, earth = self.ephemeris.vectors(*self.observer, missing)
        if measure:
            for key, vectors in (("sun", sun), ("earth", earth)):
                rate = _separation(vectors[:-1], vectors[1:]) / np.diff(missing)
                self.max_sampled_rate[key] = float(rate.max(initial=0) * 60)
                if self.max_sampled_rate[key] >= RATE_DEG_PER_S * 60:
                    raise ValueError(f"{key} exceeded model angular rate")
        azsun, elsun = azimuth_elevation(sun)
        azearth, elearth = azimuth_elevation(earth)
        occ_outer = earth_occultation(sun, earth)
        occ_inner = earth_occultation(sun, earth, EARTH_RADIUS_MIN_KM)
        for i, epoch in enumerate(missing):
            self.samples[epoch] = (azsun[i], elsun[i], azearth[i], elearth[i], occ_outer[i], occ_inner[i])

    def interval_status(self, target, sky, midpoint, half_width):
        if midpoint not in self.samples:
            self.cache([midpoint])
        azsun, elsun, azearth, elearth, outer, inner = self.samples[midpoint]
        azimuth, elevation = (azsun, elsun) if target == "sun" else (azearth, elearth)
        cone = RATE_DEG_PER_S * half_width + ANGULAR_PADDING_DEG
        # The apparent Earth disc radius changes much more slowly than its
        # center: even 2 km/s at 350,000 km is <0.000006°/s in radius.
        eclipse_band = 2 * cone + 0.000006 * half_width
        if target == "sun" and inner < -eclipse_band:
            return "blocked"
        eclipse_excluded = target == "earth" or outer > eclipse_band
        cos_el = cos(radians(elevation))
        az_cone = 180. if abs(elevation) + cone >= 90 else np.degrees(asin(min(1., sin(radians(cone)) / cos_el)))
        lower, upper, gap = sector_bounds(azimuth, az_cone, sky.lower, sky.upper, sky.gap)
        if elevation + cone < lower:
            return "blocked"
        if elevation - cone > max(upper, sky.far_cap, gap) and eclipse_excluded:
            return "visible"
        # If only a potentially blocking DEM void prevents the nominal
        # proof, allow finer cone refinement to separate its boundary.
        if gap > max(upper, sky.far_cap) and half_width <= 5:
            return "unknown"
        return None

    def intervals(self, target, sky, start, end, *, step, terminal):
        # Batching the full dyadic midpoint tree keeps the expensive SPICE
        # calculation vector-friendly. The interval walk still stops early
        # when the direction cone proves the entire parent interval.
        work = [(left, min(left + step, end)) for left in range(start, end, step)]
        result = []
        while work:
            self.cache([(left + right) / 2 for left, right in work])
            ambiguous = []
            for left, right in work:
                state = self.interval_status(target, sky, (left + right) / 2, (right - left) / 2)
                if state is None and right - left > terminal:
                    mid = (left + right) // 2
                    ambiguous.extend(((left, mid), (mid, right)))
                else:
                    result.append((left, right, state or "uncertain"))
            work = ambiguous
        merged = []
        for left, right, state in sorted(result):
            _add(merged, left, right, state)
        return merged

    def plot_samples(self, sky, start, end, step=1800):
        epochs = list(range(start, end, step)) + [end]
        self.cache(epochs)
        rows = []
        bins = len(sky.nominal)
        for epoch in epochs:
            azsun, elsun, azearth, elearth, _, _ = self.samples[epoch]
            heights = [sky.nominal[floor(az * bins / 360) % bins] for az in (azsun, azearth)]
            hsun, hearth = [round(float(value), 5) if np.isfinite(value) else None for value in heights]
            rows.append([epoch, round(azsun, 5), round(elsun, 5), hsun,
                         round(azearth, 5), round(elearth, 5), hearth])
        return rows


def combine_refinements(coarse, fine):
    """Keep a definite state only where both numerical evaluations agree."""
    i = j = 0
    result = []
    while i < len(coarse) and j < len(fine):
        left, right, former = coarse[i]
        start, end, latest = fine[j]
        shared_left, shared_right = max(left, start), min(right, end)
        if shared_left < shared_right:
            if former == latest:
                state = latest
            elif "unknown" in (former, latest):
                state = "unknown"
            else:
                state = "uncertain"
            _add(result, shared_left, shared_right, state)
        i += right <= end
        j += end <= right
    return result


def longest_blocked_bounds(intervals):
    lower = upper = run = 0
    for start, end, state in intervals:
        if state == "blocked":
            lower = max(lower, end - start)
        run = 0 if state == "visible" else run + end - start
        upper = max(upper, run)
    return lower, upper
