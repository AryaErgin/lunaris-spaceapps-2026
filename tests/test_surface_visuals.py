"""Display derivatives: geography, byte-exact seams, masks, and frozen science."""
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from tools.build_surface_visuals import BUNDLE_SHA, FrozenBoundary, local_coordinates, read_range

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "web/assets/surface"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture(scope="module")
def data():
    manifest = json.loads((ASSETS / "manifest.json").read_text())
    bundle = json.loads((ROOT / "web/data/bundle.json").read_text())
    site = next(row for row in bundle["sites"] if row["id"] == manifest["site"]["id"])
    bases = json.loads((ROOT / "web/data/terrain-scenes.json").read_text())
    base = next(row for row in bases["sites"] if row["siteId"] == site["id"])
    boundary = FrozenBoundary(site, base, (ROOT / "web/data" / base["positionFile"]).read_bytes())
    return manifest, site, base, boundary


def test_analysis_and_exact_observer_are_unchanged(data):
    manifest, site, _, _ = data
    assert sha(ROOT / "web/data/bundle.json") == BUNDLE_SHA == manifest["analysisBundleSha256"]
    assert manifest["site"] == {"id": site["id"], **{key: site[key] for key in ("lat", "lon", "groundM", "heightM")}}
    assert manifest["observer"]["rigidVerticalOffsetAppliedM"] == 0
    assert manifest["observer"]["cameraAboveNativeSfsCellM"] > 0
    assert manifest["observer"]["sfsMinusBaselineGroundM"] == pytest.approx(.3743896484375)


@pytest.mark.parametrize("quality", ["desktop", "mobile"])
def test_patch_has_finite_physical_vertices_and_exact_frozen_seam(data, quality):
    manifest, site, base, boundary = data
    record = manifest["terrain"][quality]
    payload = (ASSETS / record["positionFile"]).read_bytes()
    assert len(payload) == record["byteLength"]
    assert hashlib.sha256(payload).hexdigest() == record["sha256"]
    positions = np.frombuffer(payload, dtype="<f4", count=record["vertexCount"] * 3).reshape(-1, 3)
    indices = np.frombuffer(payload, dtype="<u4", offset=record["indicesByteOffset"], count=record["indexCount"])
    assert np.isfinite(positions).all()
    assert len(indices) % 3 == 0 and indices.max() < len(positions)
    assert record["missingCellCount"] == 0
    grid, _ = local_coordinates(site, positions)
    seam = np.flatnonzero(np.isclose(np.max(np.abs(grid), axis=1), 4000, atol=.02))
    assert len(seam) == record["seamVertexCount"] == 512
    for index in seam:
        key = tuple(np.rint(grid[index] / 62.5).astype(int))
        assert positions[index].tobytes() == boundary.edge[key].tobytes()
    assert sha(ROOT / "web/data" / base["positionFile"]) == base["sha256"]


def test_source_rasters_keep_their_individual_actual_resolutions(data):
    manifest, _, _, _ = data
    sources = {row["filename"]: row for row in manifest["sourceRasters"]}
    assert sources["A301_GLDELEV_005.tif"]["transform"][:6] == [5, 0, 147000, 0, -5, 105000]
    assert sources["A301_GLDMASK_005.tif"]["transform"][:6] == [15, 0, 147000, 0, -15, 105000]
    assert sources["A301_GLDELEV_005.tif"]["registration"] == "Area"
    assert not manifest["sourceArchive"]["fullArchiveDownloaded"]
    assert not manifest["sourceArchive"]["fullArchiveMd5Verified"]


@pytest.mark.parametrize("quality,size,spacing", [("desktop", 2000, 1), ("mobile", 1000, 2)])
def test_real_photo_bounds_quality_and_no_repeated_fake_coverage(data, quality, size, spacing):
    manifest, _, _, _ = data
    imagery = manifest["imagery"]
    texture, mask = imagery["textures"][quality], imagery["masks"][quality]
    assert imagery["historicIllumination"] and not imagery["photometricAlbedo"]
    assert texture["width"] == texture["height"] == size
    assert texture["metersPerPixel"] == spacing
    xmin, ymin, xmax, ymax = imagery["bounds"]
    assert xmax - xmin == pytest.approx(2000)
    assert ymax - ymin == pytest.approx(2000)
    assert sha(ASSETS / texture["url"]) == texture["sha256"]
    assert sha(ASSETS / mask["url"]) == mask["sha256"]
    with Image.open(ASSETS / texture["url"]) as image:
        assert image.size == (size, size)
    with Image.open(ASSETS / mask["url"]) as image:
        assert image.size == (size, size)
        assert np.asarray(image).min() == np.asarray(image).max() == 255


def test_all_ten_sources_preserve_observer_and_explicit_geometry_fallbacks(data):
    manifest, _, _, _ = data
    profiles = manifest["sites"]
    bundle = json.loads((ROOT / "web/data/bundle.json").read_text())
    assert {row["site"]["id"] for row in profiles} == {row["id"] for row in bundle["sites"]}
    assert len(profiles) == 10
    for profile in profiles:
        original = next(row for row in bundle["sites"] if row["id"] == profile["site"]["id"])
        assert profile["site"] == {"id": original["id"], **{key: original[key] for key in ("lat", "lon", "groundM", "heightM")}}
        assert profile["observer"]["rigidVerticalOffsetAppliedM"] == 0
        if profile["terrain"]:
            assert profile["observer"]["cameraAboveNativeSfsCellM"] > 0
        else:
            assert profile["surfaceStatus"] in {"SFS_NOT_COVERED", "SFS_OBSERVER_CONFLICT"}
    kocher = next(row for row in profiles if row["site"]["id"] == "de-gerlache-kocher")
    assert kocher["terrain"] is None
    assert kocher["observer"]["cameraAboveNativeSfsCellM"] < 0
    gerlache = next(row for row in profiles if row["site"]["id"] == "de-gerlache-rim")
    assert gerlache["observerSfsInputs"]["illuminatedImageCount"] == 0
    assert not gerlache["qualityGates"]["imageDerivedDetailAtObserver"]


def test_every_generated_patch_matches_its_own_frozen_site_boundary(data):
    manifest, _, _, _ = data
    bundle = json.loads((ROOT / "web/data/bundle.json").read_text())
    bases = json.loads((ROOT / "web/data/terrain-scenes.json").read_text())
    checked = 0
    for profile in manifest["sites"]:
        if not profile["terrain"]:
            continue
        site = next(row for row in bundle["sites"] if row["id"] == profile["site"]["id"])
        base = next(row for row in bases["sites"] if row["siteId"] == site["id"])
        boundary = FrozenBoundary(site, base, (ROOT / "web/data" / base["positionFile"]).read_bytes())
        for record in profile["terrain"].values():
            payload = (ASSETS / record["positionFile"]).read_bytes()
            assert hashlib.sha256(payload).hexdigest() == record["sha256"]
            positions = np.frombuffer(payload, dtype="<f4", count=record["vertexCount"] * 3).reshape(-1, 3)
            indices = np.frombuffer(payload, dtype="<u4", offset=record["indicesByteOffset"], count=record["indexCount"])
            assert np.isfinite(positions).all() and indices.max() < len(positions)
            grid, _ = local_coordinates(site, positions)
            seam = np.flatnonzero(np.isclose(np.max(np.abs(grid), axis=1), 4000, atol=.02))
            assert len(seam) == 512
            for index in seam:
                key = tuple(np.rint(grid[index] / 62.5).astype(int))
                assert positions[index].tobytes() == boundary.edge[key].tobytes()
            checked += 1
        assert sha(ROOT / "web/data" / base["positionFile"]) == base["sha256"]
    assert checked == 16


def test_nobile_registration_changes_display_placement_without_warping_native_pixels(data):
    manifest, _, _, _ = data
    photo = manifest["imagery"]
    assert np.array(photo["bounds"]) - np.array(photo["nativeBounds"]) == pytest.approx([-2, -7, -2, -7])
    assert photo["nativeRaster"]["transform"][2] == pytest.approx(155999.99991753)
    assert photo["registration"]["derivedDisplayTransform"][2] == pytest.approx(155997.99991753)
    assert photo["registration"]["fourQuadrantGradientInternalRmsM"] == 2.49


def test_source_server_ignoring_range_cannot_trigger_whole_archive_download(monkeypatch):
    class FullResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, *args):
            pytest.fail("A full archive response must be rejected before reading")

    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: FullResponse())
    with pytest.raises(ValueError, match="refusing full download"):
        read_range("https://example.invalid/source.zip", 0, 100)
    with pytest.raises(ValueError, match="oversized"):
        read_range("https://example.invalid/source.zip", 0, 100_000_000)
