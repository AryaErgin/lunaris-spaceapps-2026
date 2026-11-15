"""Independent source-integrity and nested-coverage gates for six NASA study points."""
import hashlib
import importlib
import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest

NAMES = ["Site06", "Site23", "Site20", "Site42", "Haworth", "DM2"]
OUTER = "LDEM_60S_240MPP_ADJ.TIF"


def module():
    assert importlib.util.find_spec("science.southpole_sites") is not None, "South-pole source module is missing"
    return importlib.import_module("science.southpole_sites")


def pins_for(raw):
    pins = []
    for name in [*(f"{tile}_final_adj_5mpp_surf.tif" for tile in NAMES), OUTER]:
        path = raw / name
        if not path.exists():
            path.write_bytes(name.encode())
        pins.append({"filename": name, "bytes": path.stat().st_size,
                     "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                     "url": f"https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/{name}" if name == OUTER else
                            f"https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/{name.split('_')[0]}/{name}",
                     "acquiredUtc": "2026-11-15T12:00:00Z", "lastModified": "test fixture", "etag": "fixture",
                     "publisherChecksumAvailable": False,
                     "checksumOrigin": "Locally computed HTTPS retrieval pin, not a NASA-published checksum",
                     "citation": "https://pgda.gsfc.nasa.gov/products/90" if name == OUTER else
                                 "https://pgda.gsfc.nasa.gov/products/78"})
    return pins


def test_six_published_centers_keep_east_longitude_and_honest_region_vintages():
    m = module()
    assert [(r[0], r[3], r[4], r[5]) for r in m.SOUTHPOLE_SITES] == [
        ("nobile-rim-1", -85.4381, 37.36667, "Site06"),
        ("malapert-massif", -85.9948, 359.76422, "Site23"),
        ("leibnitz-beta-plateau", -85.4266, 31.74276, "Site20"),
        ("de-gerlache-kocher", -85.8296, 243.678, "Site42"),
        ("haworth", -86.7639, 337.223, "Haworth"),
        ("nobile-rim-2", -83.954, 58.82206, "DM2")]
    for row in m.SOUTHPOLE_SITES:
        meta = m.SITE_METADATA[row[0]]
        assert meta["isApprovedLandingPad"] is False
        assert meta["sourceFrame"] == "DE421 MOON_ME"
        assert "A2.1-1" in meta["coordinateReference"] and "75" in meta["coordinateReference"]
        assert meta["coordinateDocumentSha256"] == "87f28000685fff1b9ee20378d1765805b98026088036f9b045db9d9254fe982b"
    assert m.SITE_METADATA["haworth"]["regionSelectionVintage"] == "NASA 2024 nine-region candidate set"
    assert m.SITE_METADATA["de-gerlache-kocher"]["in2024CandidateRegionSet"] is False
    assert "2022" in m.SITE_METADATA["de-gerlache-kocher"]["regionSelectionVintage"]
    alias = m.SITE_METADATA["leibnitz-beta-plateau"]
    assert alias["currentFeatureAlias"] == "Mons Mouton"
    assert alias["sameRegionPolygonEstablished"] is False


def test_annuli_have_hand_derived_conservative_edges_and_overlaps():
    rings = module().scan_rings(8000, 180000, 240000, 5, 80, 240)
    assert rings[0] == (0, 5000)
    assert rings[1] == pytest.approx((4820, 177024.63054187194))
    assert rings[2] == pytest.approx((176544.63054187194, 240000))
    assert module().scan_rings(8000, 300000, 200000, 5, 80, 240) == [(0, 5000), (4820, 200000)]


@pytest.mark.parametrize("args", [(5084.9, 180000, 240000, 5, 80, 240),
                                  (8000, 100, 240000, 5, 80, 240),
                                  (8000, 180000, 240000, 0, 80, 240),
                                  (8000, float("nan"), 240000, 5, 80, 240)])
def test_rings_reject_clipped_or_invalid_domains(args):
    with pytest.raises(ValueError):
        module().scan_rings(*args)


def test_manifest_checks_all_pins_and_preserves_retrieval_provenance(tmp_path, monkeypatch):
    m = module()
    pins = pins_for(tmp_path)
    monkeypatch.setattr(m, "SOURCE_PINS", pins)
    records = m.source_manifest(tmp_path)
    assert len(records) == 7
    assert records[0]["sha256"] == pins[0]["sha256"]
    assert records[0]["local_file_acquired_utc"] == "2026-11-15T12:00:00Z"
    assert records[0]["publisherChecksumAvailable"] is False
    target = tmp_path / pins[0]["filename"]
    target.write_bytes(b"x" * pins[0]["bytes"])
    for action in (m.source_manifest, m.acquire):
        with pytest.raises(ValueError, match="SHA-256"):
            action(tmp_path)
        assert target.read_bytes() == b"x" * pins[0]["bytes"]


def test_missing_and_incomplete_sources_never_yield_an_empty_verified_manifest(tmp_path, monkeypatch):
    m = module()
    pins = pins_for(tmp_path)
    monkeypatch.setattr(m, "SOURCE_PINS", pins)
    (tmp_path / pins[0]["filename"]).unlink()
    with pytest.raises(FileNotFoundError):
        m.source_manifest(tmp_path)
    monkeypatch.setattr(m, "SOURCE_PINS", pins[:-1])
    with pytest.raises(ValueError, match="seven|incomplete|pins"):
        m.source_manifest(tmp_path)


def test_acquire_downloads_only_missing_and_never_replaces_a_racing_file(tmp_path, monkeypatch):
    m = module()
    pins = pins_for(tmp_path)
    monkeypatch.setattr(m, "SOURCE_PINS", pins)
    missing = pins[0]
    payload = (tmp_path / missing["filename"]).read_bytes()
    (tmp_path / missing["filename"]).unlink()

    def fetch(directory, entries):
        for name, _url, _size, _sha in entries:
            assert name == missing["filename"]
            (directory / name).write_bytes(payload)

    monkeypatch.setattr(m, "_fetch", fetch)
    assert len(m.acquire(tmp_path)) == 7
    assert (tmp_path / missing["filename"]).read_bytes() == payload
    (tmp_path / missing["filename"]).unlink()

    def racing_fetch(directory, entries):
        fetch(directory, entries)
        (tmp_path / missing["filename"]).write_bytes(b"keep the concurrent file")

    monkeypatch.setattr(m, "_fetch", racing_fetch)
    with pytest.raises(FileExistsError):
        m.acquire(tmp_path)
    assert (tmp_path / missing["filename"]).read_bytes() == b"keep the concurrent file"


def write_raster(path, center, pixel, width, value=123.0):
    import rasterio
    from affine import Affine

    from science.terrain import STEREO

    x, y = center
    transform = Affine(pixel, 0, x - width * pixel / 2, 0, -pixel, y + width * pixel / 2)
    with rasterio.open(path, "w", driver="GTiff", width=width, height=width, count=1,
                       dtype="float32", crs=STEREO, transform=transform, nodata=np.nan,
                       compress="deflate", tiled=True) as dataset:
        dataset.write(np.full((width, width), value, dtype=np.float32), 1)


def test_verified_report_uses_real_rasters_pyproj_and_no_visibility_verdict(tmp_path, monkeypatch):
    m = module()
    from science.terrain import project

    site = ("nobile-rim-1", "Synthetic observer", "Synthetic coverage fixture", -89., 30., "Site06")
    monkeypatch.setattr(m, "SOUTHPOLE_SITES", (site,))
    center = project(-89., 30.)
    write_raster(tmp_path / "Site06_final_adj_5mpp_surf.tif", center, 5, 2048)
    write_raster(tmp_path / "LDEM_80S_80MPP_ADJ.TIF", center, 80, 500)
    write_raster(tmp_path / OUTER, center, 240, 2050)
    pins = pins_for(tmp_path)
    monkeypatch.setattr(m, "SOURCE_PINS", pins)
    regional = tmp_path / "LDEM_80S_80MPP_ADJ.TIF"
    monkeypatch.setattr(m, "BASE_FILES", {regional.name: ("fixture", regional.stat().st_size, "fixture")})
    monkeypatch.setattr(m, "BASE_SHA256", {regional.name: hashlib.sha256(regional.read_bytes()).hexdigest()})
    report, = m.verify_sites(tmp_path)
    assert report["siteId"] == report["id"] == "nobile-rim-1"
    assert report["groundM"] == 123.0 and report["heightM"] == 2.0
    assert report["referenceRadiusM"] == 1737400.0
    assert report["nativeGroundStencilValid"] is True
    assert report["coordinateRoundTripPixels"] < .1
    assert report["local"]["validatedRadiusM"] == 5000
    assert report["regional"]["validatedRadiusM"] < 20000
    for key in ("local", "regional", "outerRegional"):
        assert "requestedWindowDimensions" in report[key]
        assert report[key]["requestedWindowDimensions"] == report[key]["checkedWindowDimensions"]
        assert report[key]["checkedCells"] == np.prod(report[key]["requestedWindowDimensions"])
    assert report["outerRegional"]["validatedRadiusM"] == 240000
    assert report["horizonStatus"] == report["visibilityStatus"] == "NOT_COMPUTED"
    assert all(report[k]["checkedInvalidCells"] == 0 for k in ("local", "regional", "outerRegional"))
    # A non-observer hole still invalidates the full native near-field square.
    import rasterio
    from rasterio.windows import Window
    with rasterio.open(tmp_path / "Site06_final_adj_5mpp_surf.tif", "r+") as dataset:
        dataset.write(np.array([[np.nan]], dtype=np.float32), 1, window=Window(100, 100, 1, 1))
    monkeypatch.setattr(m, "SOURCE_PINS", pins_for(tmp_path))
    with pytest.raises(ValueError, match="missing cells"):
        m.verify_sites(tmp_path)


def test_actual_six_raw_coverage_and_observer_gates():
    m = module()
    raw = Path("data/raw")
    if len(m.SOURCE_PINS) != 7 or not all((raw / p["filename"]).is_file() for p in m.SOURCE_PINS):
        pytest.skip("Raw pinned NASA expansion products unavailable in this checkout")
    reports = m.verify_sites(raw)
    assert len(reports) == 6
    assert all(r["nativeGroundStencilValid"] and r["coordinateRoundTripPixels"] < .1 for r in reports)
    assert all(r["horizonStatus"] == "NOT_COMPUTED" for r in reports)
    json.dumps(reports, allow_nan=False)


def test_complete_coverage_gate_rejects_clipped_extra_padding():
    m = module()
    assert hasattr(m, "_complete_coverage_report"), "Complete requested-square gate is missing"
    from affine import Affine
    from rasterio.io import MemoryFile

    from science.terrain import STEREO

    with MemoryFile() as memory, memory.open(driver="GTiff", width=10, height=10, count=1,
             dtype="float32", crs=STEREO, nodata=np.nan,
             transform=Affine(5, 0, -25, 0, -5, 25)) as dataset:
        dataset.write(np.zeros((10, 10), dtype=np.float32), 1)
        # The original helper's margin passes, but 11x11 requested cells clip to 10x10.
        with pytest.raises(ValueError, match="clipped"):
            m._complete_coverage_report(dataset, 0, 0, 15 / 1.015)
