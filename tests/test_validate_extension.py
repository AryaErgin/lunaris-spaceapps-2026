"""Independent point-audit adversarial fixtures; no raw NASA files required."""

import json
from copy import deepcopy
from hashlib import sha256
from math import cos, radians, sin
from types import SimpleNamespace

import numpy as np
import pytest

from science.validate_extension import (
    _cases,
    _require_manifest_sources,
    audit_claims,
    checked_skylines,
    point_evidence,
    validate_retained,
    validate_timeline,
    verify_payload_fingerprint,
)


def sky(lower=0., upper=1., gap=-90., far=-1.):
    return SimpleNamespace(lower=np.full(4, lower), upper=np.full(4, upper),
                           gap=np.full(4, gap), far_cap=far)


def vector(azimuth, elevation, distance=400000.):
    az, el = radians(azimuth), radians(elevation)
    return np.array([distance * cos(el) * sin(az), distance * cos(el) * cos(az), distance * sin(el)])


def vectors(epochs):
    return np.tile(vector(0, 10, 149e6), (len(epochs), 1)), np.tile(vector(180, 10), (len(epochs), 1))


def test_fingerprint_rejects_changed_payload_and_never_mutates_input():
    value = {'manifest': {}, 'coverage': [0, 10], 'sites': []}
    digest = sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    value['manifest'].update(bundleSha256=digest, bundleHashConvention='test')
    before = deepcopy(value)
    assert verify_payload_fingerprint(value) == digest
    assert value == before
    value['coverage'][1] = 11
    with pytest.raises(ValueError, match='fingerprint'):
        verify_payload_fingerprint(value)


@pytest.mark.parametrize('intervals', [
    [[0, 4, 'visible'], [5, 10, 'visible']],
    [[0, 6, 'visible'], [5, 10, 'visible']],
    [[0, 0, 'visible'], [0, 10, 'visible']],
    [[0, 10, 'safe']],
    [[0, 9, 'visible']],
])
def test_timeline_rejects_gaps_overlaps_zero_unknown_labels_and_censored_end(intervals):
    with pytest.raises(ValueError, match='timeline'):
        validate_timeline(intervals, 0, 10)


def test_false_visible_claim_cannot_pass_point_audit():
    result = audit_claims([[0, 10, 'visible']], 'earth', [0, 10], {'fine': sky(20, 21)}, vectors)
    assert result['status'] == 'FAIL'
    assert result['contradictions'] == 3
    assert result['models']['fine']['contradictions'] == 3


def test_false_blocked_claim_cannot_pass_point_audit():
    result = audit_claims([[0, 10, 'blocked']], 'earth', [0, 10], {'fine': sky()}, vectors)
    assert result['status'] == 'FAIL'
    assert result['contradictions'] == 3


@pytest.mark.parametrize('obstruction', ['gap', 'far'])
def test_unknown_terrain_or_distant_cap_prevents_visible_proof(obstruction):
    terrain = sky(gap=20) if obstruction == 'gap' else sky(far=20)
    evidence = point_evidence(vector(0, 10, 149e6), vector(180, 10), 'earth', terrain)
    assert evidence['visible'] is False
    assert evidence['blocked'] is False


def test_terrain_sector_wrap_uses_clockwise_north_azimuth():
    terrain = sky()
    terrain.lower[3], terrain.upper[3] = 20, 21
    assert point_evidence(vector(0, 10, 149e6), vector(359.9, 10), 'earth', terrain)['blocked']
    assert point_evidence(vector(0, 10, 149e6), vector(0.1, 10), 'earth', terrain)['visible']


def test_solar_earth_disc_occultation_uses_inner_for_blocked_and_outer_for_visible():
    earth = vector(0, 10)
    eclipsed = point_evidence(vector(0, 10, 149e6), earth, 'sun', sky())
    assert eclipsed['blocked'] and not eclipsed['visible']
    grazing = point_evidence(vector(.927, 10, 149e6), earth, 'sun', sky())
    assert not grazing['blocked'] and not grazing['visible']
    clear = point_evidence(vector(2, 10, 149e6), earth, 'sun', sky())
    assert clear['visible'] and not clear['blocked']


def test_retained_visibility_must_be_supported_by_both_models():
    result = audit_claims([[0, 10, 'visible']], 'earth', [0, 10],
                          {'coarse': sky(), 'fine': sky(20, 21)}, vectors)
    assert result['status'] == 'FAIL'
    assert result['models']['coarse']['contradictions'] == 0
    assert result['models']['fine']['contradictions'] == 3


def test_uncertain_unknown_are_preserved_not_sampled_or_reclassified():
    def forbidden(_):
        pytest.fail('Unresolved intervals must not request proof points')
    result = audit_claims([[0, 5, 'uncertain'], [5, 10, 'unknown']], 'sun', [0, 10], {'fine': sky()}, forbidden)
    assert result['status'] == 'PASS'
    assert result['sampledPoints'] == 0
    assert result['intervals']['uncertain'] == 1
    assert result['intervals']['unknown'] == 1


def test_sampling_strictly_inside_half_open_segments_at_specified_offsets():
    seen = []
    def record(epochs):
        seen.extend(epochs)
        return vectors(epochs)
    result = audit_claims([[0, .4, 'visible'], [.4, 10, 'visible']], 'earth', [0, 10], {'fine': sky()}, record)
    assert seen == pytest.approx([.1, .2, .3, .65, 5.2, 9.75])
    assert result['sampledPoints'] == 6


def test_retained_merge_rejects_promoting_uncertain_or_unknown_to_visible():
    coarse = [[0, 4, 'visible'], [4, 10, 'blocked']]
    fine = [[0, 6, 'visible'], [6, 10, 'unknown']]
    good = [[0, 4, 'visible'], [4, 6, 'uncertain'], [6, 10, 'unknown']]
    validate_retained(good, coarse, fine, [0, 10])
    with pytest.raises(ValueError, match='retained'):
        validate_retained([[0, 10, 'visible']], coarse, fine, [0, 10])


def test_malformed_vectors_and_skyline_are_rejected():
    with pytest.raises(ValueError, match='vector'):
        point_evidence([0, 0, 0], vector(180, 10), 'sun', sky())
    with pytest.raises(ValueError, match='skyline'):
        point_evidence(vector(0, 10, 149e6), vector(180, 10), 'earth', sky(2, 1))


def test_missing_cache_is_rejected_without_starting_a_horizon_build(tmp_path, monkeypatch):
    def forbidden(*_, **__):
        pytest.fail('An audit must not create terrain caches')
    monkeypatch.setattr('science.validate_extension.cached_skylines', forbidden)
    hashes = {'Site01_final_adj_5mpp_surf.tif': 'a' * 64, 'LDEM_80S_80MPP_ADJ.TIF': 'b' * 64}
    row = ('connecting-ridge', 'Connecting Ridge', 'region', -89.4632, 222.51, 'Site01')
    with pytest.raises(FileNotFoundError, match='source-checked terrain cache'):
        checked_skylines(tmp_path, row, 2., None, tmp_path, hashes)


def cases_fixture():
    sites = [{'id': identifier, 'lat': lat, 'lon': lon, 'groundM': 10., 'heightM': 2., 'referenceRadiusM': 1737400.}
             for identifier, lat, lon in [('connecting-ridge', -89.4632, 222.510),
                                          ('shackleton-rim', -89.7668, 188.130),
                                          ('de-gerlache-rim', -88.6834, 292.0679)]]
    frame = {'working': 'MOON_ME_DE440_ME421'}
    bundle = {'sites': sites, 'coverage': [0, 10], 'manifest': {'frame': frame, 'bundleSha256': 'digest'}}
    studies = {}
    for kind in ('height', 'position', 'terrain'):
        scenarios = [{'id': 'baseline', 'baseline': True, 'heightM': 2.}]
        for index in range(2):
            scenario = {'id': f'case-{index}', 'heightM': 1 if index == 0 else 5}
            if kind == 'position':
                scenario.update(lat=-88.68, lon=292., groundM=12.)
            if kind == 'terrain':
                scenario.update(lat=-88.6834, lon=292.0679, groundM=13., localSourceSha256=str(index) * 64,
                                terrain={'fine': {'local': {'filename': f'clone{index}.tif'}}})
            scenarios.append(scenario)
        studies[kind] = {'coverage': [0, 10], 'scenarios': scenarios,
                         'manifest': {'baselineBundleSha256': 'digest', 'siteId': 'de-gerlache-rim',
                                      'pointCoordinates': [-88.6834, 292.0679], 'frame': frame}}
    return bundle, studies, deepcopy(bundle), deepcopy(studies)


def test_original_three_sites_and_six_finite_cases_are_bound_to_source_identity():
    cases = _cases(*cases_fixture())
    assert len(cases) == 9
    assert len({case['id'] for case in cases}) == 9
    clone = next(case for case in cases if case['id'] == 'de-gerlache-rim-terrain-caseminus0')
    assert clone['local'].as_posix() == 'clones/clone0.tif'
    assert type(next(case['height'] for case in cases if case['kind'] == 'height')) is int


@pytest.mark.parametrize('mutation', ['coordinate', 'missing_site', 'frame', 'baseline_link', 'finite_identity', 'missing_case'])
def test_case_identity_changes_cannot_be_laundered_by_updated_payload_hash(mutation):
    bundle, studies, original, old_studies = cases_fixture()
    if mutation == 'coordinate':
        bundle['sites'][0]['lon'] = 220.
    elif mutation == 'missing_site':
        bundle['sites'].pop(0)
    elif mutation == 'frame':
        bundle['manifest']['frame'] = {'working': 'J2000'}
    elif mutation == 'baseline_link':
        studies['height']['manifest']['baselineBundleSha256'] = 'different'
    elif mutation == 'finite_identity':
        studies['position']['scenarios'][1]['lat'] -= .1
    else:
        studies['terrain']['scenarios'].pop()
    with pytest.raises(ValueError):
        _cases(bundle, studies, original, old_studies)


def test_raw_source_mismatch_cannot_be_laundered_by_updated_bundle_hash():
    value = {'manifest': {'files': [{'filename': 'raw.tif', 'sha256': 'b' * 64}]}}
    with pytest.raises(ValueError, match='source fingerprint'):
        _require_manifest_sources(value, {'raw.tif': 'a' * 64}, ['raw.tif'])
