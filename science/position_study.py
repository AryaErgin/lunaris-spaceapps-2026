"""Recompute two illustrative map-easting offsets near de Gerlache Rim 1."""

import argparse
import json
from pathlib import Path

from science.build import END, HEIGHT_M, START, _site, _write_bundle
from science.ephemerides import Ephemeris
from science.height_study import SITE_ID
from science.sources import SITES, source_manifest
from science.terrain import project, unproject

OFFSETS_M = (-25, 0, 25)


def build_position_study(raw, baseline_path, output):
    baseline = json.loads(baseline_path.read_bytes())
    if baseline["coverage"] != [START, END]:
        raise ValueError("The position study requires the November 2026 Phase B baseline")
    nominal = next(site for site in baseline["sites"] if site["id"] == SITE_ID)
    if nominal["heightM"] != HEIGHT_M:
        raise ValueError("The position study requires the locked 2 m observer height")
    previous = {row["filename"]: row["sha256"] for row in baseline["manifest"]["files"]}
    sources = source_manifest(raw)
    if any(previous.get(row["filename"]) != row["sha256"] for row in sources):
        raise ValueError("A raw source does not match the locked Phase B inputs")
    site = next(row for row in SITES if row[0] == SITE_ID)
    model_sources = [
        row for row in sources if row["use"] == "JPL SPICE kernel" or row["filename"].startswith((site[-1], "LDEM_"))
    ]
    x, y = project(nominal["lat"], nominal["lon"])
    scenarios = []
    with Ephemeris(raw) as ephemeris:
        for offset in OFFSETS_M:
            scenario = {
                "id": f"e{offset:+d}m" if offset else "nominal",
                "label": f"{offset:+d} m map easting" if offset else "Published point",
                "heightM": HEIGHT_M, "offsetEastingM": offset, "offsetNorthingM": 0,
            }
            if not offset:
                scenarios.append(scenario | {"baseline": True, "lat": nominal["lat"], "lon": nominal["lon"],
                                              "groundM": nominal["groundM"]})
                continue
            lat, lon = unproject(x + offset, y)
            row = (*site[:3], float(lat), float(lon), site[-1])
            derived = _site(raw, ephemeris, row, height_m=HEIGHT_M, include_plot=False)
            scenarios.append(scenario | {
                key: derived[key] for key in ("lat", "lon", "groundM", "sun", "earth", "refinementIntervals", "terrain",
                                             "refinement", "maxSampledAngularRateDegMin")
            })
    manifest = {
        "baselineBundleSha256": baseline["manifest"]["bundleSha256"],
        "coordinateSource": nominal["source"],
        "siteId": SITE_ID,
        "pointCoordinates": [nominal["lat"], nominal["lon"]],
        "offsetEastingM": OFFSETS_M,
        "projection": "NASA LOLA south polar stereographic map grid, metre coordinates",
        "frame": baseline["manifest"]["frame"],
        "files": model_sources,
        "versions": baseline["manifest"]["versions"],
        "numericalMethod": baseline["manifest"]["validation"]["temporal"],
        "visibilityDefinitions": baseline["manifest"]["visibilityDefinitions"],
        "limits": [
            "Illustrative offsets along map easting. Recompute local ground, terrain horizons and target directions.",
            "Use 2 m above each local ground and identical mission limits. Local geographic east and map easting differ.",
            "The discrete settings carry no navigation-error probability or landing safety assessment.",
            "Terrain reconstruction error and terrain below the pixel scale are outside numerical bounds.",
        ],
        "aiUse": baseline["manifest"]["aiUse"],
    }
    _write_bundle({"version": "1.0.0", "siteId": SITE_ID, "coverage": [START, END],
                   "scenarios": scenarios, "manifest": manifest}, output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=Path("data/raw"))
    parser.add_argument("--baseline", type=Path, default=Path("web/data/bundle.json"))
    parser.add_argument("--out", type=Path, default=Path("web/data/position-study.json"))
    args = parser.parse_args()
    build_position_study(args.raw, args.baseline, args.out)
