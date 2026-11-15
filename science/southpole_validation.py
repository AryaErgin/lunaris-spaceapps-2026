"""Additive south-pole acceptance checks; sampled agreement is not flight validation.

No terrain or visibility cache is generated here. Frozen records are compared
before direct SPICE, primary-reference and dense numerical checks are attempted.
"""
from __future__ import annotations

import argparse
import json
import time
from copy import deepcopy
from datetime import UTC, date, datetime
from hashlib import sha256
from math import ceil, isfinite
from pathlib import Path

import numpy as np

from science.domain_validation import _kernel_provenance, audit_domain
from science.ephemerides import (
    CORRECTION,
    FRAME,
    Ephemeris,
    angular_distance_deg,
    enu_basis,
    horizons_validation,
    parse_horizons,
    unit_from_azimuth_elevation,
    validate_horizons_header,
)
from science.extended import _validated_motion
from science.motion_envelope import validate_motion_envelope
from science.terrain import RADIUS_M
from science.validate_extension import (
    audit_claims,
    validate_retained,
    verify_payload_fingerprint,
)

FROZEN_IDS = frozenset(('connecting-ridge', 'shackleton-rim', 'de-gerlache-rim', 'peak-near-shackleton'))
START = int(datetime(2026, 11, 1, tzinfo=UTC).timestamp())
END = int(datetime(2028, 1, 1, tzinfo=UTC).timestamp())
COMPARISON_DATES = (date(2026, 11, 1), date(2026, 12, 1),
                    *(date(2027, month, 1) for month in range(1, 13)), date(2028, 1, 1))


def _canonical(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, sort_keys=True,
                      separators=(',', ':')).encode('utf-8')


def _digest(path):
    with Path(path).open('rb') as stream:
        from hashlib import file_digest
        return file_digest(stream, 'sha256').hexdigest()


def _write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_bytes(_canonical(value) + b'\n')
    temporary.replace(path)


def _radius(site):
    values = [site.get(key) for key in ('referenceRadiusM', 'groundM', 'heightM')]
    if not all(isinstance(value, (int, float)) and isfinite(value) for value in values):
        raise ValueError('Missing finite observer radius components')
    return sum(values)


def _site_rows():
    from science.southpole_sites import SOUTHPOLE_SITES
    return SOUTHPOLE_SITES


def validate_structure(baseline, bundle, skylines_by_id, *, site_rows=None):
    """Verify immutable originals, exact new observers and every interval/sample."""
    baseline_hash = verify_payload_fingerprint(baseline)
    bundle_hash = verify_payload_fingerprint(bundle)
    if baseline.get('coverage') != [START, END] or bundle.get('coverage') != [START, END]:
        raise ValueError('Expansion requires the unchanged 426-day coverage')
    old = {site['id']: site for site in baseline['sites']}
    actual = {site['id']: site for site in bundle['sites']}
    if (set(old) != FROZEN_IDS or len(old) != len(baseline['sites'])
            or len(actual) != len(bundle['sites'])):
        raise ValueError('Missing or duplicate frozen site identity')
    rows = list(_site_rows() if site_rows is None else site_rows)
    expected = {row[0]: row for row in rows}
    if len(rows) != 6 or len(expected) != 6 or set(actual) != FROZEN_IDS | set(expected):
        raise ValueError('Expansion requires exactly the four frozen and six declared new sites')
    if set(skylines_by_id) != set(expected):
        raise ValueError('Source-checked skyline inventory differs from the six additions')
    frozen_hashes = {}
    for identifier, former in old.items():
        if _canonical(former) != _canonical(actual.get(identifier)):
            raise ValueError(f'Changed frozen scientific site record: {identifier}')
        frozen_hashes[identifier] = sha256(_canonical(former)).hexdigest()
    for identifier, row in expected.items():
        site = actual[identifier]
        if ((site.get('lat'), site.get('lon'), site.get('heightM'), site.get('referenceRadiusM'))
                != (row[3], row[4], 2., RADIUS_M)):
            raise ValueError(f'Changed exact new observer identity: {identifier}')
        if (site.get('workingFrame') != FRAME or site.get('sourceFrame') != 'DE421 MOON_ME'
                or site.get('source') != 'https://ntrs.nasa.gov/citations/20250002845'
                or site.get('coordinateStatus') != 'Published region center'):
            raise ValueError(f'Changed new coordinate source/frame: {identifier}')
        radius = _radius(site)
        models = skylines_by_id[identifier]
        if set(models) != {'coarse', 'fine'}:
            raise ValueError('Both source-checked skyline models are required')
        for level, count in (('coarse', 1800), ('fine', 3600)):
            sky = models[level]
            for name in ('lower', 'upper', 'gap'):
                values = np.asarray(getattr(sky, name), dtype=float)
                if values.shape != (count,) or not np.all(np.isfinite(values)) or np.any(np.abs(values) > 90):
                    raise ValueError(f'Invalid {level} skyline {name} enclosure')
            if np.any(sky.lower > sky.upper) or not isfinite(float(sky.far_cap)) or abs(sky.far_cap) > 90:
                raise ValueError('Inverted skyline bounds or invalid far-field cap')
            if (_canonical(site['terrain'][level]) != _canonical(sky.info)
                    or sky.info.get('observerRadiusM') != radius
                    or sky.info.get('groundM') != site['groundM']):
                raise ValueError('Skyline metadata differs from the bundle observer/terrain model')
        for target in ('sun', 'earth'):
            refinements = site['refinementIntervals'][target]
            validate_retained(site[target], refinements['coarse'], refinements['fine'], [START, END])
        geometry = site.get('geometry')
        if not isinstance(geometry, list) or len(geometry) != 20449:
            raise ValueError('Every addition requires 20449 actual half-hour geometry rows')
        for index, sample in enumerate(geometry):
            if (not isinstance(sample, (list, tuple)) or len(sample) != 7
                    or sample[0] != START + index * 1800):
                raise ValueError('Geometry cadence/coverage/columns differ')
            if any(not isinstance(sample[col], (int, float)) or not isfinite(sample[col]) for col in (1, 2, 4, 5)):
                raise ValueError('Missing finite cached Sun/Earth directions')
            if any(not 0 <= sample[col] < 360 for col in (1, 4)) or any(abs(sample[col]) > 90 for col in (2, 5)):
                raise ValueError('Geometry direction is outside azimuth/elevation bounds')
    return {'status': 'PASS', 'baselinePayloadSha256': baseline_hash, 'expandedPayloadSha256': bundle_hash,
            'frozenSiteSha256': frozen_hashes, 'newSiteIds': [row[0] for row in rows], 'coverage': [START, END]}


def validate_horizons_report(report, sites, archive):
    """Strict inventory, epochs, finite residuals and archived-byte identity gate."""
    expected = {(site['id'], body) for site in sites for body in ('sun', 'earth')}
    records = report.get('references', [])
    actual = {(record['site_id'], record['target']) for record in records}
    if not sites or len(records) != len(expected) or actual != expected:
        raise ValueError('Incomplete or duplicate Horizons site/target inventory')
    if (report.get('status') != 'PASS' or report.get('angular_tolerance_deg') != .01
            or report.get('comparison_count') != len(expected) * len(COMPARISON_DATES)
            or not report.get('retrieved_utc')):
        raise ValueError('Horizons status/count/tolerance/acquisition metadata is incomplete')
    by_id = {site['id']: site for site in sites}
    stamps = [day.isoformat() + 'T00:00:00Z' for day in COMPARISON_DATES]
    separations = []
    for record in records:
        site = by_id[record['site_id']]
        if ((record.get('latitude_deg'), record.get('longitude_deg_east'), record.get('observer_radius_m'))
                != (site['lat'], site['lon'] % 360, _radius(site))):
            raise ValueError('Horizons observer differs from the native terrain observer')
        samples = record.get('samples', [])
        if [sample.get('utc') for sample in samples] != stamps:
            raise ValueError('Horizons samples must include every unique declared epoch in order')
        for sample in samples:
            value = sample.get('separation_deg')
            if not isinstance(value, (int, float)) or not isfinite(value) or not 0 <= value < .01:
                raise ValueError('Invalid or failing Horizons direction residual')
            separations.append(value)
        name = record.get('source_filename', '')
        if not name or Path(name).name != name or '/' in name or '\\' in name:
            raise ValueError('Invalid archived reference filename')
        path = Path(archive) / name
        if path.stat().st_size != record.get('source_bytes') or _digest(path) != record.get('source_sha256'):
            raise ValueError('Horizons archive byte count or SHA-256 differs')
        if not record.get('url', '').startswith('https://ssd.jpl.nasa.gov/'):
            raise ValueError('Horizons reference does not identify the primary service')
    maximum = max(separations)
    if report.get('max_angular_separation_deg') != maximum:
        raise ValueError('Horizons aggregate maximum differs from actual reference samples')
    return {'status': 'PASS', 'comparison_count': len(separations), 'max_angular_separation_deg': maximum,
            'scope': 'Matched sampled JPL implementations, not independent terrain or physical validation.'}


def audit_site_claims(ephemeris, site, models, coverage):
    """Replay every retained/coarse/fine definite interval with direct vectors."""
    radius, vector_cache = _radius(site), {}

    def provider(epochs):
        missing = sorted(set(epochs) - vector_cache.keys())
        if missing:
            sun, earth = ephemeris.vectors(site['lat'], site['lon'], radius, missing)
            vector_cache.update({epoch: (sun[i], earth[i]) for i, epoch in enumerate(missing)})
        return tuple(np.array([vector_cache[epoch][index] for epoch in epochs]) for index in (0, 1))

    output, points = {}, 0
    for target in ('sun', 'earth'):
        output[target] = {}
        for level in ('retained', 'coarse', 'fine'):
            intervals = site[target] if level == 'retained' else site['refinementIntervals'][target][level]
            chosen = models if level == 'retained' else {level: models[level]}
            report = audit_claims(intervals, target, coverage, chosen, provider)
            if report['contradictions'] or report['status'] == 'FAIL':
                raise ValueError(f'Point-audit contradiction: {site["id"]}/{target}/{level}: {report["errors"][:2]}')
            output[target][level] = report
            points += report['sampledPoints']
    return {'status': 'PASS' if points else 'INDETERMINATE', 'siteId': site['id'],
            'sampledPoints': points, 'uniqueSpiceEpochs': len(vector_cache), 'channels': output,
            'scope': 'Three strict interior samples per definite interval. Passing samples do not prove continuous physical accuracy.'}


def audit_native_samples(lat, lon, observer_radius_m, sample_lat, sample_lon, heights, sky):
    """Independent 3D Cartesian native-cell-center oracle for an upper skyline."""
    try:
        observer = np.asarray((lat, lon, observer_radius_m), dtype=float)
        sample_lat, sample_lon, heights = (np.asarray(values, dtype=float)
                                          for values in (sample_lat, sample_lon, heights))
        upper = np.asarray(sky.upper, dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError('Native horizon audit requires numeric observer, sample and skyline arrays') from error
    if (observer.shape != (3,) or not np.all(np.isfinite(observer))
            or abs(observer[0]) > 90 or observer[2] <= 0):
        raise ValueError('Native horizon audit requires finite observer coordinates and a positive radius')
    if (heights.ndim != 1 or not heights.size or sample_lat.shape != heights.shape
            or sample_lon.shape != heights.shape
            or any(not np.all(np.isfinite(values)) for values in (sample_lat, sample_lon, heights))
            or np.any(np.abs(sample_lat) > 90)):
        raise ValueError('Native horizon audit requires matching nonempty finite one-dimensional terrain samples')
    if (upper.ndim != 1 or not upper.size or not np.all(np.isfinite(upper))
            or np.any(np.abs(upper) > 90)):
        raise ValueError('Native horizon audit requires a nonempty finite angular upper skyline')
    lat, lon, observer_radius_m = observer
    phi, lam = np.deg2rad(sample_lat), np.deg2rad(sample_lon)
    radii = RADIUS_M + heights
    if not np.all(np.isfinite(radii)) or np.any(radii <= 0):
        raise ValueError('Native sample radial distances must be finite and positive')
    direction = np.stack((np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)), axis=-1)
    basis = enu_basis(lat, lon)
    with np.errstate(over='ignore', invalid='ignore'):
        difference = direction * radii[..., None] - basis[2] * observer_radius_m
        vectors = difference @ basis.T
    lengths = np.hypot(np.hypot(vectors[:, 0], vectors[:, 1]), vectors[:, 2])
    if not np.all(np.isfinite(vectors)) or not np.all(np.isfinite(lengths)) or np.any(lengths <= 0):
        raise ValueError('Native observer-to-sample vectors must be finite and nonzero')
    east, north, up = np.moveaxis(vectors, -1, 0)
    azimuth = np.degrees(np.arctan2(east, north)) % 360
    elevation = np.degrees(np.arctan2(up, np.hypot(east, north)))
    if not np.all(np.isfinite(azimuth)) or not np.all(np.isfinite(elevation)):
        raise ValueError('Native sample angles must be finite')
    sectors = np.floor(azimuth * len(upper) / 360).astype(int) % len(upper)
    excess = elevation - upper[sectors]
    if not np.all(np.isfinite(excess)):
        raise ValueError('Native sample-minus-upper differences must be finite')
    if np.any(excess > 1e-8):
        raise ValueError(f'Native Cartesian terrain center exceeds skyline upper bound by {float(excess.max())} degrees')
    return {'status': 'PASS', 'sampleCount': int(heights.size), 'maxCenterMinusUpperDeg': float(excess.max()),
            'scope': 'Sparse native-cell centers only; no independent physical terrain accuracy or continuous footprint proof.'}


def _verify_native_sources(raw, bundle, skylines_by_id):
    """Verify every native ring pin once, before point or remote calculations."""
    needed = set()
    for models in skylines_by_id.values():
        for sky in models.values():
            for ring in sky.info.get('scanRings', []):
                needed.add(ring['filename'])
    if not needed:
        raise ValueError('Native horizon provenance lacks explicit scan rings')
    records = bundle.get('manifest', {}).get('files', [])
    output = []
    for name in sorted(needed):
        if Path(name).name != name or '/' in name or '\\' in name:
            raise ValueError('Invalid native ring filename')
        matches = [row for row in records if row.get('filename') == name]
        if len(matches) != 1:
            raise ValueError(f'Missing or duplicate native ring source pin: {name}')
        record, path = matches[0], Path(raw) / name
        if (path.stat().st_size != record.get('bytes') or _digest(path) != record.get('sha256')):
            raise ValueError(f'Native ring source bytes/hash differ: {name}')
        output.append({'filename': name, 'bytes': record['bytes'], 'sha256': record['sha256']})
    return output


def _audit_native_rings(raw, site, models):
    """Sample native centers via pyproj and direct Cartesian observer vectors.

    Unlike the scanner, this uses neither terrain.project/unproject nor its
    elevation/range formulas. It checks sampled centers, not whole footprints.
    """
    import rasterio
    from pyproj import CRS, Transformer
    from rasterio.windows import Window
    geographic = CRS.from_proj4('+proj=longlat +R=1737400 +no_defs')
    basis = enu_basis(site['lat'], site['lon'])
    output, total = [], 0
    for level, sky in models.items():
        rings = sky.info.get('scanRings')
        if not rings:
            raise ValueError('Native oracle requires explicit active terrain annuli')
        for ring in rings:
            inner, outer = ring['innerM'], ring['outerM']
            if not all(isfinite(x) for x in (inner, outer)) or not 0 <= inner < outer:
                raise ValueError('Invalid native audit annulus')
            with rasterio.open(Path(raw) / ring['filename']) as dataset:
                forward = Transformer.from_crs(geographic, dataset.crs, always_xy=True)
                inverse = Transformer.from_crs(dataset.crs, geographic, always_xy=True)
                pixels = set()
                for fraction in (.05, .5, .95):
                    distance = inner + fraction * (outer - inner)
                    theta = distance / RADIUS_M
                    for azimuth in np.linspace(0, 2 * np.pi, 24, endpoint=False):
                        direction = (np.cos(theta) * basis[2] + np.sin(theta)
                                     * (np.sin(azimuth) * basis[0] + np.cos(azimuth) * basis[1]))
                        lat = np.degrees(np.arctan2(direction[2], np.hypot(direction[0], direction[1])))
                        lon = np.degrees(np.arctan2(direction[1], direction[0]))
                        x, y = forward.transform(lon, lat)
                        pixels.add(dataset.index(x, y))
                latitudes, longitudes, heights = [], [], []
                missing = 0
                for row, col in sorted(pixels):
                    if not 0 <= row < dataset.height or not 0 <= col < dataset.width:
                        missing += 1
                        continue
                    value = dataset.read(1, window=Window(col, row, 1, 1), masked=True)[0, 0]
                    if np.ma.is_masked(value) or not np.isfinite(value):
                        missing += 1
                        continue
                    x, y = dataset.xy(row, col)
                    lon, lat = inverse.transform(x, y)
                    phi, lam = np.deg2rad((lat, lon))
                    direction = np.array([np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)])
                    distance = np.arctan2(np.linalg.norm(np.cross(basis[2], direction)), np.dot(basis[2], direction)) * RADIUS_M
                    if inner < distance < outer:
                        latitudes.append(lat)
                        longitudes.append(lon)
                        heights.append(float(value))
                if heights:
                    result = audit_native_samples(site['lat'], site['lon'], _radius(site), latitudes, longitudes, heights, sky)
                    total += len(heights)
                else:
                    result = {'status': 'INDETERMINATE', 'sampleCount': 0}
                output.append({'level': level, **ring, **result, 'missingRequestedCells': missing})
    return {'status': 'PASS' if output and all(row['status'] == 'PASS' for row in output) else 'INDETERMINATE',
            'sampleCount': total, 'rings': output,
            'scope': 'Independent sparse native-cell Cartesian consistency check, not continuous terrain enclosure or observational validation.'}


def validate_cached_reference_geometry(site, reference):
    """Bind cached plot angles to the independently replayed reference epochs."""
    az_col, el_col = (1, 2) if reference['target'] == 'sun' else (4, 5)
    for sample in reference['samples']:
        epoch = int(datetime.fromisoformat(sample['utc']).timestamp())
        index, remainder = divmod(epoch - START, 1800)
        if remainder or index < 0 or index >= len(site['geometry']):
            raise ValueError('Reference epoch lacks an exact cached geometry sample')
        row = site['geometry'][index]
        azimuth_error = abs((row[az_col] - sample['spice_azimuth_deg'] + 180) % 360 - 180)
        elevation_error = abs(row[el_col] - sample['spice_elevation_deg'])
        if row[0] != epoch or azimuth_error > .00000501 or elevation_error > .00000501:
            raise ValueError('Reference direction differs beyond cached geometry serialization tolerance')
    return {'status': 'PASS', 'sampleCount': len(reference['samples'])}


def _verify_reference_angles(report, sites, archive, ephemeris):
    by_id = {site['id']: site for site in sites}
    for record in report['references']:
        site = by_id[record['site_id']]
        text = (Path(archive) / record['source_filename']).read_text(encoding='utf-8')
        target = '10' if record['target'] == 'sun' else '399'
        validate_horizons_header(text, record['target'], target, site['lat'], site['lon'], _radius(site))
        rows = {row['utc']: row for row in parse_horizons(text)}
        epochs = [datetime.fromisoformat(sample['utc']).timestamp() for sample in record['samples']]
        vectors = ephemeris.vectors(site['lat'], site['lon'], _radius(site), epochs)
        selected = vectors[0 if record['target'] == 'sun' else 1]
        for vector, sample in zip(selected, record['samples'], strict=True):
            archived = rows[sample['utc']]
            if (archived['azimuth_deg'], archived['elevation_deg']) != (sample['horizons_azimuth_deg'], sample['horizons_elevation_deg']):
                raise ValueError('Reference angles differ from archived primary response')
            residual = float(angular_distance_deg(vector, unit_from_azimuth_elevation(archived['azimuth_deg'], archived['elevation_deg'])))
            if residual >= .01 or abs(residual - sample['separation_deg']) > 1e-10:
                raise ValueError('Replayed SPICE/Horizons residual differs from archived comparison')
        validate_cached_reference_geometry(site, record)


def _merge_domain_reports(reports, sites, kernel_hashes):
    """Merge only complete one-observer executions with identical model scope."""
    expected = {site['id']: site for site in sites}
    inventory = [report.get('sites', [{}])[0].get('site_id') for report in reports]
    if (not expected or len(expected) != len(sites) or len(reports) != len(expected)
            or len(set(inventory)) != len(inventory) or set(inventory) != set(expected)):
        raise ValueError('Parallel domain observer inventory is incomplete or duplicated')
    common = ('frame', 'correction', 'start_utc', 'end_utc', 'cadence_seconds',
              'interlaced_cadence_seconds', 'sampled_only', 'between_sample_bound_proven',
              'kernels', 'code_sha256', 'coverage', 'limits', 'state_units', 'rate_method')
    for report, identifier in zip(reports, inventory, strict=True):
        _validate_domain(report, [expected[identifier]], kernel_hashes)
        if any(_canonical(report.get(key)) != _canonical(reports[0].get(key)) for key in common):
            raise ValueError('Parallel domain workers use different code, kernels or numerical scope')
    result = deepcopy(reports[0])
    by_id = {identifier: report['sites'][0] for identifier, report in zip(inventory, reports, strict=True)}
    result['sites'] = [deepcopy(by_id[site['id']]) for site in sites]
    result['interlaced_check']['maximum_angular_rate_change_deg_min'] = max(
        report['interlaced_check']['maximum_angular_rate_change_deg_min'] for report in reports)
    return result


def _domain_worker(job):
    """Picklable Windows process worker; raw kernels remain read-only."""
    import os
    raw, site, directory, generator_commit = job
    raw, directory = Path(raw), Path(directory)
    identifier = site['id']
    path = directory / f'domain-observer-{identifier}.json'
    hashes = {row['filename']: row['sha256'] for row in _kernel_provenance(raw)}
    if path.is_file():
        report = json.loads(path.read_bytes())
        _validate_domain(report, [site], hashes)
        return report
    started, last_update = time.perf_counter(), [time.monotonic()]
    began_utc = datetime.now(UTC).isoformat()

    def progress(event):
        if time.monotonic() - last_update[0] >= 30:
            print(f'Dense domain {identifier}: {event["sample_count"]} epochs; interlaced={event["interlaced_grid"]}', flush=True)
            last_update[0] = time.monotonic()

    report = audit_domain(raw, [(identifier, site['lat'], site['lon'], _radius(site))], START, END,
                          cadence_seconds=60, interlaced=True, generator_commit=generator_commit, progress=progress)
    report['execution'] = {'started_utc': began_utc, 'completed_utc': datetime.now(UTC).isoformat(),
                           'elapsed_seconds': time.perf_counter() - started, 'process_id': os.getpid(),
                           'observer_count': 1, 'method': 'One observer per bounded local process; no terrain or geometry cache writes.'}
    _validate_domain(report, [site], hashes)
    _write(path, report)
    return report


def run_domain_parallel(raw, sites, outdir, generator_commit=None, jobs=3):
    """Run six independent 60 s/interlaced observer audits with at most 3 workers.

    Completed one-observer reports are revalidated and reused. The final report
    is published only after a strict inventory/provenance/count merge succeeds.
    """
    from concurrent.futures import ProcessPoolExecutor
    sites = list(sites)
    if isinstance(jobs, bool) or not isinstance(jobs, int) or not 1 <= jobs <= 3:
        raise ValueError('Use one to three bounded domain processes')
    if len(sites) != 6 or len({site['id'] for site in sites}) != 6:
        raise ValueError('The parallel domain audit requires six distinct new observers')
    expected = {row[0]: row for row in _site_rows()}
    for site in sites:
        row = expected.get(site['id'])
        if row is None or (site['lat'], site['lon'], site['heightM'], site['referenceRadiusM']) != (row[3], row[4], 2., RADIUS_M):
            raise ValueError('Parallel domain observer differs from the declared new study point')
        _radius(site)
    raw, outdir = Path(raw), Path(outdir)
    hashes = {row['filename']: row['sha256'] for row in _kernel_provenance(raw)}
    destination = outdir / 'domain-validation.json'
    if destination.is_file():
        report = json.loads(destination.read_bytes())
        _validate_domain(report, sites, hashes)
        return report
    outdir.mkdir(parents=True, exist_ok=True)
    started, began_utc = time.perf_counter(), datetime.now(UTC).isoformat()
    tasks = [(str(raw), site, str(outdir), generator_commit) for site in sites]
    with ProcessPoolExecutor(max_workers=jobs) as pool:
        reports = list(pool.map(_domain_worker, tasks))
    report = _merge_domain_reports(reports, sites, hashes)
    report['generator_commit'] = generator_commit
    report['execution_seconds'] = time.perf_counter() - started
    report['execution'] = {'started_utc': began_utc, 'completed_utc': datetime.now(UTC).isoformat(),
                           'elapsed_seconds': report['execution_seconds'], 'max_processes': jobs,
                           'scope': 'Wall time includes validated report reuse; worker timings preserve their original execution.'}
    report['worker_reports'] = [{'site_id': site['id'], 'filename': f'domain-observer-{site["id"]}.json',
                                  'sha256': _digest(outdir / f'domain-observer-{site["id"]}.json'),
                                  'generator_commit': worker.get('generator_commit'), 'execution': worker.get('execution')}
                                 for site, worker in zip(sites, reports, strict=True)]
    _validate_domain(report, sites, hashes)
    _write(destination, report)
    return report


def validate_expansion(raw, baseline, bundle, skylines_by_id, archive, outdir, generator_commit=None,
                       *, run_domain=True, run_motion=True, acquire_horizons=True):
    """Execute required checks; disabled/missing required evidence yields INDETERMINATE.

    ``baseline`` and ``bundle`` are parsed dictionaries. ``skylines_by_id`` maps
    each new ID to its source-checked ``coarse`` and ``fine`` Skyline objects.
    Dense checks and primary requests are cached only as fully revalidated reports.
    """
    started = time.perf_counter()
    raw, archive, outdir = map(Path, (raw, archive, outdir))
    structure = validate_structure(baseline, bundle, skylines_by_id)
    sites = [site for site in bundle['sites'] if site['id'] in skylines_by_id]
    native_sources = _verify_native_sources(raw, bundle, skylines_by_id)
    kernels = _kernel_provenance(raw)
    kernel_hashes = {entry['filename']: entry['sha256'] for entry in kernels}
    outdir.mkdir(parents=True, exist_ok=True)
    report = {'version': '1.0.0', 'status': 'INDETERMINATE', 'generator_commit': generator_commit,
              'created_utc': datetime.now(UTC).isoformat(), 'structure': structure,
              'kernels': kernels, 'siteIds': [site['id'] for site in sites], 'pointAudits': [],
              'nativeSources': native_sources, 'nativeHorizonAudits': [],
              'codeSha256': {name: _digest(Path(__file__).with_name(name)) for name in
                             ('southpole_validation.py', 'validate_extension.py', 'ephemerides.py')},
              'limitations': ['All point/dense/reference checks concern the frozen numerical model, not observational accuracy, power, RF or flight certification.']}
    path = outdir / 'southpole-validation.json'
    _write(path, report)
    with Ephemeris(raw) as ephemeris:
        ephemeris.assert_coverage(START, END)
        for site in sites:
            report['nativeHorizonAudits'].append({'siteId': site['id'], **_audit_native_rings(raw, site, skylines_by_id[site['id']])})
            report['pointAudits'].append(audit_site_claims(ephemeris, site, skylines_by_id[site['id']], [START, END]))
            _write(path, report)
        reference_path = outdir / 'horizons-validation.json'
        if reference_path.is_file():
            references = json.loads(reference_path.read_bytes())
        elif acquire_horizons:
            archive.mkdir(parents=True, exist_ok=True)
            # Avoid replacing previously acquired raw evidence without its report.
            if any(archive.glob('*.txt')):
                raise ValueError('Reference archive is nonempty without a reusable pinned report; choose a new archive directory')
            references = horizons_validation(ephemeris, [(site['id'], site['lat'], site['lon'], _radius(site)) for site in sites],
                                               COMPARISON_DATES, archive)
            references.update(kernels=kernels, generator_commit=generator_commit,
                              acquisition_completed_utc=datetime.now(UTC).isoformat(),
                              code_sha256={'ephemerides.py': _digest(Path(__file__).with_name('ephemerides.py'))})
            _write(reference_path, references)
        else:
            references = None
        if references is not None:
            if ({row['filename']: row['sha256'] for row in references.get('kernels', [])} != kernel_hashes
                    or references.get('code_sha256', {}).get('ephemerides.py') != _digest(Path(__file__).with_name('ephemerides.py'))):
                raise ValueError('Horizons kernel/code provenance differs from the current calculation')
            report['horizons'] = validate_horizons_report(references, sites, archive)
            _verify_reference_angles(references, sites, archive, ephemeris)
        else:
            report['horizons'] = {'status': 'NOT_RUN'}
    _write(path, report)
    domain_path = outdir / 'domain-validation.json'
    domain = json.loads(domain_path.read_bytes()) if domain_path.is_file() else None
    if domain is None and run_domain:
        domain = run_domain_parallel(raw, sites, outdir, generator_commit)
    if domain is not None:
        _validate_domain(domain, sites, kernel_hashes)
        report['domain'] = {'status': 'PASS', 'filename': domain_path.name, 'sha256': _digest(domain_path)}
    else:
        report['domain'] = {'status': 'NOT_RUN'}
    motion_path = outdir / 'motion-envelope.json'
    motion = json.loads(motion_path.read_bytes()) if motion_path.is_file() else deepcopy(baseline.get('manifest', {}).get('validation', {}).get('motionEnvelope'))
    needed = max(_radius(site) for site in bundle['sites']) / 1000
    if (motion is None or motion.get('observer_radius_upper_km', 0) < needed) and run_motion:
        motion = validate_motion_envelope(raw, START, END, observer_radius_km=(ceil(needed * 1000) + 1) / 1000,
                                          generator_commit=generator_commit)
    if motion is not None and motion.get('observer_radius_upper_km', 0) >= needed:
        _write(motion_path, motion)
        _validated_motion(motion_path, START, END, bundle['sites'], kernel_hashes)
        report['motion'] = {'status': 'PASS', 'filename': motion_path.name, 'sha256': _digest(motion_path),
                            'observer_radius_upper_km': motion['observer_radius_upper_km']}
    else:
        report['motion'] = {'status': 'NOT_RUN', 'required_observer_radius_km': needed}
    checks = [report[name]['status'] for name in ('horizons', 'domain', 'motion')]
    checks.extend(item['status'] for item in report['pointAudits'])
    checks.extend(item['status'] for item in report['nativeHorizonAudits'])
    report['status'] = 'PASS' if checks and all(status == 'PASS' for status in checks) else 'INDETERMINATE'
    report['execution_seconds'] = time.perf_counter() - started
    _write(path, report)
    return report


def _validate_domain(report, sites, kernel_hashes):
    if (report.get('status') != 'PASS' or report.get('frame') != FRAME or report.get('correction') != CORRECTION
            or report.get('start_utc') != '2026-11-01T00:00:00Z' or report.get('end_utc') != '2028-01-01T00:00:00Z'
            or report.get('cadence_seconds') != 60 or report.get('interlaced_cadence_seconds') != 30
            or report.get('interlaced_check', {}).get('performed') is not True
            or report.get('interlaced_check', {}).get('within_declared_tolerance') is not True
            or report.get('sampled_only') is not True or report.get('between_sample_bound_proven') is not False):
        raise ValueError('Dense domain report lacks the required 60-second/interlaced numerical checks')
    records = report.get('sites', [])
    if len(records) != len(sites) or {row['site_id'] for row in records} != {site['id'] for site in sites}:
        raise ValueError('Dense domain observer inventory differs')
    required_count = 2 * ((END - START) // 60) + 1
    required_checks = {'sun_angular_rate_below_envelope', 'earth_angular_rate_below_envelope',
                       'earth_range_above_assumed_minimum', 'earth_abs_range_rate_below_assumed_maximum',
                       'sampled_light_times_inside_coverage_guard'}
    for site in sites:
        row = next(row for row in records if row['site_id'] == site['id'])
        if ((row.get('latitude_deg'), row.get('longitude_deg_east'), row.get('observer_radius_m'))
                != (site['lat'], site['lon'] % 360, _radius(site))
                or row.get('status') != 'PASS' or not required_checks <= row.get('checks', {}).keys()
                or not all(value is True for value in row['checks'].values())
                or any(row.get(target, {}).get('sample_count') != required_count for target in ('sun', 'earth'))):
            raise ValueError('Dense domain observer/count/checks differ from required new site')
    if {row['filename']: row['sha256'] for row in report.get('kernels', [])} != kernel_hashes:
        raise ValueError('Dense domain kernel pins differ')
    for name in ('domain_validation.py', 'ephemerides.py'):
        if report.get('code_sha256', {}).get(name) != _digest(Path(__file__).with_name(name)):
            raise ValueError('Dense domain code provenance differs')


def _load_existing_skylines(raw, baseline, cache):
    """Read exact builder cache identities without ever invoking a cache build."""
    import importlib

    from science.extended import _signature, _skyline_fingerprint, runtime_versions
    from science.terrain import Skyline
    expansion = importlib.import_module('science.southpole_expand')
    definitions = importlib.import_module('science.southpole_sites')
    sources = {row['filename']: row['sha256'] for row in
               baseline['manifest']['files'] + definitions.source_manifest(raw) + baseline['manifest']['kernels']}
    output = {}
    for row in definitions.SOUTHPOLE_SITES:
        identity = {'row': row, 'heightM': 2., 'sources': sources, 'code': expansion.numerical_hashes(),
                    'settings': [[1800, 200000], [3600, 240000]], 'versions': runtime_versions()}
        signature = _signature(identity)
        path = Path(cache) / f'sky-{row[0]}-{signature[:20]}.npz'
        if not path.is_file():
            raise FileNotFoundError(f'Missing exact source-checked skyline cache; validation never builds terrain: {path}')
        models = {}
        with np.load(path, allow_pickle=False) as saved:
            if str(saved['signature'].item()) != signature:
                raise ValueError('Existing skyline cache identity differs')
            for level in ('coarse', 'fine'):
                arrays = {key: saved[f'{level}_{key}'].copy() for key in ('lower', 'upper', 'nominal', 'gap', 'blockers')}
                models[level] = Skyline(**arrays, far_cap=float(saved[f'{level}_far_cap']),
                                         info=json.loads(str(saved[f'{level}_info'].item())))
            if str(saved['fingerprint'].item()) != _skyline_fingerprint(tuple(models.values()), identity):
                raise ValueError('Existing skyline cache payload fingerprint differs')
        output[row[0]] = models
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw', type=Path, default=Path('data/raw'))
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--outdir', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True, help='Source-checked skyline cache; loader supplied by southpole_expand')
    parser.add_argument('--generator-commit')
    parser.add_argument('--skip-domain', action='store_true')
    parser.add_argument('--skip-motion', action='store_true')
    parser.add_argument('--no-acquire-horizons', action='store_true')
    args = parser.parse_args()
    from science.southpole_expand import BASELINE_FILE_SHA256
    if _digest(args.baseline) != BASELINE_FILE_SHA256:
        raise ValueError('Frozen baseline file bytes differ from the builder checkpoint')
    baseline, bundle = (json.loads(path.read_bytes()) for path in (args.baseline, args.bundle))
    models = _load_existing_skylines(args.raw, baseline, args.cache)
    result = validate_expansion(args.raw, baseline, bundle, models, args.archive, args.outdir, args.generator_commit,
                                run_domain=not args.skip_domain, run_motion=not args.skip_motion,
                                acquire_horizons=not args.no_acquire_horizons)
    print(json.dumps({'status': result['status'], 'siteIds': result['siteIds'],
                      'report': str(args.outdir / 'southpole-validation.json'),
                      'execution_seconds': result['execution_seconds']}, indent=2))
    return 0 if result['status'] == 'PASS' else 2


if __name__ == '__main__':
    raise SystemExit(main())
