"""Recompute de Gerlache Rim 1 at three fixed observer heights."""

import argparse
import json
from pathlib import Path

from science.build import END, HEIGHT_M, START, _site, _write_bundle
from science.ephemerides import Ephemeris
from science.sources import SITES, source_manifest

SITE_ID = "de-gerlache-rim"
HEIGHTS_M = (1, 2, 5)


def build_height_study(raw, baseline_path, output):
    baseline = json.loads(baseline_path.read_bytes())
    if baseline["coverage"] != [START, END]:
        raise ValueError("The height study requires the November 2026 Phase B baseline")
    nominal = next(site for site in baseline["sites"] if site["id"] == SITE_ID)
    if nominal["heightM"] != HEIGHT_M:
        raise ValueError("The height study requires the locked 2 m baseline")
    expected_sources = {row["filename"]: row["sha256"] for row in baseline["manifest"]["files"]}
    sources = source_manifest(raw)
    if any(expected_sources.get(row["filename"]) != row["sha256"] for row in sources):
        raise ValueError("A raw source does not match the locked Phase B inputs")
    site = next(row for row in SITES if row[0] == SITE_ID)
    model_sources = [
        row for row in sources if row["use"] == "JPL SPICE kernel" or row["filename"].startswith((site[-1], "LDEM_"))
    ]
    scenarios = []
    with Ephemeris(raw) as ephemeris:
        for height_m in HEIGHTS_M:
            scenario = {"id": f"h{height_m}m", "heightM": height_m}
            if height_m == HEIGHT_M:
                scenarios.append(scenario | {"baseline": True})
                continue
            derived = _site(raw, ephemeris, site, height_m=height_m, include_plot=False)
            if derived["groundM"] != nominal["groundM"]:
                raise ValueError("Observer ground elevation changed in the height study")
            scenarios.append(scenario | {
                key: derived[key] for key in ("sun", "earth", "refinementIntervals", "terrain", "refinement",
                                             "maxSampledAngularRateDegMin")
            })
    manifest = {
        "baselineBundleSha256": baseline["manifest"]["bundleSha256"],
        "coordinateSource": nominal["source"],
        "siteId": SITE_ID,
        "pointCoordinates": [nominal["lat"], nominal["lon"]],
        "groundM": nominal["groundM"],
        "frame": baseline["manifest"]["frame"],
        "files": model_sources,
        "versions": baseline["manifest"]["versions"],
        "numericalMethod": baseline["manifest"]["validation"]["temporal"],
        "visibilityDefinitions": baseline["manifest"]["visibilityDefinitions"],
        "limits": [
            "One fixed study point and fixed mission inputs. Both target directions and skylines are recomputed.",
            "Three illustrative above-ground heights. No probability distribution or hardware tolerance is implied.",
            "The numerical refinement test does not bound DEM reconstruction error or terrain below the pixel scale.",
            "Position errors, terrain realizations, power, communications link margins and trajectories are outside scope.",
        ],
        "aiUse": baseline["manifest"]["aiUse"],
    }
    _write_bundle({"version": "1.0.0", "siteId": SITE_ID, "coverage": [START, END],
                   "scenarios": scenarios, "manifest": manifest}, output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=Path("data/raw"))
    parser.add_argument("--baseline", type=Path, default=Path("web/data/bundle.json"))
    parser.add_argument("--out", type=Path, default=Path("web/data/height-study.json"))
    args = parser.parse_args()
    build_height_study(args.raw, args.baseline, args.out)
