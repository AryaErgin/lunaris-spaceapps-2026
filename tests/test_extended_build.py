import importlib
import json
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

import numpy as np
import pytest

from science import build


def epoch(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp())


def extended():
    try:
        return importlib.import_module('science.extended')
    except ModuleNotFoundError:
        pytest.fail('Implement the checked monthly extension builder')


def test_calendar_partition_preserves_partial_edges_and_leap_february():
    module = extended()
    begin, end = epoch('2027-12-31'), epoch('2028-03-01')
    assert module.calendar_periods(begin, end) == [
        (begin, epoch('2028-01-01')), (epoch('2028-01-01'), epoch('2028-02-01')),
        (epoch('2028-02-01'), end),
    ]
    for a, b in [(1, 1), (2, 1), (0.5, 5), (float('nan'), 4)]:
        with pytest.raises(ValueError):
            module.calendar_periods(a, b)


def test_month_stitch_retains_continuous_outages_and_uncertain_boundaries():
    module = extended()
    pieces = [[[0, 5, 'visible'], [5, 10, 'blocked']],
              [[10, 13, 'blocked'], [13, 14, 'uncertain'], [14, 20, 'visible']]]
    assert module.stitch_intervals(pieces, 0, 20) == [
        [0, 5, 'visible'], [5, 13, 'blocked'], [13, 14, 'uncertain'], [14, 20, 'visible']]
    for bad in [[[[0, 9, 'visible']], [[10, 20, 'visible']]],
                [[[0, 11, 'visible']], [[10, 20, 'visible']]],
                [[[0, 20, 'made-up']]], [[[0, float('nan'), 'unknown']]]]:
        with pytest.raises(ValueError):
            module.stitch_intervals(bad, 0, 20)


def test_month_geometry_splice_checks_shared_epoch_and_never_interpolates_missing_rows():
    module = extended()
    row = lambda t: [t, 10, 1, 0, 20, 2, 0]
    assert module.stitch_geometry([[row(0), row(1800)], [row(1800), row(3600)]], 0, 3600) == [row(0), row(1800), row(3600)]
    mismatch = row(1800); mismatch[1] = 11
    for parts in [[[row(0), row(1800)], [mismatch, row(3600)]], [[row(0), row(3600)]]]:
        with pytest.raises(ValueError):
            module.stitch_geometry(parts, 0, 3600)


def test_site_builder_reuses_actual_coarse_and_fine_skylines_for_explicit_period(monkeypatch):
    info = {'groundM': 2., 'observerRadiusM': 1737404., 'farBoundBins': 0}
    sky = SimpleNamespace(info=info, lower=np.array([-1., -1.]), upper=np.array([1., 1.]),
                          nominal=np.array([0., 0.]), gap=np.array([-90., -90.]), blockers=np.full((2, 4), np.nan))
    calls = []

    class FakeVisibility:
        def __init__(self, *args):
            self.max_sampled_rate = {'sun': .01, 'earth': .001}

        def cache(self, times, *, measure=False):
            times = list(times); calls.append(('cache', times[0], times[-1], measure))

        def intervals(self, target, skyline, start, end, **kwargs):
            calls.append((target, skyline is sky, start, end, kwargs))
            return [[start, end, 'visible']]

        def plot_samples(self, skyline, start, end):
            return [[start, 0, 1, 0, 0, 1, 0], [end, 0, 1, 0, 0, 1, 0]]

    def unexpected_scan(*args, **kwargs):
        pytest.fail('Precomputed coarse/fine models must not be scanned again per month')

    monkeypatch.setattr(build, 'Visibility', FakeVisibility)
    monkeypatch.setattr(build, 'build_skyline', unexpected_scan)
    result = build._site(None, None, ('x', 'Point', 'Region', -89., 20., 'Site01'),
                         start=100000, end=100120, skylines=(sky, sky))
    assert result['sun'] == [[100000, 100120, 'visible']]
    assert result['geometry'][0][0] == 100000
    assert result['geometry'][-1][0] == 100120
    assert ('cache', 100000, 100120, True) in calls
    assert result['groundM'] == 2


def test_bundle_fingerprinting_is_idempotent_for_staging_then_final_output(tmp_path):
    value = {'manifest': {'engineCommit': 'example'}, 'coverage': [0, 10], 'sites': []}
    first, second = tmp_path / 'staged.json', tmp_path / 'final.json'
    build._write_bundle(value, first)
    build._write_bundle(value, second)
    assert first.read_bytes() == second.read_bytes(), 'Staging must not hash a previous fingerprint into the payload'


def test_reused_terrain_cache_checks_computed_array_payload_not_only_identity(tmp_path, monkeypatch):
    module = extended()
    calls = []

    def scan(raw, tile, lat, lon, height, *, count, **kwargs):
        calls.append(count)
        return SimpleNamespace(lower=np.full(count, -1.), upper=np.full(count, 1.),
            nominal=np.zeros(count), gap=np.full(count, -90.), blockers=np.full((count, 4), np.nan), far_cap=-1.,
            info={'observerRadiusM': 1737402., 'groundM': 0.})

    monkeypatch.setattr(module, 'build_skyline', scan)
    row = ('x', 'Point', 'Region', -89., 20., 'Site01')
    hashes = {'Site01_final_adj_5mpp_surf.tif': 'a'*64, 'LDEM_80S_80MPP_ADJ.TIF': 'b'*64}
    first, signature = module.cached_skylines(None, row, 2., None, tmp_path, hashes)
    second, same = module.cached_skylines(None, row, 2., None, tmp_path, hashes)
    assert signature == same and calls == [1800, 3600]
    np.testing.assert_array_equal(first[1].lower, second[1].lower)
    path = next(tmp_path.glob('*.npz'))
    with np.load(path, allow_pickle=False) as archive:
        content = {key: archive[key].copy() for key in archive.files}
    content['fine_lower'][0] = 4.
    np.savez_compressed(path, **content)
    with pytest.raises(ValueError, match='payload|checksum|fingerprint'):
        module.cached_skylines(None, row, 2., None, tmp_path, hashes)


def test_extended_reports_require_same_observer_targets_and_full_date_domain(tmp_path):
    module = extended()
    start, end = epoch('2026-11-01'), epoch('2028-01-01')
    site = {'id': 'x', 'lat': -89., 'lon': 20., 'heightM': 2., 'groundM': 100., 'referenceRadiusM': 1737400.}
    domain = {'status': 'PASS', 'start_utc': '2026-11-01T00:00:00Z', 'end_utc': '2028-01-01T00:00:00Z',
              'frame': 'MOON_ME_DE440_ME421', 'correction': 'CN+S',
              'sites': [{'site_id': 'x', 'latitude_deg': -89., 'longitude_deg_east': 20., 'observer_radius_m': 1737502., 'status': 'PASS'}]}
    horizons = {'status': 'PASS', 'references': [
        {'site_id': 'x', 'target': target, 'latitude_deg': -89., 'longitude_deg_east': 20., 'observer_radius_m': 1737502.,
         'samples': [{'utc': '2026-11-01T00:00:00Z'}, {'utc': '2028-01-01T00:00:00Z'}]}
        for target in ('sun', 'earth')]}
    a, b = tmp_path / 'domain.json', tmp_path / 'horizons.json'

    def write(d, h):
        a.write_text(json.dumps(d)); b.write_text(json.dumps(h))

    write(domain, horizons)
    module._validated_reports(a, b, start, end, [site])
    changed = deepcopy(domain); changed['sites'][0]['observer_radius_m'] += 20
    write(changed, horizons)
    with pytest.raises(ValueError, match='observer'):
        module._validated_reports(a, b, start, end, [site])
    changed = deepcopy(horizons); changed['references'] = changed['references'][:1]
    write(domain, changed)
    with pytest.raises(ValueError, match='target'):
        module._validated_reports(a, b, start, end, [site])
    changed = deepcopy(horizons)
    changed['references'][1]['samples'] = changed['references'][1]['samples'][:1]
    write(domain, changed)
    with pytest.raises(ValueError, match='date|epoch'):
        module._validated_reports(a, b, start, end, [site])
