"""Pinned NASA south-pole study points and conservative raw-coverage gates.

This module verifies sources and observer geometry only. It computes no horizon,
visibility interval, mission verdict, landing certification or hardware sufficiency.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import rasterio
from pyproj import CRS, Transformer
from rasterio.windows import Window

from science.extended_sites import _coverage_report, _verify
from science.sources import FILES as BASE_FILES
from science.sources import REGIONAL, _fetch
from science.sources import SHA256 as BASE_SHA256
from science.terrain import RADIUS_M, STEREO, project

OUTER_REGIONAL = "LDEM_60S_240MPP_ADJ.TIF"
SOUTHPOLE_SITES = (
    ("nobile-rim-1", "Nobile Rim 1", "Nobile Rim 1 · PGDA Site06", -85.4381, 37.36667, "Site06"),
    ("malapert-massif", "Malapert Massif", "Malapert Massif · PGDA Site23", -85.9948, 359.76422, "Site23"),
    ("leibnitz-beta-plateau", "Leibnitz Beta Plateau", "Leibnitz Beta Plateau · PGDA Site20", -85.4266, 31.74276, "Site20"),
    ("de-gerlache-kocher", "de Gerlache-Kocher Massif", "de Gerlache-Kocher Massif · PGDA Site42", -85.8296, 243.678, "Site42"),
    ("haworth", "Haworth", "Haworth · PGDA study point", -86.7639, 337.223, "Haworth"),
    ("nobile-rim-2", "Nobile Rim 2", "Nobile Rim 2 · PGDA DM2", -83.954, 58.82206, "DM2"),
)
_COORDINATE_SOURCE = "https://ntrs.nasa.gov/citations/20250002845"
_COORDINATE_PDF = (
    "https://ntrs.nasa.gov/api/citations/20250002845/downloads/"
    "M2M-30044%20Lunar%20Surface%20Data%20Book%20Baseline_Final.pdf?attachment=true"
)
_REGIONS_2024 = "https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/"
_REGIONS_2022 = "https://www.nasa.gov/news-release/nasa-identifies-candidate-regions-for-landing-next-americans-on-moon/"
SITE_METADATA = {
    row[0]: {
        "source": _COORDINATE_SOURCE,
        "coordinateReference": "NASA Lunar Surface Data Book M2M-30044, table A2.1-1, p. 75",
        "coordinateDocumentUrl": _COORDINATE_PDF,
        "coordinateDocumentBytes": 3347513,
        "coordinateDocumentSha256": "87f28000685fff1b9ee20378d1765805b98026088036f9b045db9d9254fe982b",
        "coordinateVerification": "Table A2.1-1 page 75 inspected against the official NASA PDF",
        "coordinateStatus": "Published region center",
        "coordinateAccuracyScope": "NASA describes centers of the original PGDA polygons as accurate to 5–10 m; not a surveyed landing pad",
        "coordinateConvention": "Planetocentric latitude degrees north; longitude degrees east in [0,360)",
        "sourceFrame": "DE421 MOON_ME",
        "frameEvidence": "PGDA product 78 documents DE421 MOON_ME; NASA table centers derive from those DEMs",
        "referenceRadiusM": RADIUS_M,
        "isApprovedLandingPad": False,
        "regionSelectionVintage": "NASA 2024 nine-region candidate set",
        "regionSelectionSource": _REGIONS_2024,
        "in2022CandidateRegionSet": True,
        "in2024CandidateRegionSet": True,
        "regionIdentityScope": "Published study point; the coordinate does not identify an approved landing pad or every location in a candidate region",
    }
    for row in SOUTHPOLE_SITES
}
SITE_METADATA["leibnitz-beta-plateau"].update({
    "regionSelectionVintage": "NASA 2022 Leibnitz Beta Plateau study region; Mons Mouton name appears in NASA 2024 candidate set",
    "currentFeatureAlias": "Mons Mouton",
    "featureAliasSource": "https://svs.gsfc.nasa.gov/5074/",
    "sameRegionPolygonEstablished": False,
    "in2024CandidateRegionSet": False,
    "regionIdentityScope": "Historic PGDA Site20 identity. Leibnitz Beta is a feature alias of Mons Mouton; identical 2022 and 2024 candidate-region polygons are not established",
})
SITE_METADATA["de-gerlache-kocher"].update({
    "regionSelectionVintage": "NASA 2022 thirteen-region candidate set; absent from NASA October 2024 nine-region set",
    "regionSelectionSource": _REGIONS_2022,
    "in2024CandidateRegionSet": False,
})
_PIN_PATH = Path(__file__).with_name("southpole-sources.json")
# An absent pin artifact permits metadata inspection, never source verification.
SOURCE_PINS = json.loads(_PIN_PATH.read_text(encoding="utf-8-sig")) if _PIN_PATH.is_file() else []
_FILENAMES = tuple(f"{row[5]}_final_adj_5mpp_surf.tif" for row in SOUTHPOLE_SITES) + (OUTER_REGIONAL,)


def _pins() -> list[dict]:
    if not isinstance(SOURCE_PINS, list) or len(SOURCE_PINS) != 7:
        raise ValueError("All seven south-pole source pins are required; pin artifact is missing or incomplete")
    by_name = {}
    for record in SOURCE_PINS:
        if not isinstance(record, dict):
            raise TypeError("Invalid south-pole source pins record")
        name = record.get("filename")
        if name not in _FILENAMES or name in by_name:
            raise ValueError("South-pole source pins contain an unknown or duplicate filename")
        size, digest = record.get("bytes"), record.get("sha256")
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            raise ValueError(f"{name}: invalid pinned bytes")
        if not isinstance(digest, str) or len(digest) != 64 or set(digest) - set("0123456789abcdef"):
            raise ValueError(f"{name}: invalid pinned SHA-256")
        prefix = "LOLA_20mpp" if name == OUTER_REGIONAL else f"LOLA_5mpp/{name.split('_')[0]}"
        if record.get("url") != f"https://pgda.gsfc.nasa.gov/data/{prefix}/{name}":
            raise ValueError(f"{name}: URL differs from the named NASA archive")
        if not record.get("acquiredUtc") or record.get("publisherChecksumAvailable") is not False:
            raise ValueError(f"{name}: missing acquisition provenance or unsupported publisher-checksum claim")
        by_name[name] = record
    if set(by_name) != set(_FILENAMES):
        raise ValueError("South-pole source pins are incomplete")
    return [by_name[name] for name in _FILENAMES]


def source_manifest(raw: Path | str) -> list[dict]:
    """Verify all seven exact raw files before returning source records."""
    raw = Path(raw)
    records = _pins()
    for entry in records:
        _verify(raw / entry["filename"], entry["bytes"], entry["sha256"])
    return [entry | {
        "local_file_acquired_utc": entry["acquiredUtc"],
        "acquisitionTimeScope": "Original acquisition of the pinned bytes, not a timestamp for later matching downloads",
        "product_version": Path(entry["filename"]).stem,
        "use": "DE421 MOON_ME radial-height terrain model in meters; interpolated LOLA surface",
    } for entry in records]


def acquire(raw: Path | str) -> list[dict]:
    """Fetch only missing pinned files; never replace any existing raw file."""
    raw = Path(raw)
    records = _pins()
    raw.mkdir(parents=True, exist_ok=True)
    # Check every existing file before a missing file can cause network activity.
    for entry in records:
        destination = raw / entry["filename"]
        if destination.exists():
            _verify(destination, entry["bytes"], entry["sha256"])
    for entry in records:
        destination = raw / entry["filename"]
        if destination.exists():
            continue
        with TemporaryDirectory(prefix=".southpole-download-", dir=raw) as directory:
            temporary = Path(directory)
            _fetch(temporary, [(entry["filename"], entry["url"], entry["bytes"], entry["sha256"])])
            _verify(temporary / entry["filename"], entry["bytes"], entry["sha256"])
            # Linking is atomic and fails if another process created the target.
            os.link(temporary / entry["filename"], destination)
    return source_manifest(raw)


def scan_rings(local_margin, regional_margin, radius, local_pixel, regional_pixel, outer_pixel):
    """Return overlapping physical-distance annuli without extending the 80 m grid."""
    values = (local_margin, regional_margin, radius, local_pixel, regional_pixel, outer_pixel)
    if any(not math.isfinite(value) or value <= 0 for value in values) or radius < 5000:
        raise ValueError("Finite positive coverage margins/pixels and a radius of at least 5000 m are required")
    if local_margin < 5000 * 1.015 + 2 * local_pixel:
        raise ValueError("Insufficient conservative native coverage for the full 5000 m near field")
    second_end = min(radius, (regional_margin - 4 * regional_pixel) / 1.015)
    if second_end <= 4820:
        raise ValueError("Insufficient regional coverage to overlap the native near field")
    rings = [(0, 5000), (4820, second_end)]
    if second_end < radius:
        rings.append((max(0, second_end - 2 * outer_pixel), radius))
    return rings


def _margin(dataset, x, y):
    left, bottom, right, top = dataset.bounds
    return float(min(x - left, right - x, y - bottom, top - y))


def _complete_coverage_report(dataset, x, y, radius):
    """Require that the original helper checked its entire requested square."""
    report = _coverage_report(dataset, x, y, radius)
    col, row = (~dataset.transform) @ (x, y)
    span = math.ceil((radius * 1.015 + 2 * dataset.res[0]) / dataset.res[0])
    c0, c1 = math.floor(col) - span, math.floor(col) + span + 1
    r0, r1 = math.floor(row) - span, math.floor(row) + span + 1
    requested = [2 * span + 1, 2 * span + 1]
    checked = [max(0, min(dataset.width, c1) - max(0, c0)),
               max(0, min(dataset.height, r1) - max(0, r0))]
    if checked != requested or report["checkedCells"] != checked[0] * checked[1]:
        raise ValueError(f"{Path(dataset.name).name}: requested padded coverage square was clipped")
    return report | {"requestedWindowDimensions": requested, "checkedWindowDimensions": checked}


def verify_sites(raw: Path | str) -> list[dict]:
    """Verify exact sources, complete coverage and six native observer stencils."""
    raw = Path(raw)
    source_manifest(raw)
    _verify(raw / REGIONAL, BASE_FILES[REGIONAL][1], BASE_SHA256[REGIONAL])
    geographic = CRS.from_proj4("+proj=longlat +R=1737400 +no_defs")
    forward = Transformer.from_crs(geographic, STEREO, always_xy=True)
    inverse = Transformer.from_crs(STEREO, geographic, always_xy=True)
    reports = []
    with rasterio.open(raw / REGIONAL) as regional, rasterio.open(raw / OUTER_REGIONAL) as outer:
        for site_id, name, region, lat, lon, tile in SOUTHPOLE_SITES:
            x, y = (float(v) for v in project(lat, lon))
            with rasterio.open(raw / f"{tile}_final_adj_5mpp_surf.tif") as local:
                for dataset, pixel in ((local, 5), (regional, 80), (outer, 240)):
                    if abs(dataset.res[0] - pixel) > 1e-9 or abs(dataset.res[1] - pixel) > 1e-9:
                        raise ValueError(f"{Path(dataset.name).name}: unexpected native pixel spacing")
                rings = scan_rings(_margin(local, x, y), _margin(regional, x, y), 240000,
                                   local.res[0], regional.res[0], outer.res[0])
                local_report = _complete_coverage_report(local, x, y, 5000)
                regional_report = _complete_coverage_report(regional, x, y, rings[1][1])
                outer_report = _complete_coverage_report(outer, x, y, 240000)
                oracle_x, oracle_y = forward.transform(lon, lat, errcheck=True)
                back_lon, back_lat = inverse.transform(x, y, errcheck=True)
                back_x, back_y = forward.transform(back_lon, back_lat, errcheck=True)
                error_pixels = max(math.hypot(x - oracle_x, y - oracle_y),
                                   math.hypot(x - back_x, y - back_y)) / local.res[0]
                if not math.isfinite(error_pixels) or error_pixels >= .1:
                    raise ValueError(f"{tile}: independent coordinate round trip exceeds 0.1 native pixel")
                row, col = local.index(x, y)
                stencil = local.read(1, window=Window(col - 1, row - 1, 3, 3), masked=True)
                valid = ~np.ma.getmaskarray(stencil) & np.isfinite(stencil.data)
                if stencil.shape != (3, 3) or not valid.all():
                    raise ValueError(f"{tile}: observer lacks a complete valid native 3x3 ground stencil")
                ground = float(stencil[1, 1])
            reports.append({
                **SITE_METADATA[site_id], "siteId": site_id, "id": site_id, "name": name, "region": region,
                "lat": lat, "lon": lon, "groundM": ground, "heightM": 2., "referenceRadiusM": RADIUS_M,
                "heightScope": "Illustrative observer height above the native DEM ground",
                "nativeGroundStencilValid": True, "coordinateRoundTripPixels": error_pixels,
                "sourcePinsVerified": True, "local": local_report, "regional": regional_report,
                "outerRegional": outer_report, "scanRingsM": rings,
                "horizonStatus": "NOT_COMPUTED", "visibilityStatus": "NOT_COMPUTED",
                "limits": ["Coverage and coordinate checks do not establish visibility or mission feasibility.",
                           "Native pixel spacing is not terrain accuracy; LOLA grids include interpolation.",
                           "A published study point is not an approved landing pad."],
            })
    return reports
