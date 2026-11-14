"""Optional NASA study-point provenance and raw terrain coverage gates.

This module does not generate a horizon, visibility interval or mission decision.
New source checksums are locally computed retrieval pins, not publisher checksums.
"""
from __future__ import annotations

import argparse
import json
import os
from hashlib import file_digest
from math import ceil, floor
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import rasterio
from rasterio.windows import Window

from science.rendering_notes import central_difference_slope
from science.scene_terrain import local_positions
from science.sources import FILES as BASE_FILES
from science.sources import REGIONAL, _fetch
from science.sources import SHA256 as BASE_SHA256
from science.terrain import _raster_description, project, unproject

EXTENDED_SITES = (
    ("peak-near-shackleton", "Peak Near Shackleton", "Peak Near Shackleton · PGDA Site 07", -88.811, 123.6901, "Site07"),
)
SITE_METADATA = {
    "peak-near-shackleton": {
        "source": "https://ntrs.nasa.gov/citations/20250002845",
        "coordinateReference": "NASA Lunar Surface Data Book M2M-30044, table A2.1-1, p. 75",
        "coordinateStatus": "Published region center",
        "sourceFrame": "DE421 MOON_ME",
        "coordinateConvention": "Planetocentric latitude degrees north; longitude degrees east in [0,360)",
        "isApprovedLandingPad": False,
        "coordinateDocumentUrl": "https://ntrs.nasa.gov/api/citations/20250002845/downloads/M2M-30044%20Lunar%20Surface%20Data%20Book%20Baseline_Final.pdf?attachment=true",
        "coordinateDocumentBytes": 3347513,
        "coordinateDocumentSha256": "87f28000685fff1b9ee20378d1765805b98026088036f9b045db9d9254fe982b",
        "coordinateVerification": "Table A2.1-1 page 75 visually inspected against the official NASA PDF",
        "frameEvidence": "PGDA product 78 documents DE421 MOON_ME for its south-polar stereographic GeoTIFFs; NASA table centers derive from those products",
    },
}
EXTENDED_FILES = {
    "Site07_final_adj_5mpp_surf.tif": {
        "url": "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/Site07/Site07_final_adj_5mpp_surf.tif",
        "bytes": 40980808,
        "sha256": "38aaee10bb4da4d63e7427aa1ca25c79bdbc649d212079a04990e135462091f8",
        "citation": "https://pgda.gsfc.nasa.gov/products/78",
        "pinnedAcquisitionUtc": "2026-11-14T22:54:32.292859+00:00",
        "publisherChecksumAvailable": False,
        "checksumOrigin": "Locally computed SHA-256 retrieval pin after HTTPS acquisition; not a publisher checksum",
    },
}


def _verify(path: Path, size: int, expected_sha256: str) -> None:
    if path.stat().st_size != size:
        raise ValueError(f"{path.name}: bytes differ from pinned NASA acquisition ({size})")
    with path.open("rb") as stream:
        actual = file_digest(stream, "sha256").hexdigest()
    if actual != expected_sha256:
        raise ValueError(f"{path.name}: SHA-256 differs from pinned NASA acquisition")


def source_manifest(raw: Path | str) -> list[dict]:
    """Verify exact archive bytes before returning compatible source records."""
    raw = Path(raw)
    result = []
    for name, entry in EXTENDED_FILES.items():
        _verify(raw / name, entry["bytes"], entry["sha256"])
        result.append({
            "filename": name, "url": entry["url"], "citation": entry["citation"],
            "bytes": entry["bytes"], "sha256": entry["sha256"],
            "product_version": "PGDA Site07 surface-interpolated LOLA LDEM; nominal 5 m/pixel",
            "local_file_acquired_utc": entry["pinnedAcquisitionUtc"],
            "acquisitionTimeScope": "Original verified acquisition of these pinned bytes; not a claim about a later local download",
            "publisherChecksumAvailable": entry["publisherChecksumAvailable"],
            "checksumOrigin": entry["checksumOrigin"],
            "use": "NASA LOLA local terrain for optional Peak Near Shackleton study-point calculations",
        })
    return result


def acquire(raw: Path | str) -> list[dict]:
    """Download missing pinned files. Existing files are verified, never replaced."""
    raw = Path(raw)
    raw.mkdir(parents=True, exist_ok=True)
    for name, entry in EXTENDED_FILES.items():
        destination = raw / name
        if destination.exists():
            _verify(destination, entry["bytes"], entry["sha256"])
            continue
        with TemporaryDirectory(prefix=".extended-download-", dir=raw) as directory:
            temporary = Path(directory)
            _fetch(temporary, [(name, entry["url"], entry["bytes"], entry["sha256"])])
            # Atomically publish verified bytes without replacing a file that
            # appeared while the download was in progress.
            os.link(temporary / name, destination)
    return source_manifest(raw)


def _coverage_report(dataset, x: float, y: float, radius_m: float) -> dict:
    """Check a complete enclosing projected box, conservatively beyond the disc."""
    description = _raster_description(dataset)
    left, bottom, right, top = dataset.bounds
    margin = float(min(x-left, right-x, y-bottom, top-y))
    pixel = dataset.res[0]
    enclosing_radius = radius_m * 1.015 + 2 * pixel
    if margin < enclosing_radius:
        raise ValueError(f"{Path(dataset.name).name}: insufficient raster coverage for {radius_m:g} m radius")
    col, row = (~dataset.transform) @ (x, y)
    span = ceil(enclosing_radius / pixel)
    c0, c1 = floor(col)-span, floor(col)+span+1
    r0, r1 = floor(row)-span, floor(row)+span+1
    invalid = checked = 0
    for start in range(r0, r1, 128):
        values = dataset.read(1, window=Window(c0, start, c1-c0, min(128, r1-start)), masked=True)
        bad = np.ma.getmaskarray(values) | ~np.isfinite(values.data)
        invalid += int(bad.sum())
        checked += bad.size
    if invalid:
        raise ValueError(f"{Path(dataset.name).name}: {invalid} missing cells in complete coverage check")
    return description | {"observerEdgeMarginM": margin, "validatedRadiusM": radius_m,
                          "enclosingProjectedRadiusM": enclosing_radius,
                          "checkedCells": checked, "checkedInvalidCells": invalid,
                          "checkedScope": "Entire enclosing projected square, including cells outside the physical horizon annulus"}


def validate_extended_site(raw: Path | str, site_id: str = "peak-near-shackleton") -> dict:
    """Raw-source, CRS, observer and mask validation only; no visibility verdict."""
    raw = Path(raw)
    source_manifest(raw)
    matches = [row for row in EXTENDED_SITES if row[0] == site_id]
    if not matches:
        raise ValueError(f"Unknown extended study point: {site_id}")
    _, name, _, lat, lon, tile = matches[0]
    _verify(raw / REGIONAL, BASE_FILES[REGIONAL][1], BASE_SHA256[REGIONAL])
    x, y = project(lat, lon)
    with rasterio.open(raw / f"{tile}_final_adj_5mpp_surf.tif") as local, rasterio.open(raw / REGIONAL) as regional:
        local_report = _coverage_report(local, x, y, 5000)
        regional_report = _coverage_report(regional, x, y, 240000)
        row, col = local.index(x, y)
        values = local.read(1, window=Window(col-1, row-1, 3, 3), masked=True)
        valid = ~np.ma.getmaskarray(values) & np.isfinite(values.data)
        if not valid.all():
            raise ValueError("The observer lacks a complete valid native 3x3 DEM stencil")
        ground = float(values[1, 1])
        columns, rows = np.meshgrid(np.arange(col-1, col+2), np.arange(row-1, row+2))
        px = local.transform.c + (columns+.5)*local.transform.a
        py = local.transform.f + (rows+.5)*local.transform.e
        phi, theta = unproject(px, py)
        xyz = local_positions(lat, lon, ground, phi, theta, values.data.astype(np.float64))
        slope = central_difference_slope(xyz, valid)
    return {"siteId": site_id, "name": name, "lat": lat, "lon": lon,
            **SITE_METADATA[site_id], "groundM": ground,
            "heightM": 2., "heightScope": "Illustrative observer height above native DEM ground",
            "local": local_report, "regional": regional_report, "slope": slope,
            "horizonStatus": "NOT_COMPUTED", "visibilityStatus": "NOT_COMPUTED",
            "limits": ["A valid source and coverage check does not establish Sun or Earth visibility or landing safety.",
                       "Nominal pixel spacing differs from physical terrain accuracy; local LOLA grids include interpolation.",
                       "The local 3x3 gradient is a DEM-model slope, not landing-hazard certification."]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=Path("data/raw"))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--acquire", action="store_true", help="Acquire only missing exact pinned NASA inputs")
    mode.add_argument("--verify", action="store_true", help="Verify existing inputs without downloading (default)")
    args = parser.parse_args()
    if args.acquire:
        acquire(args.raw)
    report = {"sources": source_manifest(args.raw),
              "sites": [validate_extended_site(args.raw, row[0]) for row in EXTENDED_SITES]}
    print(json.dumps(report, sort_keys=True, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
