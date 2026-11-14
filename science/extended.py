"""Reproducible extended coverage using the unchanged monthly visibility model.

Monthly partitions keep bounded memory and preserve the November demonstration's
original temporal grid. The static coarse and fine terrain models are reused,
never replaced by a level horizon or derived by decimating one another.
"""

import argparse
import json
import platform
from copy import deepcopy
from datetime import date, datetime, timezone
from hashlib import sha256
from math import isfinite
from pathlib import Path

import numpy as np
import pyproj
import rasterio
import spiceypy

from science.build import END, START, _bounds_report, _canonical, _site, _write_bundle
from science.ephemerides import CORRECTION, FILES, FRAME, HORIZONS_LIMIT_DEG, Ephemeris
from science.sources import SITES, clone_manifest, source_manifest
from science.terrain import Skyline, build_skyline

STABLE_RELEASE_COMMIT = '0d369047320ad3d3570f70bf2eeaf9249565a59c'
REFERENCE_FILES = {
    'bundle.json': '67f898ff38f66c0feb8bff7196aa78ed060dd609801dce0aca7a8927d2cc05c6',
    'height-study.json': 'fe3483b709815469f2443f679613b74507c0b360ccc3c76c4238dfe14a2edfcf',
    'position-study.json': '2fea836eae76cae441d316d1eac426b1a2c97f273d2e29def4e3690ba0dac133',
    'terrain-study.json': 'bcaddff0bc500c1288376bf354bdf5d059f440c3ddf58c97f944fce7417019e0',
}


def load_reference(path):
    """Accept only the preserved stable release, not a self-declared baseline."""
    path = Path(path)
    content = path.read_bytes()
    if path.name not in REFERENCE_FILES or sha256(content).hexdigest() != REFERENCE_FILES[path.name]:
        raise ValueError('The preserved reference differs from the immutable stable release fingerprint')
    value = json.loads(content)
    manifest = deepcopy(value['manifest'])
    expected = manifest.pop('bundleSha256')
    manifest.pop('bundleHashConvention')
    if sha256(_canonical(value | {'manifest': manifest})).hexdigest() != expected:
        raise ValueError('The stable reference payload fingerprint does not match')
    return value


def runtime_versions():
    return {'engine': '1.1.0', 'python': platform.python_version(), 'numpy': np.__version__,
            'rasterio': rasterio.__version__, 'gdal': rasterio.__gdal_version__,
            'pyproj': pyproj.__version__, 'spiceypy': spiceypy.__version__}


def scenario_audit_id(kind, scenario):
    return 'de-gerlache-rim-' + kind + '-' + scenario['id'].replace('+', 'plus').replace('-', 'minus')


def calendar_periods(start, end):
    """Partition integer UTC epochs at calendar-month boundaries (end exclusive)."""
    if not isinstance(start, int) or not isinstance(end, int) or start >= end:
        raise ValueError('Coverage must be increasing integer UTC epoch seconds')
    periods, cursor = [], start
    while cursor < end:
        date = datetime.fromtimestamp(cursor, tz=timezone.utc)
        year, month = (date.year + 1, 1) if date.month == 12 else (date.year, date.month + 1)
        boundary = int(datetime(year, month, 1, tzinfo=timezone.utc).timestamp())
        stop = min(end, boundary)
        periods.append((cursor, stop))
        cursor = stop
    return periods


def stitch_intervals(parts, start, end):
    """Check full contiguous coverage and merge equal states across partitions."""
    result, cursor = [], start
    for intervals in parts:
        for a, b, state in intervals:
            if not all(isfinite(v) for v in (a, b)) or a != cursor or b <= a or b > end:
                raise ValueError('Monthly intervals have a gap, overlap or invalid boundary')
            if state not in {'visible', 'blocked', 'uncertain', 'unknown'}:
                raise ValueError('Unknown monthly interval state')
            if result and result[-1][2] == state:
                result[-1][1] = b
            else:
                result.append([a, b, state])
            cursor = b
    if cursor != end:
        raise ValueError('Monthly intervals do not cover the requested period')
    return result


def stitch_geometry(parts, start, end, step=1800):
    """Drop identical shared endpoints; missing or inconsistent rows are errors."""
    result = []
    for rows in parts:
        for row in rows:
            if len(row) != 7 or not isfinite(row[0]):
                raise ValueError('Invalid cached geometry row')
            if result and row[0] == result[-1][0]:
                if row != result[-1]:
                    raise ValueError('Monthly geometry disagrees at a shared endpoint')
                continue
            if result and row[0] != min(end, result[-1][0] + step):
                raise ValueError('Cached geometry has a gap or overlap; no interpolation is permitted')
            result.append(row)
    if not result or result[0][0] != start or result[-1][0] != end:
        raise ValueError('Cached geometry does not span the requested coverage')
    return result


def code_hashes():
    return {name: sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            for name in ('build.py', 'ephemerides.py', 'terrain.py', 'visibility.py', 'extended.py')}


def _json_atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_bytes(_canonical(value) + b'\n')
    temporary.replace(path)


def _signature(value):
    return sha256(_canonical(value)).hexdigest()


def _skyline_fingerprint(skies, identity):
    digest = sha256(_canonical(identity))
    for sky in skies:
        digest.update(_canonical({'info': sky.info, 'far_cap': sky.far_cap}))
        for key in ('lower', 'upper', 'nominal', 'gap', 'blockers'):
            array = getattr(sky, key)
            digest.update(_canonical([key, array.dtype.str, array.shape]))
            digest.update(array.tobytes(order='C'))
    return digest.hexdigest()


def cached_skylines(raw, row, height, local_path, cache_dir, source_hashes):
    """Cache exact float64 arrays with explicit source, observer and code identity."""
    local_name = local_path.name if local_path else f'{row[5]}_final_adj_5mpp_surf.tif'
    identity = {'row': row, 'heightM': height, 'localFile': local_name,
                'localSha256': source_hashes[local_name],
                'regionalSha256': source_hashes['LDEM_80S_80MPP_ADJ.TIF'],
                'terrainCode': code_hashes()['terrain.py'], 'settings': [[1800, 200000], [3600, 240000]],
                'runtimeVersions': runtime_versions()}
    signature = _signature(identity)
    path = cache_dir / f'sky-{row[0]}-{signature[:20]}.npz'
    if path.is_file():
        with np.load(path, allow_pickle=False) as saved:
            if str(saved['signature'].item()) != signature:
                raise ValueError('Cached skyline identity differs from the requested model')
            skies = []
            for label, count in (('coarse', 1800), ('fine', 3600)):
                arrays = {key: saved[f'{label}_{key}'].copy() for key in ('lower', 'upper', 'nominal', 'gap', 'blockers')}
                if any(arrays[key].shape != (count,) for key in ('lower', 'upper', 'nominal', 'gap')) or arrays['blockers'].shape != (count, 4):
                    raise ValueError('Cached skyline dimensions do not match the numerical settings')
                skies.append(Skyline(**arrays, far_cap=float(saved[f'{label}_far_cap']),
                                     info=json.loads(str(saved[f'{label}_info'].item()))))
            if str(saved['payload_sha256'].item()) != _skyline_fingerprint(skies, identity):
                raise ValueError('Cached skyline payload fingerprint differs from the computed model')
        print(f'{row[0]} {height:g}m: reused source-checked terrain cache', flush=True)
        return tuple(skies), signature
    skies = tuple(build_skyline(raw, row[5], row[3], row[4], height, count=count,
                                radius_m=radius, local_path=local_path)
                  for count, radius in ((1800, 200000), (3600, 240000)))
    saved = {'signature': signature, 'payload_sha256': _skyline_fingerprint(skies, identity)}
    for label, sky in zip(('coarse', 'fine'), skies, strict=True):
        saved.update({f'{label}_{key}': getattr(sky, key) for key in ('lower', 'upper', 'nominal', 'gap', 'blockers', 'far_cap')})
        saved[f'{label}_info'] = _canonical(sky.info).decode('ascii')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.npz.tmp')
    with temporary.open('wb') as stream:
        np.savez_compressed(stream, **saved)
    temporary.replace(path)
    print(f'{row[0]} {height:g}m: calculated and cached both independent terrain settings', flush=True)
    return skies, signature


def build_site_period(raw, ephemeris, row, start, end, cache_dir, sources, *, height=2., include_plot=True, local_path=None):
    skies, terrain_signature = cached_skylines(raw, row, height, local_path, cache_dir, sources)
    parts = []
    # A cached monthly _site result depends on these numerical modules. Changes
    # to orchestration/manifest prose revalidate splices but need not recompute SPICE.
    numerical_code = {name: digest for name, digest in code_hashes().items() if name != 'extended.py'}
    for left, right in calendar_periods(start, end):
        signature = _signature({'terrain': terrain_signature, 'range': [left, right],
                                'plot': include_plot, 'code': numerical_code,
                                'runtimeVersions': runtime_versions(),
                                'kernels': {name: value for name, value in sources.items()
                                            if name.endswith(('.bsp', '.bpc', '.tf', '.tls'))}})
        label = datetime.fromtimestamp(left, timezone.utc).strftime('%Y-%m')
        path = cache_dir / f'period-{row[0]}-{label}-{signature[:20]}.json'
        if path.is_file():
            saved = json.loads(path.read_bytes())
            part = saved['site']
            if saved['signature'] != signature or saved['payloadSha256'] != _signature(part):
                raise ValueError(f'Cached month identity or checksum differs: {path.name}')
            print(f'{row[0]} {height:g}m / {label}: reused verified period cache', flush=True)
        else:
            print(f'{row[0]} {height:g}m / {label}: computing true SPICE/terrain intervals', flush=True)
            part = _site(raw, ephemeris, row, height_m=height, include_plot=include_plot,
                         local_path=local_path, start=left, end=right, skylines=skies)
            _json_atomic(path, {'signature': signature, 'payloadSha256': _signature(part), 'site': part})
        # A cached record is never accepted merely because its filename exists.
        for target in ('sun', 'earth'):
            stitch_intervals([part[target]], left, right)
            for level in ('coarse', 'fine'):
                stitch_intervals([part['refinementIntervals'][target][level]], left, right)
        if include_plot:
            stitch_geometry([part['geometry']], left, right)
        parts.append(part)
    combined = deepcopy(parts[0])
    combined['monthlyRefinement'] = []
    for (left, right), part in zip(calendar_periods(start, end), parts, strict=True):
        combined['monthlyRefinement'].append({'coverage': [left, right], 'channels': part['refinement'],
                                              'maxSampledAngularRateDegMin': part['maxSampledAngularRateDegMin']})
    combined['terrain']['warnings'] = sorted({warning for part in parts for warning in part['terrain']['warnings']})
    for target in ('sun', 'earth'):
        combined[target] = stitch_intervals([part[target] for part in parts], start, end)
        for level in ('coarse', 'fine'):
            combined['refinementIntervals'][target][level] = stitch_intervals(
                [part['refinementIntervals'][target][level] for part in parts], start, end)
        combined['refinement'][target] = _bounds_report(
            combined['refinementIntervals'][target]['coarse'], combined['refinementIntervals'][target]['fine'], combined[target])
        combined['refinement'][target]['scope'] = 'Complete extended interval as a diagnostic; every mission still checks both numerical enclosures independently.'
        combined['maxSampledAngularRateDegMin'][target] = max(part['maxSampledAngularRateDegMin'][target] for part in parts)
    if include_plot:
        combined['geometry'] = stitch_geometry([part['geometry'] for part in parts], start, end)
    return combined


def _clip(intervals, start, end):
    return [[max(a, start), min(b, end), state] for a, b, state in intervals if b > start and a < end]


def assert_reference_parity(reference, sites):
    """Check actual November arrays, not just the flagship outcome or file names."""
    start, end = reference['coverage']
    by_id = {site['id']: site for site in sites}
    for original in reference['sites']:
        derived = by_id[original['id']]
        for key in ('lat', 'lon', 'groundM', 'heightM'):
            if original[key] != derived[key]:
                raise ValueError(f'November observer identity changed: {original["id"]} / {key}')
        if original['terrain']['skyline'] != derived['terrain']['skyline']:
            raise ValueError(f'November terrain model changed: {original["id"]}')
        for target in ('sun', 'earth'):
            if original[target] != _clip(derived[target], start, end):
                raise ValueError(f'November retained intervals changed: {original["id"]} / {target}')
            for level in ('coarse', 'fine'):
                if original['refinementIntervals'][target][level] != _clip(derived['refinementIntervals'][target][level], start, end):
                    raise ValueError(f'November refinement changed: {original["id"]} / {target} / {level}')
        if original['geometry'] != [row for row in derived['geometry'] if start <= row[0] <= end]:
            raise ValueError(f'November geometry samples changed: {original["id"]}')
    return {'status': 'PASS', 'referenceBundleSha256': reference['manifest']['bundleSha256'],
            'coverage': [start, end], 'sites': sorted(by_id.keys() & {site['id'] for site in reference['sites']}),
            'checked': ['observer identity', 'fine skyline', 'retained Sun/Earth intervals',
                        'coarse/fine Sun/Earth intervals', 'all 30-minute geometry rows']}


def _validated_reports(domain_path, horizons_path, start, end, sites, *, expected_kernel_hashes=None):
    domain, horizons = (json.loads(path.read_bytes()) for path in (domain_path, horizons_path))
    if domain.get('status') != 'PASS' or horizons.get('status') != 'PASS':
        raise ValueError('Extended data require executed passing domain and Horizons checks')
    if epoch_date(domain['start_utc']) > start or epoch_date(domain['end_utc']) < end:
        raise ValueError('The sampled domain audit does not enclose the requested new dates')
    if domain.get('frame') != FRAME or domain.get('correction') != CORRECTION:
        raise ValueError('The domain audit uses a different observer frame or correction convention')
    conventions = horizons.get('comparison_conventions', {})
    if (conventions.get('lunar_spice_frame') != FRAME or conventions.get('spice_correction') != CORRECTION
            or 'MEAN_ME' not in conventions.get('lunar_horizons_frame', '')
            or 'AIRLESS' not in conventions.get('horizons_correction', '').upper()):
        raise ValueError('Horizons frame or correction conventions differ from the calculation')
    if horizons.get('angular_tolerance_deg') != HORIZONS_LIMIT_DEG:
        raise ValueError('Horizons validation cannot relax the fixed angular tolerance')
    maximum = horizons.get('max_angular_separation_deg', float('inf'))
    if not isfinite(maximum) or maximum >= HORIZONS_LIMIT_DEG:
        raise ValueError('Horizons maximum separation exceeds the fixed validation limit')
    if expected_kernel_hashes is not None:
        actual = {row['filename']: row['sha256'] for row in domain['kernels']}
        if any(actual.get(name) != digest for name, digest in expected_kernel_hashes.items()):
            raise ValueError('Domain validation kernel source hashes differ from the build')
        for name in ('ephemerides.py', 'domain_validation.py'):
            expected = sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            if domain.get('code_sha256', {}).get(name) != expected:
                raise ValueError('Domain validation code source hashes differ from the executed build')
    horizon_ids = {entry['site_id'] for entry in horizons['references']}
    domain_ids = {entry['site_id'] for entry in domain['sites']}
    if not {site['id'] for site in sites} <= horizon_ids & domain_ids:
        raise ValueError('An extended study point is missing from the domain or Horizons checks')
    for site in sites:
        radius = site['referenceRadiusM'] + site['groundM'] + site['heightM']
        audit = next(record for record in domain['sites'] if record['site_id'] == site['id'])
        records = [record for record in horizons['references'] if record['site_id'] == site['id']]
        for record in [audit, *records]:
            if (abs(record['latitude_deg'] - site['lat']) > 1e-10
                    or abs((record['longitude_deg_east'] - site['lon'] + 180) % 360 - 180) > 1e-10
                    or abs(record['observer_radius_m'] - radius) > 1e-6):
                raise ValueError(f'Validation observer differs from the calculated point: {site["id"]}')
        if {record['target'] for record in records} != {'sun', 'earth'}:
            raise ValueError(f'Horizons target checks are incomplete: {site["id"]}')
        for record in records:
            epochs = [epoch_date(sample['utc']) for sample in record['samples']]
            if not epochs or min(epochs) > start or max(epochs) < end:
                raise ValueError(f'Horizons comparison epochs do not span the extended dates: {site["id"]}')
            if any(not isfinite(sample['separation_deg']) or sample['separation_deg'] >= HORIZONS_LIMIT_DEG for sample in record['samples']):
                raise ValueError(f'A Horizons direction fails the fixed angular validation limit: {site["id"]}')
    return domain, horizons


def epoch_date(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def _validated_motion(path, start, end, sites, expected_kernel_hashes):
    report = json.loads(path.read_bytes())
    if (report.get('status') != 'PASS' or not report.get('checks')
            or not all(value is True for value in report['checks'].values())
            or report.get('polynomial_interval_enclosure') is not True
            or report.get('formal_verification') is not False
            or report.get('physical_model_error_bounded') is not False):
        raise ValueError('A passing, explicitly scoped kernel-model motion enclosure is required')
    if epoch_date(report['start_utc']) > start or epoch_date(report['end_utc']) < end:
        raise ValueError('Motion enclosure does not span the requested date coverage')
    maximum_radius = max((site['referenceRadiusM'] + site['groundM'] + site['heightM']) / 1000 for site in sites)
    if report['observer_radius_upper_km'] < maximum_radius:
        raise ValueError('The motion enclosure does not include every observer radius')
    code = Path(__file__).with_name('motion_envelope.py')
    if report.get('code_sha256') != sha256(code.read_bytes()).hexdigest():
        raise ValueError('Motion-enclosure code differs from the executed source')
    actual = {row['filename']: row['sha256'] for row in report['kernels']}
    if any(actual.get(name) != digest for name, digest in expected_kernel_hashes.items()):
        raise ValueError('Motion-enclosure kernel hashes differ from the build')
    bounds = report['bounds']
    if not (0 <= bounds['sun_angular_rate_deg_min'] < .03
            and 0 <= bounds['earth_angular_rate_deg_min'] < .03
            and bounds['earth_range_min_km'] > 350000
            and 0 <= bounds['earth_abs_range_rate_km_s'] < 2
            and 0 <= bounds['earth_light_time_max_s'] < 2
            and 0 <= bounds['sun_light_time_max_s'] < 600
            and 0 <= bounds['angular_seam_and_implementation_allowance_deg'] < .00001):
        raise ValueError('The model enclosure does not establish the unchanged solver assumptions')
    return report


def build_extended(args):
    reference = load_reference(args.reference)
    if reference['coverage'] != [START, END]:
        raise ValueError('The reference must be the exact November release, not a previous expansion')
    start, end = epoch_date(args.start), epoch_date(args.end)
    if start != START or end <= END:
        raise ValueError('Extend forward from the frozen November start while retaining its full coverage')
    sources = source_manifest(args.raw)
    clone_sources = clone_manifest(args.raw / 'clones')
    rows = list(SITES)
    if args.additional_site:
        from science.extended_sites import (
            EXTENDED_SITES,
            SITE_METADATA,
            validate_extended_site,
        )
        from science.extended_sites import source_manifest as extra_sources
        extra_descriptor = validate_extended_site(args.raw)
        rows.extend(EXTENDED_SITES)
        sources.extend(extra_sources(args.raw))
    hashes = {source['filename']: source['sha256'] for source in sources + clone_sources}
    overlays = {kind: load_reference(args.reference.parent / f'{kind}-study.json')
                for kind in ('height', 'position', 'terrain')}
    descriptors = deepcopy(reference['sites'])
    if args.additional_site:
        descriptors.append({**extra_descriptor, 'id': extra_descriptor['siteId'], 'referenceRadiusM': 1737400.})
    nominal = next(site for site in descriptors if site['id'] == 'de-gerlache-rim')
    for kind, overlay in overlays.items():
        for scenario in overlay['scenarios']:
            if not scenario.get('baseline'):
                descriptors.append({'id': scenario_audit_id(kind, scenario),
                    'lat': scenario.get('lat', nominal['lat']), 'lon': scenario.get('lon', nominal['lon']),
                    'heightM': scenario['heightM'], 'groundM': scenario.get('groundM', nominal['groundM']),
                    'referenceRadiusM': nominal['referenceRadiusM']})
    domain, horizons = _validated_reports(args.domain_validation, args.horizons_validation, start, end, descriptors,
                                          expected_kernel_hashes={name: hashes[name] for name in FILES})
    motion = _validated_motion(args.motion_enclosure, start, end, descriptors, {name: hashes[name] for name in FILES})
    args.cache.mkdir(parents=True, exist_ok=True)
    with Ephemeris(args.raw) as ephemeris:
        coverage = ephemeris.assert_coverage(start, end)
        sites = [build_site_period(args.raw, ephemeris, row, start, end, args.cache, hashes) for row in rows]
        if args.additional_site:
            for site in sites:
                if site['id'] in SITE_METADATA:
                    site.update(SITE_METADATA[site['id']])
        parity = assert_reference_parity(reference, sites)
        manifest = deepcopy(reference['manifest'])
        for key in ('bundleSha256', 'bundleHashConvention'):
            manifest.pop(key, None)
        manifest.update(engineCommit=args.engine_commit, version='1.1.0', files=sources, versions=runtime_versions(),
                        aiUse='OpenAI Codex and Anthropic Claude assisted research, implementation, verification and writing under human team members Arya Ergin and Aras. Deterministic calculations; no runtime AI.')
        manifest['frame']['ephemeris'] = coverage['kernel_intervals']
        manifest['validation']['kernelReceptionCoverage'] = coverage
        manifest['validation']['horizons'] = horizons
        manifest['validation']['motionDomain'] = domain
        manifest['validation']['motionEnvelope'] = motion
        manifest['validation']['extendedCoverage'] = {'coverage': [start, end], 'partitions': calendar_periods(start, end),
                                                      'codeSha256': code_hashes(), 'novemberParity': parity,
                                                      'method': 'Original coarse/fine terrain models; UTC monthly temporal grids; checked contiguous splicing.'}
        manifest['limitations'] = [item.replace('specific to this bounded date range and sites',
            'an adopted ceiling for the explicitly audited coverage and observers; dense sampled checks do not prove a continuous physical bound') for item in manifest['limitations']]
        manifest['limitations'].append('Future UTC epochs use the frozen naif0012.tls leap-second table. Future leap-second decisions require an updated kernel and revalidation; displayed numerical brackets are not physical clock-accuracy guarantees.')
        for record in horizons['references']:
            manifest['files'].append({'filename': record['source_filename'], 'url': record['url'],
                'citation': 'https://ssd.jpl.nasa.gov/horizons/', 'bytes': record['source_bytes'],
                'sha256': record['source_sha256'], 'product_version': 'JPL Horizons API / airless apparent topocentric reference',
                'local_file_acquired_utc': horizons['retrieved_utc'], 'use': 'Matched direction comparison; shared JPL model lineage, not terrain validation'})
        bundle = {'version': '1.1.0', 'coverage': [start, end], 'demonstrationCoverage': [START, END],
                  'sites': sites, 'manifest': manifest, 'demo': deepcopy(reference['demo'])}
        # Establish the new baseline fingerprint before binding finite configurations.
        staged = args.cache / 'staged-bundle.json'
        _write_bundle(bundle, staged)
        studies = {}
        base_row = next(row for row in rows if row[0] == 'de-gerlache-rim')
        for kind in ('height', 'position', 'terrain'):
            old = overlays[kind]
            study = deepcopy(old)
            study['version'] = '1.1.0'
            study['coverage'] = [start, end]
            for scenario, old_scenario in zip(study['scenarios'], old['scenarios'], strict=True):
                if scenario.get('baseline'):
                    continue
                lat, lon = scenario.get('lat', base_row[3]), scenario.get('lon', base_row[4])
                row = (*base_row[:3], lat, lon, base_row[5])
                local_path = args.raw / 'clones' / scenario['terrain']['fine']['local']['filename'] if kind == 'terrain' else None
                derived = build_site_period(args.raw, ephemeris, row, start, end, args.cache, hashes,
                                            height=scenario['heightM'], include_plot=False, local_path=local_path)
                for key in ('sun', 'earth', 'refinementIntervals', 'terrain', 'refinement', 'maxSampledAngularRateDegMin', 'monthlyRefinement'):
                    scenario[key] = derived[key]
                if 'groundM' in scenario:
                    scenario['groundM'] = derived['groundM']
                for target in ('sun', 'earth'):
                    if _clip(scenario[target], START, END) != old_scenario[target]:
                        raise ValueError(f'November finite-configuration parity changed: {kind}/{scenario["id"]}/{target}')
                    for level in ('coarse', 'fine'):
                        if _clip(scenario['refinementIntervals'][target][level], START, END) != old_scenario['refinementIntervals'][target][level]:
                            raise ValueError(f'November finite-refinement parity changed: {kind}/{scenario["id"]}/{target}/{level}')
            study['manifest'].update(baselineBundleSha256=bundle['manifest']['bundleSha256'],
                                      generatorCommit=args.engine_commit, extendedDomainAudit=args.domain_validation.name,
                                      aiUse=manifest['aiUse'], frame=manifest['frame'],
                                      versions=runtime_versions(),
                                      extendedCodeSha256=code_hashes())
            for key in ('bundleSha256', 'bundleHashConvention'):
                study['manifest'].pop(key, None)
            studies[kind] = study
    args.outdir.mkdir(parents=True, exist_ok=True)
    _write_bundle(bundle, args.outdir / 'bundle.json')
    for kind, study in studies.items():
        _write_bundle(study, args.outdir / f'{kind}-study.json')
    print(f'EXTENDED BUILD COMPLETE: {len(sites)} sites, {args.start} to {args.end}, exact November parity retained.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw', type=Path, default=Path('data/raw'))
    parser.add_argument('--reference', type=Path, required=True, help='Preserved original November bundle, with its three study JSON files alongside')
    parser.add_argument('--start', type=date.fromisoformat, default=date(2026, 11, 1))
    parser.add_argument('--end', type=date.fromisoformat, default=date(2028, 1, 1))
    parser.add_argument('--cache', type=Path, default=Path('data/cache/extended'))
    parser.add_argument('--outdir', type=Path, default=Path('web/data'))
    parser.add_argument('--domain-validation', type=Path, required=True)
    parser.add_argument('--horizons-validation', type=Path, required=True)
    parser.add_argument('--motion-enclosure', type=Path, required=True)
    parser.add_argument('--engine-commit', required=True)
    parser.add_argument('--additional-site', action='store_true')
    args = parser.parse_args()
    args.start, args.end = args.start.isoformat(), args.end.isoformat()
    build_extended(args)


if __name__ == '__main__':
    main()
