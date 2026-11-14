"""Recompute Site11 skylines with two correlated NASA PGDA local DEM realizations."""

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio

from science.build import END, HEIGHT_M, START, _site, _write_bundle
from science.ephemerides import Ephemeris
from science.height_study import SITE_ID
from science.sources import REGIONAL, SITES, clone_manifest, source_manifest
from science.terrain import _raster_description, project


def check_product(nominal_path, clone_path, lat, lon):
    """Check native registration and independently distinguish absolute Z from residuals."""
    with rasterio.open(nominal_path) as nominal, rasterio.open(clone_path) as clone:
        expected = _raster_description(nominal)
        actual = _raster_description(clone)
        for key in ("affine", "spacingM", "boundsM", "dimensions", "noData", "areaOrPoint"):
            if expected[key] != actual[key]:
                raise ValueError(f"{clone_path.name}: native raster registration disagrees on {key}")
        if clone.dtypes != ("float32",) or clone.scales != (1.,) or clone.offsets != (0.,):
            raise ValueError(f"{clone_path.name}: unexpected elevation encoding")
        xy = project(lat, lon)
        source = float(next(nominal.sample([xy]))[0])
        other = float(next(clone.sample([xy]))[0])
        if not (np.isfinite(other) and abs(source - other) < 5 and other > 1700):
            raise ValueError(f"{clone_path.name}: observer sample is inconsistent with absolute DEM elevation")
        return {"nominalGroundM": source, "realizedGroundM": other, "deltaGroundM": other - source}


def build_terrain_study(raw, baseline_path, output):
    baseline = json.loads(baseline_path.read_bytes())
    if baseline["coverage"] != [START, END]:
        raise ValueError("The terrain study requires the November 2026 Phase B baseline")
    nominal = next(site for site in baseline["sites"] if site["id"] == SITE_ID)
    if nominal["heightM"] != HEIGHT_M:
        raise ValueError("The terrain study requires the locked 2 m observer height")
    expected = {row["filename"]: row["sha256"] for row in baseline["manifest"]["files"]}
    sources = source_manifest(raw)
    if any(expected.get(row["filename"]) != row["sha256"] for row in sources):
        raise ValueError("A raw source does not match the locked Phase B inputs")
    row = next(row for row in SITES if row[0] == SITE_ID)
    dem = raw / nominal["terrain"]["fine"]["local"]["filename"]
    clones = clone_manifest(raw / "clones")
    base = {key: nominal[key] for key in ("lat", "lon", "heightM", "groundM")}
    scenarios = [base | {"id": "nominal", "label": "Nominal terrain", "baseline": True}]
    with Ephemeris(raw) as ephemeris:
        for asset in clones:
            path = raw / "clones" / asset["filename"]
            encoding = check_product(dem, path, nominal["lat"], nominal["lon"])
            derived = _site(raw, ephemeris, row, height_m=HEIGHT_M, include_plot=False, local_path=path)
            if nominal["groundM"] != encoding["nominalGroundM"] or derived["groundM"] != encoding["realizedGroundM"]:
                raise ValueError("Ground changed between absolute-elevation verification and horizon computation")
            scenarios.append({
                "id": f"clone-{asset['clone']}", "label": f"PGDA clone {asset['clone']}", "encodingCheck": encoding,
                "localSourceSha256": asset["sha256"],
                **{key: derived[key] for key in ("heightM", "lat", "lon", "groundM", "sun", "earth",
                                                 "refinementIntervals", "terrain", "refinement",
                                                 "maxSampledAngularRateDegMin")},
            })
    model_sources = [
        source for source in sources
        if source["use"] == "JPL SPICE kernel" or source["filename"] in (dem.name, REGIONAL)
    ]
    manifest = {
        "baselineBundleSha256": baseline["manifest"]["bundleSha256"],
        "siteId": SITE_ID,
        "coordinateSource": nominal["source"],
        "pointCoordinates": [nominal["lat"], nominal["lon"]],
        "observerHeightM": HEIGHT_M,
        "frame": baseline["manifest"]["frame"],
        "files": model_sources + clones,
        "versions": baseline["manifest"]["versions"],
        "numericalMethod": baseline["manifest"]["validation"]["temporal"],
        "visibilityDefinitions": baseline["manifest"]["visibilityDefinitions"],
        "sourceMethod": "https://ntrs.nasa.gov/citations/20205009660",
        "limits": [
            "PGDA clones 0001 and 0002 are absolute radial elevations in metres despite the err filename.",
            "Replace only the local 5 m raster. The nominal regional 80 m DEM is shared.",
            "Observer coordinates are fixed and observer radius follows each realization at 2 m above its ground.",
            (
                "These two selected correlated realizations support a finite sensitivity test. "
                "Terrain variations outside the local product and values below its modeled resolution remain unresolved."
            ),
            "No probability of success, percentile, or continuous terrain uncertainty bound is inferred.",
        ],
        "aiUse": baseline["manifest"]["aiUse"],
    }
    _write_bundle({"version": "1.0.0", "siteId": SITE_ID, "coverage": [START, END],
                   "scenarios": scenarios, "manifest": manifest}, output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=Path("data/raw"))
    parser.add_argument("--baseline", type=Path, default=Path("web/data/bundle.json"))
    parser.add_argument("--out", type=Path, default=Path("web/data/terrain-study.json"))
    args = parser.parse_args()
    build_terrain_study(args.raw, args.baseline, args.out)
