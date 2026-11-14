from types import SimpleNamespace

import numpy as np

from science.visibility import Visibility, earth_occultation, sector_bounds


def test_t13_narrow_double_crossing_with_equal_sign_endpoints():
    class SyntheticEphemeris:
        def vectors(self, lat, lon, radius, epochs):
            elevation = np.deg2rad((np.abs(np.asarray(epochs) - 37) - 3) * 0.00045)
            sun = np.column_stack([np.zeros(len(epochs)), np.cos(elevation), np.sin(elevation)]) * 1.5e8
            earth = np.repeat([[370000., 0., 0.]], len(epochs), axis=0)
            return sun, earth

    skyline = SimpleNamespace(lower=np.zeros(360), upper=np.zeros(360), gap=np.full(360, -90.), far_cap=-90.)
    visibility = Visibility(SyntheticEphemeris(), -89., 1., 1_737_402.)
    intervals = visibility.intervals("sun", skyline, 0, 100, step=100, terminal=1)
    assert any(left <= 37 < right and state == "blocked" for left, right, state in intervals)
    assert intervals[0][2] == intervals[-1][2] == "visible"
    assert any(state == "uncertain" for _, _, state in intervals)


def test_t13_sun_center_earth_occultation_uses_topocentric_disk():
    sun = np.array([0., 1.5e8, 0.])
    earth = np.array([0., 370000., 0.])
    assert earth_occultation(sun, earth) < -0.95
    assert earth_occultation(sun, np.array([370000., 0., 0.])) > 89


def test_t06_time_footprint_crosses_wrap_and_contains_narrow_ridge():
    low = np.full(360, -2.)
    high = np.full(360, -1.)
    gap = np.full(360, -90.)
    high[-1] = 8.
    assert sector_bounds(0.2, 0.4, low, high, gap) == (-2, 8, -90)


def test_epoch_cache_stores_one_direction_pair_per_epoch():
    class ConstantEphemeris:
        def vectors(self, lat, lon, radius, epochs):
            sun = np.repeat([[0., 1.5e8, 0.]], len(epochs), axis=0)
            earth = np.repeat([[370000., 0., 0.]], len(epochs), axis=0)
            return sun, earth

    visibility = Visibility(ConstantEphemeris(), -89., 1., 1_737_402.)
    visibility.cache([0, 30, 60], measure=True)
    assert set(visibility.samples) == {0, 30, 60}
    assert visibility.samples[60][:4] == (0., 0., 90., 0.)
