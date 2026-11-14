"""Source and coverage gates for optional NASA published study-point expansion."""
import hashlib
import importlib
import importlib.util
from pathlib import Path

import pytest


def module():
    assert importlib.util.find_spec("science.extended_sites") is not None, "Extended study-point provenance module is missing"
    return importlib.import_module("science.extended_sites")


def test_r07_matches_nasa_published_region_center_and_preserves_scope():
    extended = module()
    assert extended.EXTENDED_SITES == (("peak-near-shackleton", "Peak Near Shackleton", "Peak Near Shackleton \u00b7 PGDA Site 07", -88.811, 123.6901, "Site07"),)
    metadata = extended.SITE_METADATA["peak-near-shackleton"]
    assert metadata["source"] == "https://ntrs.nasa.gov/citations/20250002845"
    assert "A2.1-1" in metadata["coordinateReference"] and "75" in metadata["coordinateReference"]
    assert metadata["sourceFrame"] == "DE421 MOON_ME"
    assert metadata["coordinateStatus"] == "Published region center"
    assert metadata["isApprovedLandingPad"] is False


def test_extended_archive_has_honest_retrieval_pin_not_a_claimed_publisher_checksum():
    extended = module()
    record = extended.EXTENDED_FILES["Site07_final_adj_5mpp_surf.tif"]
    assert record["url"] == "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/Site07/Site07_final_adj_5mpp_surf.tif"
    assert record["bytes"] == 40_980_808
    assert len(record["sha256"]) == 64 and set(record["sha256"]) <= set("0123456789abcdef")
    assert record["publisherChecksumAvailable"] is False
    assert "retrieval" in record["checksumOrigin"].lower()


def test_missing_or_corrupt_new_archive_cannot_be_reported_verified_or_overwritten(tmp_path):
    extended = module()
    with pytest.raises(FileNotFoundError):
        extended.source_manifest(tmp_path)
    archive = tmp_path / "Site07_final_adj_5mpp_surf.tif"
    archive.write_bytes(b"truncated NASA response")
    for action in (extended.source_manifest, extended.acquire):
        with pytest.raises(ValueError, match="bytes|SHA-256"):
            action(tmp_path)
        assert archive.read_bytes() == b"truncated NASA response", "Never overwrite a pre-existing source file"


def test_actual_r07_source_hash_and_full_near_and_regional_coverage():
    extended = module()
    raw = Path("data/raw")
    archive = raw / "Site07_final_adj_5mpp_surf.tif"
    if not archive.exists() or not (raw / "LDEM_80S_80MPP_ADJ.TIF").exists():
        pytest.skip("Optional raw NASA R07 and regional inputs are not available")
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    records = extended.source_manifest(raw)
    assert records[0]["sha256"] == digest == extended.EXTENDED_FILES[archive.name]["sha256"]
    report = extended.validate_extended_site(raw)
    assert report["siteId"] == "peak-near-shackleton"
    assert report["local"]["spacingM"] == 5
    assert report["regional"]["spacingM"] == 80
    assert report["local"]["observerEdgeMarginM"] == pytest.approx(8000, abs=1)
    assert report["regional"]["observerEdgeMarginM"] == pytest.approx(274000, abs=1)
    assert report["local"]["checkedInvalidCells"] == report["regional"]["checkedInvalidCells"] == 0
    assert report["local"]["validatedRadiusM"] == 5000
    assert report["regional"]["validatedRadiusM"] == 240000
    assert report["groundM"] == 1645.548828125
    assert report["slope"]["slopeDeg"] == pytest.approx(5.0046269278896665, abs=1e-8)
    assert report["horizonStatus"] == "NOT_COMPUTED"
    assert report["visibilityStatus"] == "NOT_COMPUTED"
    assert "PASS" not in report


def test_coverage_gate_rejects_missing_cells_and_a_clipped_radius():
    extended = module()
    import numpy as np
    from affine import Affine
    from rasterio.io import MemoryFile

    from science.terrain import STEREO

    values = np.zeros((10, 10), dtype=np.float32)
    with (
        MemoryFile() as memory,
        memory.open(driver="GTiff", width=10, height=10, count=1,
                    dtype="float32", crs=STEREO, nodata=np.nan,
                    transform=Affine(5, 0, -25, 0, -5, 25)) as dataset,
    ):
        dataset.write(values, 1)
        report = extended._coverage_report(dataset, 0, 0, 5)
        assert report["checkedCells"] == 81
        assert report["checkedInvalidCells"] == 0
        with pytest.raises(ValueError, match="insufficient raster coverage"):
            extended._coverage_report(dataset, 0, 0, 25)
        values[5, 5] = np.nan
        dataset.write(values, 1)
        with pytest.raises(ValueError, match="missing cells"):
            extended._coverage_report(dataset, 0, 0, 5)
