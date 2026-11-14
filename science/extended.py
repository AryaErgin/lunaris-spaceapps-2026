"""Reproducible extended coverage using the unchanged monthly visibility model.

Monthly partitions keep bounded memory and preserve the November demonstration's
original temporal grid. The static coarse and fine terrain models are reused,
never replaced by a level horizon or derived by decimating one another.
"""

import argparse
import json
from copy import deepcopy
from datetime import date, datetime, timezone
from hashlib import sha256
from math import isfinite
from pathlib import Path

import numpy as np

from science.build import END, START, _bounds_report, _canonical, _site, _write_bundle
from science.ephemerides import CORRECTION, FRAME, Ephemeris
from science.sources import SITES, clone_manifest, source_manifest
from science.terrain import Skyline, build_skyline


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
                'terrainCode': code_hashes()['terrain.py'], 'settings': [[1800, 200000], [3600, 240000]]}
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


def _validated_reports(domain_path, horizons_path, start, end, sites):
    domain, horizons = (json.loads(path.read_bytes()) for path in (domain_path, horizons_path))
    if domain.get('status') != 'PASS' or horizons.get('status') != 'PASS':
        raise ValueError('Extended data require executed passing domain and Horizons checks')
    if epoch_date(domain['start_utc']) > start or epoch_date(domain['end_utc']) < end:
        raise ValueError('The sampled domain audit does not enclose the requested new dates')
    if domain.get('frame') != FRAME or domain.get('correction') != CORRECTION:
        raise ValueError('The domain audit uses a different observer frame or correction convention')
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
    return domain, horizons


def epoch_date(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def build_extended(args):
    reference = json.loads(args.reference.read_bytes())
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
        validate_extended_site(args.raw)
        rows.extend(EXTENDED_SITES)
        sources.extend(extra_sources(args.raw))
    hashes = {source['filename']: source['sha256'] for source in sources + clone_sources}
    args.cache.mkdir(parents=True, exist_ok=True)
    with Ephemeris(args.raw) as ephemeris:
        coverage = ephemeris.assert_coverage(start, end)
        sites = [build_site_period(args.raw, ephemeris, row, start, end, args.cache, hashes) for row in rows]
        if args.additional_site:
            for site in sites:
                if site['id'] in SITE_METADATA:
                    site.update(SITE_METADATA[site['id']])
        parity = assert_reference_parity(reference, sites)
        domain, horizons = _validated_reports(args.domain_validation, args.horizons_validation, start, end, sites)
        manifest = deepcopy(reference['manifest'])
        for key in ('bundleSha256', 'bundleHashConvention'):
            manifest.pop(key, None)
        manifest.update(engineCommit=args.engine_commit, version='1.1.0', files=sources,
                        aiUse='OpenAI Codex and Anthropic Claude assisted research, implementation, verification and writing under human team members Arya Ergin and Aras. Deterministic calculations; no runtime AI.')
        manifest['frame']['ephemeris'] = coverage['kernel_coverage'] if 'kernel_coverage' in coverage else ephemeris.coverage()
        manifest['validation']['horizons'] = horizons
        manifest['validation']['motionDomain'] = domain
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
            old = json.loads((args.reference.parent / f'{kind}-study.json').read_bytes())
            study = deepcopy(old)
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
            study['manifest'].update(baselineBundleSha256=bundle['manifest']['bundleSha256'],
                                      generatorCommit=args.engine_commit, extendedDomainAudit=args.domain_validation.name,
                                      aiUse=manifest['aiUse'], frame=manifest['frame'],
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
    parser.add_argument('--engine-commit', required=True)
    parser.add_argument('--additional-site', action='store_true')
    args = parser.parse_args()
    args.start, args.end = args.start.isoformat(), args.end.isoformat()
    build_extended(args)


if __name__ == '__main__':
    main()
