"""Adversarial expansion acceptance fixtures; no downloads or raw DEMs."""
import importlib
import json
from copy import deepcopy
from datetime import UTC, datetime
from hashlib import sha256
from types import SimpleNamespace

import numpy as np
import pytest


def module():
    return importlib.import_module('science.southpole_validation')


def fingerprint(value):
    value = deepcopy(value)
    value['manifest'] = {}
    digest = sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    value['manifest'] = {'bundleSha256': digest, 'bundleHashConvention': 'test'}
    return value


@pytest.fixture
def expansion():
    start = int(datetime(2026, 11, 1, tzinfo=UTC).timestamp())
    end = int(datetime(2028, 1, 1, tzinfo=UTC).timestamp())
    old = [{'id': name, 'lat': -89., 'lon': 10., 'unchanged': [1, 2, 3],
            'groundM': 100., 'heightM': 2., 'referenceRadiusM': 1737400.}
           for name in ('connecting-ridge', 'shackleton-rim', 'de-gerlache-rim', 'peak-near-shackleton')]
    baseline = fingerprint({'coverage': [start, end], 'sites': old})
    rows, sites, skies = [], [], {}
    geometry = [[start + i * 1800, 0., 10., 0., 180., 10., 0.] for i in range(20449)]
    for i in range(6):
        name = f'new-{i}'
        rows.append((name, name, 'Published region', -86. - i / 10, 20. + i, f'Site{i + 20:02d}'))
        info = {'groundM': 100., 'observerRadiusM': 1737502.}
        models = {level: SimpleNamespace(lower=np.zeros(n), upper=np.ones(n), gap=np.full(n, -90.),
                                        far_cap=-1., info=deepcopy(info))
                  for level, n in (('coarse', 1800), ('fine', 3600))}
        intervals = [[start, end, 'visible']]
        sites.append({'id': name, 'lat': rows[-1][3], 'lon': rows[-1][4], 'groundM': 100.,
                      'heightM': 2., 'referenceRadiusM': 1737400., 'sourceFrame': 'DE421 MOON_ME',
                      'workingFrame': 'MOON_ME_DE440_ME421', 'source': 'https://ntrs.nasa.gov/citations/20250002845',
                      'coordinateStatus': 'Published region center', 'geometry': geometry,
                      'sun': deepcopy(intervals), 'earth': deepcopy(intervals),
                      'refinementIntervals': {target: {level: deepcopy(intervals) for level in models}
                                              for target in ('sun', 'earth')},
                      'terrain': {level: deepcopy(info) for level in models}})
        skies[name] = models
    bundle = fingerprint({'coverage': [start, end], 'sites': deepcopy(old) + sites})
    return baseline, bundle, skies, rows


def test_structure_requires_frozen_originals_exact_observers_and_complete_geometry(expansion):
    baseline, bundle, skies, rows = expansion
    assert module().validate_structure(baseline, bundle, skies, site_rows=rows)['newSiteIds'] == [r[0] for r in rows]
    bundle['sites'][0]['unchanged'][0] = 99
    with pytest.raises(ValueError, match='fingerprint|frozen'):
        module().validate_structure(baseline, bundle, skies, site_rows=rows)


@pytest.mark.parametrize('damage', ['coordinate', 'height', 'missing_geometry', 'nan_geometry', 'inverted', 'terrain_metadata', 'retained_promotion'])
def test_structure_fails_closed_for_damaged_new_evidence(expansion, damage):
    baseline, bundle, skies, rows = expansion
    site = bundle['sites'][4]
    if damage == 'coordinate':
        site['lat'] += .01
    elif damage == 'height':
        site['heightM'] = 5.
    elif damage == 'missing_geometry':
        site['geometry'] = site['geometry'][:-1]
    elif damage == 'nan_geometry':
        site['geometry'] = deepcopy(site['geometry'])
        site['geometry'][0][2] = float('nan')
    elif damage == 'inverted':
        skies[site['id']]['fine'].lower[0] = 2.
    elif damage == 'terrain_metadata':
        site['terrain']['fine']['observerRadiusM'] += 1
    else:
        site['refinementIntervals']['sun']['fine'][0][2] = 'unknown'
    # Structural corruption must fail even if its container is re-fingerprinted.
    if damage != 'nan_geometry':
        bundle = fingerprint(bundle)
    with pytest.raises((ValueError, TypeError), match='.'):
        module().validate_structure(baseline, bundle, skies, site_rows=rows)


def test_horizons_inventory_rejects_zero_truncated_duplicate_epochs_and_unpinned_archive(tmp_path):
    m = module()
    sites = [{'id': 'new-0', 'lat': -86., 'lon': 20., 'groundM': 100., 'heightM': 2., 'referenceRadiusM': 1737400.}]
    stamps = [datetime.combine(day, datetime.min.time(), UTC).isoformat().replace('+00:00', 'Z') for day in m.COMPARISON_DATES]
    data = b'archived JPL response'
    records = []
    for body in ('sun', 'earth'):
        filename = f'new-0-{body}.txt'
        (tmp_path / filename).write_bytes(data)
        records.append({'site_id': 'new-0', 'target': body, 'latitude_deg': -86., 'longitude_deg_east': 20.,
                        'observer_radius_m': 1737502., 'source_filename': filename, 'source_bytes': len(data),
                        'source_sha256': sha256(data).hexdigest(), 'url': 'https://ssd.jpl.nasa.gov/api/horizons.api?',
                        'samples': [{'utc': utc, 'separation_deg': 1e-6} for utc in stamps]})
    report = {'status': 'PASS', 'angular_tolerance_deg': .01, 'comparison_count': 30,
              'max_angular_separation_deg': 1e-6, 'retrieved_utc': '2026-11-15T00:00:00Z', 'references': records}
    assert m.validate_horizons_report(report, sites, tmp_path)['comparison_count'] == 30
    for damage in ('empty', 'truncated', 'duplicate', 'count', 'archive', 'nan'):
        bad = deepcopy(report)
        if damage == 'empty':
            for record in bad['references']:
                record['samples'] = []
            bad['comparison_count'] = 0
        elif damage == 'truncated':
            bad['references'][0]['samples'].pop()
        elif damage == 'duplicate':
            bad['references'][0]['samples'][1] = deepcopy(bad['references'][0]['samples'][0])
        elif damage == 'count':
            bad['comparison_count'] = 0
        elif damage == 'archive':
            bad['references'][0]['source_sha256'] = '0' * 64
        else:
            bad['references'][0]['samples'][0]['separation_deg'] = float('nan')
        with pytest.raises(ValueError, match='.'):
            m.validate_horizons_report(bad, sites, tmp_path)


def test_point_audit_cannot_accept_false_claim_or_promote_all_unknown():
    m = module()
    sky = SimpleNamespace(lower=np.zeros(4), upper=np.ones(4), gap=np.full(4, -90.), far_cap=-1.)
    site = {'id': 'example', 'lat': -86., 'lon': 20., 'groundM': 100., 'heightM': 2., 'referenceRadiusM': 1737400.,
            'sun': [[0, 10, 'visible']], 'earth': [[0, 10, 'blocked']],
            'refinementIntervals': {target: {level: [[0, 10, state]] for level in ('coarse', 'fine')}
                                    for target, state in (('sun', 'visible'), ('earth', 'blocked'))}}
    class Ephemeris:
        def vectors(self, lat, lon, radius, epochs):
            return (np.tile([0., 149e6, 149e6], (len(epochs), 1)),
                    np.tile([0., -400000., 400000.], (len(epochs), 1)))
    with pytest.raises(ValueError, match='contradiction'):
        m.audit_site_claims(Ephemeris(), site, {'coarse': sky, 'fine': sky}, [0, 10])
    for target in ('sun', 'earth'):
        site[target] = [[0, 10, 'unknown']]
        site['refinementIntervals'][target] = {level: [[0, 10, 'unknown']] for level in ('coarse', 'fine')}
    result = m.audit_site_claims(Ephemeris(), site, {'coarse': sky, 'fine': sky}, [0, 10])
    assert result['status'] == 'INDETERMINATE'
    assert result['sampledPoints'] == 0


def test_sparse_native_oracle_detects_a_terrain_upper_bound_violation():
    m = module()
    sky = SimpleNamespace(lower=np.full(3600, -90.), upper=np.zeros(3600),
                          gap=np.full(3600, -90.), far_cap=-1.)
    # Ground 100 m and a one-kilometre-away native sample 100 m higher.
    with pytest.raises(ValueError, match='upper'):
        m.audit_native_samples(-90., 0., 1737502., [-89.967022], [0.], [200.], sky)


@pytest.mark.parametrize('damage', [
    'nan_observer', 'zero_observer', 'nan_site_lat', 'invalid_site_lat', 'nan_site_lon',
    'nan_sample_lat', 'invalid_sample_lat', 'nan_sample_lon', 'infinite_height',
    'mismatched_shapes', 'nested_samples', 'empty_samples', 'nan_upper', 'nested_upper',
    'empty_upper', 'invalid_upper', 'zero_vector',
])
def test_native_oracle_rejects_nonfinite_or_malformed_geometry_before_a_pass(damage):
    m = module()
    lat, lon, radius = -90., 0., 1737502.
    sample_lat, sample_lon, heights = [-89.967022], [0.], [200.]
    sky = SimpleNamespace(upper=np.full(4, 90.))
    if damage == 'nan_observer':
        radius = float('nan')
    elif damage == 'zero_observer':
        radius = 0.
    elif damage == 'nan_site_lat':
        lat = float('nan')
    elif damage == 'invalid_site_lat':
        lat = -91.
    elif damage == 'nan_site_lon':
        lon = float('nan')
    elif damage == 'nan_sample_lat':
        sample_lat = [float('nan')]
    elif damage == 'invalid_sample_lat':
        sample_lat = [-91.]
    elif damage == 'nan_sample_lon':
        sample_lon = [float('nan')]
    elif damage == 'infinite_height':
        heights = [float('inf')]
    elif damage == 'mismatched_shapes':
        sample_lat = [-89.967022, -89.9]
    elif damage == 'nested_samples':
        sample_lat = [[-89.967022]]
    elif damage == 'empty_samples':
        sample_lat, sample_lon, heights = [], [], []
    elif damage == 'nan_upper':
        sky.upper[0] = float('nan')
    elif damage == 'nested_upper':
        sky.upper = np.ones((2, 2))
    elif damage == 'empty_upper':
        sky.upper = np.array([])
    elif damage == 'invalid_upper':
        sky.upper[0] = 91.
    else:
        lat, lon, radius = 0., 0., 1737502.
        sample_lat, sample_lon, heights = [0.], [0.], [102.]
    with pytest.raises(ValueError, match='.'):
        m.audit_native_samples(lat, lon, radius, sample_lat, sample_lon, heights, sky)


def test_cached_geometry_must_match_direct_reference_not_only_have_valid_shape(expansion):
    m = module()
    _, bundle, _, _ = expansion
    site = deepcopy(bundle['sites'][4])
    sample = {'utc': '2026-11-01T00:00:00Z', 'spice_azimuth_deg': 0., 'spice_elevation_deg': 10.}
    record = {'target': 'sun', 'samples': [sample]}
    assert m.validate_cached_reference_geometry(site, record)['status'] == 'PASS'
    site['geometry'][0][1] = 90.
    with pytest.raises(ValueError, match='cached.*geometry'):
        m.validate_cached_reference_geometry(site, record)


def test_disabling_required_checks_cannot_produce_overall_pass(expansion, monkeypatch, tmp_path):
    m = module()
    baseline, bundle, skies, rows = expansion
    monkeypatch.setattr(m, '_site_rows', lambda: rows)
    monkeypatch.setattr(m, '_kernel_provenance', lambda _: [])
    monkeypatch.setattr(m, '_verify_native_sources', lambda *_: [])
    monkeypatch.setattr(m, '_audit_native_rings', lambda *_: {'status': 'PASS', 'sampleCount': 1})
    class Ephemeris:
        def __init__(self, _):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *_):
            pass
        def assert_coverage(self, *_):
            return {}
        def vectors(self, lat, lon, radius, epochs):
            return (np.tile([0., 149e6, 149e6], (len(epochs), 1)),
                    np.tile([0., -400000., 400000.], (len(epochs), 1)))
    monkeypatch.setattr(m, 'Ephemeris', Ephemeris)
    report = m.validate_expansion(tmp_path, baseline, bundle, skies, tmp_path / 'archive', tmp_path / 'out',
                                  run_domain=False, run_motion=False, acquire_horizons=False)
    assert report['status'] == 'INDETERMINATE'
    assert report['horizons']['status'] == report['domain']['status'] == report['motion']['status'] == 'NOT_RUN'


def test_parallel_domain_merge_requires_distinct_complete_observers_and_preserves_counts(expansion):
    m = module()
    _, bundle, _, _ = expansion
    sites = bundle['sites'][4:6]
    checks = dict.fromkeys(['sun_angular_rate_below_envelope', 'earth_angular_rate_below_envelope',
                            'earth_range_above_assumed_minimum', 'earth_abs_range_rate_below_assumed_maximum',
                            'sampled_light_times_inside_coverage_guard'], True)
    records = []
    for site in sites:
        row = {'site_id': site['id'], 'latitude_deg': site['lat'], 'longitude_deg_east': site['lon'],
               'observer_radius_m': 1737502., 'status': 'PASS', 'checks': checks,
               'sun': {'sample_count': 1226881}, 'earth': {'sample_count': 1226881}}
        records.append({'status': 'PASS', 'frame': 'MOON_ME_DE440_ME421', 'correction': 'CN+S',
                        'start_utc': '2026-11-01T00:00:00Z', 'end_utc': '2028-01-01T00:00:00Z',
                        'cadence_seconds': 60, 'interlaced_cadence_seconds': 30,
                        'sampled_only': True, 'between_sample_bound_proven': False,
                        'interlaced_check': {'performed': True, 'within_declared_tolerance': True,
                                             'maximum_angular_rate_change_deg_min': 1e-9},
                        'sites': [row], 'kernels': [], 'code_sha256': {
                            name: m._digest(m.Path(m.__file__).with_name(name))
                            for name in ('domain_validation.py', 'ephemerides.py')}})
    merged = m._merge_domain_reports(records, sites, {})
    assert [row['site_id'] for row in merged['sites']] == [site['id'] for site in sites]
    assert merged['status'] == 'PASS'
    for bad in ([records[0], records[0]], records[:1]):
        with pytest.raises(ValueError, match='inventory|observer'):
            m._merge_domain_reports(bad, sites, {})
    broken = deepcopy(records)
    broken[1]['sites'][0]['sun']['sample_count'] = 0
    with pytest.raises(ValueError, match='count'):
        m._merge_domain_reports(broken, sites, {})
