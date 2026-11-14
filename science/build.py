"""Build the offline November 2026 lunar environment bundle."""

import argparse
import json
import platform
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from time import perf_counter

import numpy as np
import pyproj
import rasterio
import spiceypy

from science.ephemerides import CORRECTION, FRAME, Ephemeris
from science.sources import SITE_SOURCE, SITES, source_manifest
from science.terrain import RADIUS_M, build_skyline
from science.visibility import (
    RATE_DEG_PER_S,
    Visibility,
    combine_refinements,
    longest_blocked_bounds,
)

ENGINE_VERSION = "1.0.0"
ENGINE_COMMIT = "f45173e3fa63e23290cc5d13cbb5f27cb63e9c32"
START = int(datetime(2026, 11, 1, tzinfo=timezone.utc).timestamp())
END = int(datetime(2026, 12, 1, tzinfo=timezone.utc).timestamp())
HEIGHT_M = 2.0
GUIDANCE = "https://github.com/nasa/spaceapps/discussions/1849"
CHALLENGE = "https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/"
LOCAL_MIRROR = "https://hackathlone.com/challenges/lunar-landing-site-navigator"
LIMITS = [
    "Published region centers are study points. Landing safety and trajectory reachability are outside the model.",
    (
        "Solar qualification uses positive apparent Sun-center clearance and Earth occultation of the Sun center. "
        "Time below threshold can include partial-disk illumination."
    ),
    "Earth-center geometric line of sight cannot establish a communications link or station availability.",
    "Two-metre observer height, radial up, astronomical bodies evaluated in airless reception geometry.",
    (
        "The model assigns each LOLA cell a constant radial height. In the narrow transition annulus, "
        "both scales contribute and the higher apparent terrain wins. Nominal 5 m pixels are largely interpolated. "
        "Surface roughness below the DEM scale and DEM reconstruction error are outside the numerical bounds."
    ),
    "Horizon enclosures use spherical caps around each projected cell rather than sampling at a few rays.",
    (
        "The far-field cap assumes no unmodeled point exceeds 1,750 km lunar radius. "
        "Sector uncertainty is retained when the cap or the numerical terrain envelope spans the target elevation."
    ),
    (
        "The 0.03°/min angular-motion envelope is specific to this bounded date range and sites. "
        "Time-grid and terrain sensitivity limits measure numerical and model variation."
    ),
    "Half-open UTC mission windows. Candidate starts are evaluated on a user-selected UTC grid.",
]
VISIBILITY = {
    "sun": "Apparent Sun center clears the terrain skyline and is outside the apparent Earth disc. "
           "Center qualification excludes solar-disc fraction, full shadow and solar-array power.",
    "earth": "Apparent Earth center clears the terrain skyline. Surface-terrain line of sight only.",
    "joint": "Both Sun-center qualification and Earth-center line of sight.",
    "uncertain": "Numerical or terrain bounds overlap the qualification threshold.",
    "unknown": "Unresolved terrain coverage or timestamps beyond the offline bundle.",
}


def _canonical(data):
    return json.dumps(data, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")).encode("ascii")


def _skyline_rows(skyline):
    return [
        [
            round(i * 360 / len(skyline.lower), 6),
            round(float(skyline.lower[i]), 6),
            round(float(skyline.upper[i]), 6),
            round(float(skyline.nominal[i]), 6) if np.isfinite(skyline.nominal[i]) else None,
            round(float(skyline.gap[i]), 6),
            [round(float(value), 7) for value in skyline.blockers[i]] if np.isfinite(skyline.blockers[i, 0]) else None,
        ]
        for i in range(len(skyline.lower))
    ]


def _bounds_report(coarse, fine, merged):
    levels = {key: longest_blocked_bounds(value) for key, value in
              (("coarse", coarse), ("fine", fine), ("retained", merged))}
    changes = [abs(a-b) for a, b in zip(levels["coarse"], levels["fine"], strict=True)]
    return {
        "coarseLongestBlockedRangeSeconds": levels["coarse"],
        "fineLongestBlockedRangeSeconds": levels["fine"],
        "retainedLongestBlockedRangeSeconds": levels["retained"],
        "maximumBoundShiftSeconds": max(changes),
        "scope": "Whole month as a diagnostic. For mission clips, both numerical evaluations must support the decision.",
        "targetUnder120Seconds": max(changes) < 120,
        "uncertainDurationSeconds": sum(end - start for start, end, state in merged if state == "uncertain"),
        "unknownDurationSeconds": sum(end - start for start, end, state in merged if state == "unknown"),
    }


def _site(raw, ephemeris, row, *, height_m=HEIGHT_M, include_plot=True, local_path=None,
          start=START, end=END, skylines=None):
    site_id, name, region, lat, lon, tile = row
    if not isinstance(start, int) or not isinstance(end, int) or start >= end:
        raise ValueError("Site calculations require increasing integer UTC epoch seconds")
    begin = perf_counter()
    if skylines is None:
        coarse = build_skyline(raw, tile, lat, lon, height_m, count=1800, radius_m=200_000, local_path=local_path)
        fine = build_skyline(raw, tile, lat, lon, height_m, count=3600, radius_m=240_000, local_path=local_path)
    else:
        coarse, fine = skylines
    label = f"{site_id} / {local_path.name}" if local_path else site_id
    print(f"{label} ({height_m:g} m): both terrain scans in {perf_counter() - begin:.1f}s", flush=True)
    visibility = Visibility(ephemeris, lat, lon, fine.info["observerRadiusM"])
    visibility.cache(range(start, end + 1, 60), measure=True)
    intervals = {}
    refinement_intervals = {}
    refinement = {}
    warnings = []
    for target in ("sun", "earth"):
        first = visibility.intervals(target, coarse, start, end, step=256, terminal=16)
        second = visibility.intervals(target, fine, start, end, step=128, terminal=8)
        intervals[target] = combine_refinements(first, second)
        refinement_intervals[target] = {"coarse": first, "fine": second}
        refinement[target] = _bounds_report(first, second, intervals[target])
        if not refinement[target]["targetUnder120Seconds"]:
            warnings.append(
                f"{target.title()} whole-month refinement shifts at least one longest-blocked bound "
                "by 2 minutes or more. Mission-specific enclosures retain both evaluations."
            )
        if refinement[target]["unknownDurationSeconds"]:
            warnings.append(f"{target.title()} intervals contain potentially blocking DEM gaps.")
    if fine.info["farBoundBins"]:
        warnings.append("The far-field search limit affects the terrain envelope in some bearings.")
    print(f"{label}: interval refinement {json.dumps(refinement)}", flush=True)
    return {
        "id": site_id, "name": name, "region": region, "lat": lat, "lon": lon,
        "source": SITE_SOURCE, "coordinateReference": "NASA Lunar Surface Data Book M2M-30044, table A2.1-1, p. 75",
        "coordinateStatus": "Published region center", "sourceFrame": "DE421 MOON_ME",
        "workingFrame": FRAME, "referenceRadiusM": RADIUS_M,
        "verticalDatum": "Radial metres above the 1,737,400 m lunar reference sphere",
        "groundM": fine.info["groundM"], "heightM": height_m,
        "terrain": {
            "warnings": warnings,
            "fine": fine.info, "coarse": coarse.info,
            "resolutionNote": "5 m local nominal spacing, ~90% interpolated. "
                              "80 m regional nominal spacing; effective resolution varies spatially.",
            "skylineColumns": ["azimuthStartDeg", "lowerDeg", "upperDeg", "centerModelDeg", "gapCapDeg",
                               "blocker[latDeg,lonDegE,surfaceDistanceM,elevationM]"],
            **({"skyline": _skyline_rows(fine)} if include_plot else {}),
        },
        **intervals,
        "refinementIntervals": refinement_intervals,
        "refinement": refinement,
        "maxSampledAngularRateDegMin": visibility.max_sampled_rate,
        **({"geometry": visibility.plot_samples(fine, start, end)} if include_plot else {}),
    }


def build(raw, horizons, output, demo_path, engine_commit):
    sources = source_manifest(raw)
    if horizons:
        comparison = json.loads(horizons.read_text(encoding="utf-8-sig"))
    else:
        comparison = {"test_id": "T03", "status": "UNVERIFIED", "references": []}
    with Ephemeris(raw) as ephemeris:
        coverage = ephemeris.coverage()
        sites = [_site(raw, ephemeris, row) for row in SITES]
    for reference in comparison["references"]:
        sources.append({
            "filename": reference["source_filename"], "url": reference["url"],
            "citation": "https://ssd.jpl.nasa.gov/horizons/",
            "bytes": reference["source_bytes"], "sha256": reference["source_sha256"],
            "product_version": "JPL Horizons API 1.2 / DE441",
            "local_file_acquired_utc": comparison["retrieved_utc"],
            "use": "Matched airless topocentric Sun/Earth direction validation; extracted comparisons embedded",
        })
    manifest = {
        "version": "1.0.0",
        "engineCommit": engine_commit,
        "aiUse": "OpenAI Codex assisted research, scientific implementation, tests, UI and documentation "
                 "under the direction of sole human entrant Arya Ergin. Model outputs are deterministic; "
                 "the offline app uses no runtime AI.",
        "aiGuidance": GUIDANCE,
        "challenge": {"url": CHALLENGE, "resourcesCrossCheck": LOCAL_MIRROR,
                      "status": "JPL Horizons verified in organizer mirror; official Resources tab unavailable at build."},
        "files": sources,
        "kernels": [source for source in sources if source["use"] == "JPL SPICE kernel"],
        "correctionConventions": {
            "spice": CORRECTION, "locus": "OBSERVER", "observerCenter": "Moon (301)",
            "sunTarget": 10, "earthTarget": 399, "atmosphericRefraction": False,
        },
        "frame": {
            "working": FRAME, "dem": "DE421 MOON_ME", "ephemeris": coverage,
            "conventions": "Planetocentric north latitude, east longitude [0,360), radial up, azimuth N=0° clockwise "
                           "through east, metres for terrain, SPICE vectors in km, UTC epoch seconds.",
            "alignment": "Fixed DE440 PA to DE421 ME offset; NAIF sampled mismatch is up to ~0.53 m (2000–2040).",
        },
        "versions": {
            "engine": ENGINE_VERSION, "python": platform.python_version(),
            "numpy": np.__version__, "rasterio": rasterio.__version__, "pyproj": pyproj.__version__,
            "spiceypy": spiceypy.__version__, "gdal": rasterio.__gdal_version__,
        },
        "validation": {
            "horizons": comparison,
            "terrainAngularAndRange": {"coarse": [0.2, 200000], "fine": [0.1, 240000]},
            "temporal": {"coarseInitialStepS": 256, "fineInitialStepS": 128, "coarseTerminalS": 16,
                         "fineTerminalS": 8, "angularRateEnvelopeDegMin": RATE_DEG_PER_S * 60},
            "lunarRadialCapEvidence": "https://science.nasa.gov/photojournal/highest-point-on-the-moon/",
            "solarOccultation": {"earthRadiusKm": [6356.75, 6378.137],
                                 "catalog": "https://eclipse.gsfc.nasa.gov/LEdecade/LEdecade2021.html"},
        },
        "visibilityDefinitions": VISIBILITY, "limitations": LIMITS,
        "transformations": "Native LOLA cells to lunar Cartesian elevation bounds. Refine terrain ranges, angular bins "
                           "and apparent directions, retain both interval enclosures, export compressed runs.",
    }
    demo = json.loads(demo_path.read_text(encoding="utf-8-sig"))
    bundle = {"version": ENGINE_VERSION, "coverage": [START, END], "sites": sites, "manifest": manifest, "demo": demo}
    _write_bundle(bundle, output)


def _write_bundle(bundle, output):
    manifest = bundle["manifest"]
    # Canonical fingerprint excludes its own fields, including on resumed/staged writes.
    manifest.pop("bundleSha256", None)
    manifest.pop("bundleHashConvention", None)
    manifest["bundleSha256"] = sha256(_canonical(bundle)).hexdigest()
    manifest["bundleHashConvention"] = (
        "SHA-256 of UTF-8 minified JSON with ASCII escapes and recursively sorted keys, "
        "before adding bundleSha256 and bundleHashConvention."
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".json.tmp")
    temporary.write_bytes(_canonical(bundle) + b"\n")
    temporary.replace(output)
    print(f"Wrote {output} ({output.stat().st_size:,} bytes), bundle SHA-256 {manifest['bundleSha256']}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=Path("data/raw"))
    parser.add_argument("--horizons-validation", type=Path, default=Path("web/data/horizons-validation.json"))
    parser.add_argument("--out", type=Path, default=Path("web/data/bundle.json"))
    parser.add_argument("--demo", type=Path, default=Path("web/data/demo.json"))
    parser.add_argument("--engine-commit", default=ENGINE_COMMIT)
    args = parser.parse_args()
    build(args.raw, args.horizons_validation, args.out, args.demo, args.engine_commit)
