"""Strict render-source identities for the four NASA study points."""

import json
import subprocess
import sys
from copy import deepcopy
from hashlib import sha256
from pathlib import Path

import pytest

from science.ephemerides import FRAME
from science.scene_terrain import (
    checked_terrain_source,
    scene_site_rows,
    terrain_source_spec,
)
from science.sources import FILES, REGIONAL, SHA256, SITES

ROOT = Path(__file__).resolve().parents[1]
SITE07 = 'Site07_final_adj_5mpp_surf.tif'
SITE07_SHA = '38aaee10bb4da4d63e7427aa1ca25c79bdbc649d212079a04990e135462091f8'
ORIGINAL_MESH_SHA = {
    'connecting-ridge': 'f343a3c31d2738f279833c605e07f36028b0eb76fad48bcc4fbd4532914a38ae',
    'shackleton-rim': '7803b1d378e3f08597a4101643ff2829de53f906f05a9c41ac06f654b8de1641',
    'de-gerlache-rim': '862d8c0fdccb10d07fae55c8f2e7a9427b847f73de185cdef69104a8d9336c47',
}


def four_site_bundle():
    sites = []
    rows = [*SITES, ('peak-near-shackleton', 'Peak Near Shackleton', 'region', -88.811, 123.6901, 'Site07')]
    sources = [{'filename': REGIONAL, 'bytes': FILES[REGIONAL][1], 'sha256': SHA256[REGIONAL]}]
    for identifier, name, _region, lat, lon, tile in rows:
        filename = f'{tile}_final_adj_5mpp_surf.tif'
        pin = SITE07_SHA if tile == 'Site07' else SHA256[filename]
        size = 40980808 if tile == 'Site07' else FILES[filename][1]
        sources.append({'filename': filename, 'sha256': pin, 'bytes': size})
        sites.append({'id': identifier, 'name': name, 'lat': lat, 'lon': lon, 'heightM': 2., 'groundM': 100.,
                      'referenceRadiusM': 1737400., 'source': 'https://ntrs.nasa.gov/citations/20250002845',
                      'sourceFrame': 'DE421 MOON_ME', 'workingFrame': FRAME,
                      'coordinateStatus': 'Published region center',
                      'terrain': {level: {'local': {'filename': filename}, 'regional': {'filename': REGIONAL},
                                          'groundM': 100., 'observerRadiusM': 1737502.}
                                  for level in ('coarse', 'fine')}})
    return {'sites': sites, 'manifest': {'files': sources, 'frame': {'working': FRAME}}}


def test_registry_uses_actual_site_order_and_r07_own_tile():
    bundle = four_site_bundle()
    actual = scene_site_rows(bundle)
    assert [(row[0], row[3], row[4], row[5]) for row in actual][-1] == (
        'peak-near-shackleton', -88.811, 123.6901, 'Site07')
    assert len(actual) == 4
    bundle['sites'].reverse()
    assert [row[0] for row in scene_site_rows(bundle)] == [site['id'] for site in bundle['sites']]


@pytest.mark.parametrize('change', ['duplicate', 'unknown', 'latitude', 'longitude', 'height',
                                  'radius', 'frame', 'working_frame', 'bundle_frame', 'source',
                                  'borrowed_tile', 'regional_tile', 'observer_radius', 'source_hash',
                                  'source_bytes', 'duplicate_source'])
def test_registry_rejects_changed_unsupported_or_borrowed_observer_inputs(change):
    bundle = four_site_bundle()
    site = bundle['sites'][-1]
    if change == 'duplicate':
        bundle['sites'].append(deepcopy(site))
    elif change == 'unknown':
        site['id'] = 'arbitrary-landing'
    elif change == 'latitude':
        site['lat'] += .01
    elif change == 'longitude':
        site['lon'] += 360
    elif change == 'height':
        site['heightM'] = 5.
    elif change == 'radius':
        site['referenceRadiusM'] += 100
    elif change == 'frame':
        site['sourceFrame'] = 'J2000'
    elif change == 'working_frame':
        site['workingFrame'] = 'J2000'
    elif change == 'bundle_frame':
        bundle['manifest']['frame']['working'] = 'J2000'
    elif change == 'source':
        site['source'] = 'unverified-data'
    elif change == 'borrowed_tile':
        site['terrain']['fine']['local']['filename'] = 'Site11_final_adj_5mpp_surf.tif'
    elif change == 'regional_tile':
        site['terrain']['coarse']['regional']['filename'] = SITE07
    elif change == 'observer_radius':
        site['terrain']['fine']['observerRadiusM'] += 1
    elif change == 'source_hash':
        bundle['manifest']['files'][-1]['sha256'] = '0' * 64
    elif change == 'duplicate_source':
        bundle['manifest']['files'].append(deepcopy(bundle['manifest']['files'][-1]))
    else:
        bundle['manifest']['files'][-1]['bytes'] -= 1
    with pytest.raises(ValueError):
        scene_site_rows(bundle)


def test_r07_source_spec_retains_own_nasa_retrieval_pin_and_acquisition():
    pin = terrain_source_spec(SITE07)
    assert pin['sha256'] == SITE07_SHA
    assert pin['expectedBytes'] == 40980808
    assert pin['url'] == 'https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/Site07/Site07_final_adj_5mpp_surf.tif'
    assert pin['acquiredUtc'] == '2026-11-14T22:54:32.292859+00:00'
    assert pin['publisherChecksumAvailable'] is False
    assert 'retrieval pin' in pin['checksumOrigin']
    with pytest.raises(ValueError, match='source'):
        terrain_source_spec('Site99_final_adj_5mpp_surf.tif')


def test_bad_observer_fails_before_source_reads_or_output_creation(tmp_path, monkeypatch):
    from science.scene_terrain import build_scenes

    bundle = four_site_bundle()
    bundle['sites'][-1]['heightM'] = 5.
    path = tmp_path / 'bundle.json'
    path.write_text(json.dumps(bundle), encoding='utf-8')
    def forbidden(*_, **__):
        pytest.fail('Invalid observer must fail before opening NASA source files')
    monkeypatch.setattr('science.scene_terrain._sha256', forbidden)
    with pytest.raises(ValueError):
        build_scenes(tmp_path, path, tmp_path / 'output')
    assert not (tmp_path / 'output').exists()


def test_truncated_source_is_rejected_without_being_overwritten(tmp_path):
    path = tmp_path / SITE07
    path.write_bytes(b'not a NASA terrain tile')
    with pytest.raises(ValueError, match='bytes|pin|source'):
        checked_terrain_source(tmp_path, SITE07)
    assert path.read_bytes() == b'not a NASA terrain tile'


def test_a_correct_size_source_with_changed_hash_cannot_be_rendered(monkeypatch):
    raw = ROOT / 'data/raw'
    if not (raw / SITE07).is_file():
        pytest.skip('Optional pinned NASA R07 DEM is unavailable')
    monkeypatch.setattr('science.scene_terrain._sha256', lambda _: '0' * 64)
    with pytest.raises(ValueError, match='SHA-256'):
        checked_terrain_source(raw, SITE07)


@pytest.mark.parametrize('order', [('extended_sites', 'rendering_notes', 'scene_terrain'),
                                  ('scene_terrain', 'rendering_notes', 'extended_sites')])
def test_lazy_registry_imports_have_no_extended_site_circular_dependency(order):
    imports = ';'.join(f'import science.{name}' for name in order)
    code = f"import sys;sys.path.insert(0,'.venv/vendor');{imports};from science.scene_terrain import terrain_source_spec;assert terrain_source_spec('{SITE07}')['sha256']=='{SITE07_SHA}'"
    result = subprocess.run([sys.executable, '-c', code], cwd=ROOT, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr


def test_actual_four_site_meshes_and_native_slope_use_own_sources(tmp_path):
    from science.rendering_notes import build_notes
    from science.scene_terrain import build_scenes

    raw = ROOT / 'data/raw'
    required = [REGIONAL, SITE07, *(f'{row[5]}_final_adj_5mpp_surf.tif' for row in SITES)]
    if not all((raw / filename).is_file() for filename in required):
        pytest.skip('Optional pinned NASA raw DEMs are unavailable')
    bundle = json.loads((ROOT / 'web/data/bundle.json').read_bytes())
    bundle['sites'] = [site for site in bundle['sites'] if site['id'] != 'peak-near-shackleton']
    extra = four_site_bundle()['sites'][-1]
    extra['groundM'] = 1645.548828125
    for level in ('coarse', 'fine'):
        extra['terrain'][level].update(groundM=extra['groundM'], observerRadiusM=1739047.548828125)
    bundle['sites'].append(extra)
    bundle['manifest']['files'] = [source for source in bundle['manifest']['files'] if source['filename'] != SITE07]
    bundle['manifest']['files'].append({'filename': SITE07, 'sha256': SITE07_SHA, 'bytes': 40980808})
    path = tmp_path / 'bundle.json'
    path.write_text(json.dumps(bundle), encoding='utf-8')
    scenes = build_scenes(raw, path, tmp_path / 'scenes')
    assert scenes['verticalExaggeration'] == scenes['metresPerUnit'] == 1
    assert len(scenes['sites']) == 4
    for site in scenes['sites']:
        data = (tmp_path / 'scenes' / site['positionFile']).read_bytes()
        assert sha256(data).hexdigest() == site['sha256']
        if site['siteId'] in ORIGINAL_MESH_SHA:
            assert site['sha256'] == ORIGINAL_MESH_SHA[site['siteId']]
        else:
            assert site['siteId'] == 'peak-near-shackleton'
            assert site['positionFile'] == 'terrain-peak-near-shackleton.mesh'
            assert site['missingCellCount'] == 0
            assert site['sha256'] not in ORIGINAL_MESH_SHA.values()
    source = next(item for item in scenes['sources'] if item['filename'] == SITE07)
    assert source['sha256'] == SITE07_SHA and source['publisherChecksumAvailable'] is False
    notes = build_notes(raw, path, tmp_path / 'rendering-notes.json')
    note = next(site for site in notes['sites'] if site['siteId'] == 'peak-near-shackleton')
    assert note['source']['filename'] == SITE07 and note['source']['sha256'] == SITE07_SHA
    assert note['source']['publisherChecksumAvailable'] is False
    assert note['slope']['status'] == 'COMPUTED'
    assert note['slope']['slopeDeg'] == pytest.approx(5.0046269278896665, abs=1e-8)


def test_actual_r07_only_notes_do_not_borrow_demo_site_and_wrong_ground_is_rejected(tmp_path):
    from science.rendering_notes import build_notes

    raw = ROOT / 'data/raw'
    if not (raw / SITE07).is_file():
        pytest.skip('Optional pinned NASA R07 DEM is unavailable')
    bundle = four_site_bundle()
    site = bundle['sites'][-1]
    bundle['sites'] = [site]
    site['groundM'] = 1645.548828125
    for level in ('coarse', 'fine'):
        site['terrain'][level].update(groundM=site['groundM'], observerRadiusM=1739047.548828125)
    path = tmp_path / 'bundle.json'
    path.write_text(json.dumps(bundle), encoding='utf-8')
    notes = build_notes(raw, path, tmp_path / 'notes.json')
    assert [note['siteId'] for note in notes['sites']] == ['peak-near-shackleton']
    assert notes['recoveryStartRayAudit']['status'] == 'INDETERMINATE'
    assert 'not present' in notes['recoveryStartRayAudit']['reason']
    site['groundM'] += 1
    for level in ('coarse', 'fine'):
        site['terrain'][level]['groundM'] += 1
        site['terrain'][level]['observerRadiusM'] += 1
    path.write_text(json.dumps(bundle), encoding='utf-8')
    with pytest.raises(ValueError, match='Native observer ground'):
        build_notes(raw, path, tmp_path / 'incorrect-notes.json')
    assert not (tmp_path / 'incorrect-notes.json').exists()


def test_atlas_limits_do_not_pretend_only_three_cached_sites_and_credit_team(tmp_path):
    from science.atlas import build_atlas

    raw = ROOT / 'data/raw'
    if not (raw / REGIONAL).is_file():
        pytest.skip('Optional pinned NASA regional DEM is unavailable')
    atlas = build_atlas(raw, tmp_path)
    assert not any('three exact' in limitation.lower() for limitation in atlas['limits'])
    assert any('cached study points' in limitation for limitation in atlas['limits'])
    assert all(name in atlas['aiUse'] for name in ('Arya Ergin', 'Aras', 'Codex', 'Claude'))
    assert atlas['display']['sha256'] == '2fc3338e89550c814984c8c423e971e31ccdcce6412a8c58d599eb57d138b35c'
