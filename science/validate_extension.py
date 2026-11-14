"""Independent sampled consistency audit of retained/coarse/fine visibility.

This uses the same pinned SPICE and NASA DEM MODEL inputs but independent point
decision arithmetic. It never calls Visibility.interval_status or its interval
combiner. Interior samples can disprove an incorrect interval; passing samples
are NOT a continuous proof, independent terrain validation or physical accuracy
claim. The separate motion-envelope audit addresses the solver's motion ceiling.
"""

import argparse
import json
import time
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
from itertools import pairwise
from math import acos, asin, atan2, degrees, floor, hypot, isfinite, sqrt
from pathlib import Path

import numpy as np

from science.ephemerides import FILES, FRAME, Ephemeris
from science.extended import (
    cached_skylines,
    code_hashes,
    load_reference,
    runtime_versions,
    scenario_audit_id,
)
from science.sources import SITES, clone_manifest, source_manifest

STATES = frozenset(('visible', 'blocked', 'uncertain', 'unknown'))
EARTH_INNER_KM = 6356.75
EARTH_OUTER_KM = 6378.137


def _canonical(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False,
                      sort_keys=True, separators=(',', ':')).encode('utf-8')


def _digest_file(path):
    digest = sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def verify_payload_fingerprint(value):
    """Recompute semantic payload identity without trusting its own metadata."""
    unsigned = deepcopy(value)
    try:
        expected = unsigned['manifest'].pop('bundleSha256')
        unsigned['manifest'].pop('bundleHashConvention')
    except (KeyError, TypeError) as error:
        raise ValueError('Missing bundle fingerprint metadata') from error
    actual = sha256(_canonical(unsigned)).hexdigest()
    if not isinstance(expected, str) or expected != actual:
        raise ValueError('Bundle fingerprint does not match the actual payload')
    return actual


def validate_timeline(intervals, start, end):
    """Require exact contiguous coverage of a half-open, uncensored domain."""
    if not all(isfinite(x) for x in (start, end)) or end <= start:
        raise ValueError('Invalid timeline coverage')
    cursor = start
    for item in intervals:
        if not isinstance(item, (list, tuple)) or len(item) != 3:
            raise ValueError('Invalid timeline interval')
        a, b, state = item
        if (not all(isinstance(x, (int, float)) and isfinite(x) for x in (a, b))
                or a != cursor or b <= a or b > end or state not in STATES):
            raise ValueError('Invalid timeline gap, overlap, span or state')
        cursor = b
    if cursor != end:
        raise ValueError('Incomplete timeline coverage')


def validate_retained(retained, coarse, fine, coverage):
    """Independently sweep all endpoints; unresolved evidence cannot be promoted."""
    for intervals in (retained, coarse, fine):
        validate_timeline(intervals, *coverage)
    indices = [0, 0, 0]
    timelines = (retained, coarse, fine)
    endpoints = sorted({x for rows in timelines for a, b, _ in rows for x in (a, b)})
    for a, b in pairwise(endpoints):
        labels = []
        for index, rows in enumerate(timelines):
            while rows[indices[index]][1] <= a:
                indices[index] += 1
            left, right, state = rows[indices[index]]
            if left > a or right < b:
                raise ValueError('Invalid retained interval sweep')
            labels.append(state)
        actual, former, latest = labels
        expected = former if former == latest else ('unknown' if 'unknown' in (former, latest) else 'uncertain')
        if actual != expected:
            raise ValueError(f'Incorrect retained state at [{a}, {b}): {actual}, expected {expected}')


def _vector(values):
    if len(values) != 3 or not all(isfinite(float(x)) for x in values):
        raise ValueError('Invalid ephemeris vector')
    values = tuple(float(x) for x in values)
    length = sqrt(sum(x * x for x in values))
    if not isfinite(length) or length <= 0:
        raise ValueError('Invalid ephemeris vector norm')
    return values, length


def point_evidence(sun, earth, target, sky):
    """Direct ENU-sector evidence at one instant, independent of interval code."""
    if target not in ('sun', 'earth'):
        raise ValueError('Target must be sun or earth')
    u, sun_range = _vector(sun)
    v, earth_range = _vector(earth)
    if earth_range <= EARTH_OUTER_KM:
        raise ValueError('Earth vector is inside its bounding radius')
    count = len(sky.lower)
    if (count == 0 or len(sky.upper) != count or len(sky.gap) != count
            or not isfinite(float(sky.far_cap))):
        raise ValueError('Invalid skyline dimensions or far cap')
    direction = u if target == 'sun' else v
    east, north, up = direction
    azimuth = degrees(atan2(east, north)) % 360
    elevation = degrees(atan2(up, hypot(east, north)))
    index = floor(azimuth * count / 360) % count
    lower, upper, gap = (float(array[index]) for array in (sky.lower, sky.upper, sky.gap))
    if not all(isfinite(x) for x in (lower, upper, gap)) or lower > upper:
        raise ValueError('Invalid skyline bounds')
    cosine = sum(a * b for a, b in zip(u, v, strict=True)) / (sun_range * earth_range)
    separation = degrees(acos(max(-1., min(1., cosine))))
    outer_clearance = separation - degrees(asin(EARTH_OUTER_KM / earth_range))
    inner_clearance = separation - degrees(asin(EARTH_INNER_KM / earth_range))
    visible = elevation > max(upper, gap, float(sky.far_cap))
    blocked = elevation < lower
    if target == 'sun':
        visible = visible and outer_clearance > 0
        blocked = blocked or inner_clearance < 0
    return {'visible': bool(visible), 'blocked': bool(blocked), 'azimuthDeg': azimuth,
            'elevationDeg': elevation, 'sector': index, 'lowerDeg': lower, 'upperDeg': upper,
            'gapDeg': gap, 'farCapDeg': float(sky.far_cap),
            'sunEarthOuterClearanceDeg': outer_clearance, 'sunEarthInnerClearanceDeg': inner_clearance}


def audit_claims(intervals, target, coverage, models, vector_provider, *, batch_size=4096, error_limit=20):
    """Test each definite claim at three strict interior epochs, never at edges."""
    validate_timeline(intervals, *coverage)
    if not models or batch_size <= 0:
        raise ValueError('At least one skyline and a positive batch size are required')
    counts = Counter(state for _, _, state in intervals)
    durations = {state: sum(b - a for a, b, label in intervals if label == state) for state in STATES}
    result = {'status': 'PASS', 'intervals': {state: counts[state] for state in sorted(STATES)},
              'durationSeconds': durations, 'sampledPoints': 0, 'contradictions': 0,
              'models': {name: {'evaluations': 0, 'contradictions': 0} for name in models}, 'errors': []}
    samples = []

    def flush():
        if not samples:
            return
        epochs = [point[0] for point in samples]
        sun, earth = vector_provider(epochs)
        if np.shape(sun) != (len(epochs), 3) or np.shape(earth) != (len(epochs), 3):
            raise ValueError('Ephemeris vector provider returned an invalid shape')
        for position, (epoch, claim, a, b) in enumerate(samples):
            result['sampledPoints'] += 1
            for name, sky in models.items():
                evidence = point_evidence(sun[position], earth[position], target, sky)
                result['models'][name]['evaluations'] += 1
                if not evidence[claim]:
                    result['contradictions'] += 1
                    result['models'][name]['contradictions'] += 1
                    if len(result['errors']) < error_limit:
                        result['errors'].append({'epoch': epoch, 'interval': [a, b], 'claim': claim,
                                                 'model': name, 'evidence': evidence})
        samples.clear()

    for a, b, state in intervals:
        if state not in ('visible', 'blocked'):
            continue
        offset = min(.25, (b - a) / 4)
        for epoch in (a + offset, (a + b) / 2, b - offset):
            if not a < epoch < b:
                raise ValueError('Definite interval lacks a representable interior sample')
            samples.append((epoch, state, a, b))
            if len(samples) >= batch_size:
                flush()
    flush()
    if result['contradictions']:
        result['status'] = 'FAIL'
    return result


def checked_skylines(raw, row, height, local_path, cache_dir, hashes):
    """Read only an existing exact production-identity cache; never build one."""
    local_name = local_path.name if local_path else f'{row[5]}_final_adj_5mpp_surf.tif'
    identity = {'row': row, 'heightM': height, 'localFile': local_name,
                'localSha256': hashes[local_name], 'regionalSha256': hashes['LDEM_80S_80MPP_ADJ.TIF'],
                'terrainCode': code_hashes()['terrain.py'], 'settings': [[1800, 200000], [3600, 240000]],
                'runtimeVersions': runtime_versions()}
    expected = sha256(_canonical(identity)).hexdigest()
    path = Path(cache_dir) / f'sky-{row[0]}-{expected[:20]}.npz'
    if not path.is_file():
        raise FileNotFoundError(f'Missing exact source-checked terrain cache: {path}')
    (coarse, fine), actual = cached_skylines(raw, row, height, local_path, Path(cache_dir), hashes)
    if actual != expected:
        raise ValueError('Production terrain cache identity differs from the audit identity')
    return {'coarse': coarse, 'fine': fine}, {'filename': path.name, 'bytes': path.stat().st_size,
                                           'sha256': _digest_file(path), 'identitySha256': actual,
                                           'identity': identity}


def _same_observer(actual, expected, *, scenario=False):
    for key in ('lat', 'lon', 'groundM', 'heightM', 'referenceRadiusM'):
        # Height cases omit ground and coordinates and inherit the nominal site.
        if key in expected and (key not in actual or actual[key] != expected[key]):
            scope = 'finite observer' if scenario else 'study-point observer'
            raise ValueError(f'Changed {scope} identity: {key}')


def _cases(bundle, studies, reference, original_studies):
    """Bind each point to published/stable identity, not just a matching label."""
    from science.extended_sites import EXTENDED_SITES

    rows = {row[0]: row for row in (*SITES, *EXTENDED_SITES)}
    stable = {site['id']: site for site in reference['sites']}
    sites = {site['id']: site for site in bundle['sites']}
    if len(sites) != len(bundle['sites']) or not stable.keys() <= sites.keys() or not sites.keys() <= rows.keys():
        raise ValueError('Missing, duplicate or unsupported baseline study-point identity')
    if bundle['manifest'].get('frame', {}).get('working') != FRAME:
        raise ValueError('Payload lunar reference frame differs from the ephemeris model')
    result = []
    for site_id, site in sites.items():
        row = rows[site_id]
        if (site.get('lat'), site.get('lon'), site.get('heightM'), site.get('referenceRadiusM')) != (row[3], row[4], 2., 1737400.):
            raise ValueError(f'Published study-point coordinates or observer changed: {site_id}')
        if site_id in stable:
            _same_observer(site, stable[site_id])
        result.append({'id': site_id, 'kind': 'baseline', 'site': site, 'row': row, 'height': 2., 'local': None})
    nominal = sites['de-gerlache-rim']
    base_row = rows['de-gerlache-rim']
    for kind, study in studies.items():
        manifest = study['manifest']
        if (study['coverage'] != bundle['coverage']
                or manifest.get('baselineBundleSha256') != bundle['manifest']['bundleSha256']
                or manifest.get('siteId') != nominal['id']
                or manifest.get('pointCoordinates') != [nominal['lat'], nominal['lon']]
                or _canonical(manifest.get('frame')) != _canonical(bundle['manifest']['frame'])):
            raise ValueError(f'Finite study baseline, coverage or frame differs: {kind}')
        originals = {entry['id']: entry for entry in original_studies[kind]['scenarios']}
        scenarios = {entry['id']: entry for entry in study['scenarios']}
        if (scenarios.keys() != originals.keys() or len(scenarios) != len(study['scenarios'])
                or sum(bool(entry.get('baseline')) for entry in scenarios.values()) != 1):
            raise ValueError(f'Finite study cases differ from the original reference: {kind}')
        for identifier, scenario in scenarios.items():
            old = originals[identifier]
            if bool(scenario.get('baseline')) != bool(old.get('baseline')):
                raise ValueError(f'Finite baseline label changed: {kind}/{identifier}')
            _same_observer(scenario, old, scenario=True)
            if scenario.get('baseline'):
                continue
            lat, lon = scenario.get('lat', nominal['lat']), scenario.get('lon', nominal['lon'])
            local = None
            if kind == 'terrain':
                filename = old['terrain']['fine']['local']['filename']
                if (scenario.get('localSourceSha256') != old['localSourceSha256']
                        or scenario['terrain']['fine']['local']['filename'] != filename):
                    raise ValueError('Finite terrain realization source changed')
                local = Path('clones') / filename
            result.append({'id': scenario_audit_id(kind, scenario), 'kind': kind, 'site': scenario,
                           'row': (*base_row[:3], lat, lon, base_row[5]),
                           'height': scenario['heightM'], 'local': local})
    return result


def _require_manifest_sources(value, hashes, required):
    files = {row['filename']: row['sha256'] for row in value['manifest']['files']}
    if any(files.get(name) != hashes[name] for name in required):
        raise ValueError('Payload source fingerprint differs from pinned raw model inputs')


def audit_extension(raw, bundle_path, reference_path, cache_dir):
    """Audit every baseline and finite case; no data/terrain cache is generated."""
    started = time.perf_counter()
    raw, bundle_path, reference_path, cache_dir = map(Path, (raw, bundle_path, reference_path, cache_dir))
    input_paths = {'baseline': bundle_path, **{kind: bundle_path.parent / f'{kind}-study.json'
                                            for kind in ('height', 'position', 'terrain')}}
    input_bytes = {kind: path.read_bytes() for kind, path in input_paths.items()}
    input_hashes = {kind: sha256(content).hexdigest() for kind, content in input_bytes.items()}
    source_paths = [Path(__file__), Path(__file__).with_name('ephemerides.py')]
    source_hashes = {path.name: _digest_file(path) for path in source_paths}
    payloads = {kind: json.loads(content) for kind, content in input_bytes.items()}
    del input_bytes
    fingerprints = {kind: verify_payload_fingerprint(value) for kind, value in payloads.items()}
    bundle = payloads['baseline']
    coverage = bundle['coverage']
    validate_timeline([[*coverage, 'unknown']], *coverage)
    reference = load_reference(reference_path)
    original_studies = {kind: load_reference(reference_path.parent / f'{kind}-study.json')
                        for kind in ('height', 'position', 'terrain')}
    studies = {kind: payloads[kind] for kind in original_studies}
    cases = _cases(bundle, studies, reference, original_studies)
    sources = source_manifest(raw) + clone_manifest(raw / 'clones')
    if any(case['id'] == 'peak-near-shackleton' for case in cases):
        from science.extended_sites import source_manifest as extended_sources
        sources += extended_sources(raw)
    hashes = {entry['filename']: entry['sha256'] for entry in sources}
    prepared = []
    nominal_ground = next(site['groundM'] for site in bundle['sites'] if site['id'] == 'de-gerlache-rim')
    # All hashes, timeline shapes and model identities fail before SPICE work.
    for case in cases:
        site, row = case['site'], case['row']
        local = raw / case['local'] if case['local'] is not None else None
        local_name = local.name if local else f'{row[5]}_final_adj_5mpp_surf.tif'
        source = payloads[case['kind']]
        _require_manifest_sources(source, hashes, [local_name, 'LDEM_80S_80MPP_ADJ.TIF', *FILES])
        skies, cache = checked_skylines(raw, row, case['height'], local, cache_dir, hashes)
        radius = 1737400. + site.get('groundM', nominal_ground) + case['height']
        for level, sky in skies.items():
            if (_canonical(site['terrain'][level]) != _canonical(sky.info)
                    or sky.info['observerRadiusM'] != radius or sky.info['local']['filename'] != local_name):
                raise ValueError(f'Cached terrain or observer differs from interval payload: {case["id"]}/{level}')
            for key in ('lower', 'upper', 'gap'):
                if not np.all(np.isfinite(getattr(sky, key))):
                    raise ValueError('Non-finite skyline enclosure in source-checked cache')
            if np.any(sky.lower > sky.upper):
                raise ValueError('Inverted skyline enclosure in source-checked cache')
        for target in ('sun', 'earth'):
            validate_retained(site[target], site['refinementIntervals'][target]['coarse'],
                              site['refinementIntervals'][target]['fine'], coverage)
        prepared.append((case, skies, cache, radius))
    results = []
    with Ephemeris(raw) as ephemeris:
        ephemeris.assert_coverage(*coverage)
        for case, skies, cache, radius in prepared:
            vectors_by_epoch = {}
            row, site = case['row'], case['site']

            def provider(epochs, *, row=row, radius=radius, vectors_by_epoch=vectors_by_epoch):
                missing = sorted(set(epochs) - vectors_by_epoch.keys())
                if missing:
                    sun, earth = ephemeris.vectors(row[3], row[4], radius, missing)
                    vectors_by_epoch.update({epoch: (sun[i], earth[i]) for i, epoch in enumerate(missing)})
                return tuple(np.array([vectors_by_epoch[epoch][j] for epoch in epochs]) for j in (0, 1))

            channels = {}
            for target in ('sun', 'earth'):
                levels = {'retained': audit_claims(site[target], target, coverage, skies, provider)}
                for level in ('coarse', 'fine'):
                    levels[level] = audit_claims(site['refinementIntervals'][target][level], target,
                                                 coverage, {level: skies[level]}, provider)
                channels[target] = levels
            contradictions = sum(audit['contradictions'] for levels in channels.values() for audit in levels.values())
            results.append({'caseAuditId': case['id'], 'kind': case['kind'],
                            'latitudeDeg': row[3], 'longitudeDegEast': row[4], 'heightM': case['height'],
                            'observerRadiusM': radius, 'terrainCache': cache,
                            'uniqueEphemerisEpochs': len(vectors_by_epoch), 'channels': channels,
                            'contradictions': contradictions, 'status': 'FAIL' if contradictions else 'PASS'})
            print(f'{case["id"]}: {len(vectors_by_epoch)} unique epochs, {contradictions} contradictions', flush=True)
    contradictions = sum(case['contradictions'] for case in results)
    if (any(_digest_file(path) != input_hashes[kind] for kind, path in input_paths.items())
            or any(_digest_file(path) != source_hashes[path.name] for path in source_paths)):
        raise ValueError('An audited payload or numerical source changed during the audit')
    return {'status': 'FAIL' if contradictions else 'PASS', 'auditType': 'Independent arithmetic / interior point consistency',
            'coverage': coverage, 'frame': FRAME, 'executedUtc': datetime.now(timezone.utc).isoformat(),
            'elapsedSeconds': round(time.perf_counter() - started, 6), 'contradictions': contradictions,
            'caseCount': len(results), 'cases': results,
            'sampledPoints': sum(audit['sampledPoints'] for case in results for levels in case['channels'].values() for audit in levels.values()),
            'modelEvaluations': sum(model['evaluations'] for case in results for levels in case['channels'].values()
                                    for audit in levels.values() for model in audit['models'].values()),
            'inputs': {kind: {'filename': path.name, 'bytes': path.stat().st_size,
                              'fileSha256': input_hashes[kind], 'bundleSha256': fingerprints[kind]}
                       for kind, path in input_paths.items()},
            'rawSourcePins': hashes, 'codeSha256': source_hashes['validate_extension.py'],
            'ephemeridesCodeSha256': source_hashes['ephemerides.py'],
            'runtimeVersions': runtime_versions(), 'sampling': 'Each definite interval: a+min(0.25,width/4), midpoint, b-min(0.25,width/4), strictly interior.',
            'limitations': ['Shared pinned SPICE ephemeris and NASA DEM model inputs, not an independent ephemeris implementation.',
                           'Not independent terrain/observational validation, a continuous interval proof or a physical accuracy guarantee.',
                           'Uncertain/unknown intervals are preserved and never reclassified by sampled points.',
                           'PASS means no sampled contradiction, not landing safety, electrical power or radio-link performance.',
                           'Continuous motion assumptions are assessed separately by the kernel-model motion-envelope report.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw', type=Path, default=Path('data/raw'))
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--cache', type=Path, default=Path('data/cache/extended'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = audit_extension(args.raw, args.bundle, args.reference, args.cache)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + '.tmp')
    temporary.write_bytes(_canonical(report) + b'\n')
    temporary.replace(args.output)
    print(f'POINT AUDIT {report["status"]}: {report["caseCount"]} cases; {report["contradictions"]} contradictions', flush=True)
    if report['status'] != 'PASS':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
