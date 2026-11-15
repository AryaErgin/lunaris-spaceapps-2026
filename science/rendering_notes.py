"""Presentation evidence from existing native DEMs and the frozen mission cache.

This never changes terrain, visibility, constraints, scenarios or the bundle.
Run ``python -m science.rendering_notes`` to rebuild the small rendering sidecar.
"""

import argparse
import json
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

from science.scene_terrain import (
    _scene_site_row,
    checked_terrain_source,
    local_positions,
    scene_site_rows,
)
from science.terrain import RADIUS_M, _raster_description, project, unproject

RAY_AUDIT_UTC = "2026-11-17T03:00:00Z"


def central_difference_slope(positions, valid):
    """Fit east/north rise/run from physical cross-stencil differences.

    Positions are local Cartesian (east, radial-up, minus-north), in metres.
    A 3x3 raster supplies the center plus its four cardinal native neighbors.
    This is a DEM-model ground gradient, not an apparent skyline elevation.
    """
    positions = np.asarray(positions, dtype=float)
    valid = np.asarray(valid, dtype=bool)
    if positions.shape != (3, 3, 3) or valid.shape != (3, 3):
        raise ValueError("Expected physical 3x3 XYZ positions and their validity mask")
    required = [(1, 1), (1, 0), (1, 2), (0, 1), (2, 1)]
    if any(not valid[row, col] or not np.isfinite(positions[row, col]).all() for row, col in required):
        return {"status": "INDETERMINATE", "slopeDeg": None, "gradientEast": None,
                "gradientNorth": None, "reason": "A required center or cardinal native DEM sample is missing"}
    column = positions[1, 2] - positions[1, 0]
    northing = positions[0, 1] - positions[2, 1]
    horizontal = np.array([[column[0], -column[2]], [northing[0], -northing[2]]])
    if abs(np.linalg.det(horizontal)) < 1e-10:
        return {"status": "INDETERMINATE", "slopeDeg": None, "gradientEast": None,
                "gradientNorth": None, "reason": "Degenerate physical horizontal stencil"}
    gradient = np.linalg.solve(horizontal, [column[1], northing[1]])
    return {"status": "COMPUTED", "slopeDeg": float(np.rad2deg(np.arctan(np.linalg.norm(gradient)))),
            "gradientEast": float(gradient[0]), "gradientNorth": float(gradient[1]),
            "centralDifferenceHorizontalSpansM": np.linalg.norm(horizontal, axis=1).tolist()}


def _site_note(raw, site, tile):
    if _scene_site_row(site)[5] != tile:
        raise ValueError(f'Wrong native source tile for study point: {site["id"]}')
    filename = f"{tile}_final_adj_5mpp_surf.tif"
    path = raw / filename
    source = checked_terrain_source(raw, filename)
    with rasterio.open(path) as dataset:
        x, y = project(site["lat"], site["lon"])
        row, col = dataset.index(x, y)
        if row < 1 or col < 1 or row >= dataset.height - 1 or col >= dataset.width - 1:
            raise ValueError(f"Study point lacks a complete native 3x3 window: {site['id']}")
        data = dataset.read(1, window=Window(col - 1, row - 1, 3, 3), masked=True)
        valid = ~np.ma.getmaskarray(data) & np.isfinite(data.data)
        if valid[1, 1] and float(data[1, 1]) != site["groundM"]:
            raise ValueError(f"Native observer ground differs from frozen bundle: {site['id']}")
        cols, rows = np.meshgrid(np.arange(col - 1, col + 2), np.arange(row - 1, row + 2))
        px = dataset.transform.c + (cols + .5) * dataset.transform.a
        py = dataset.transform.f + (rows + .5) * dataset.transform.e
        lat, lon = unproject(px, py)
        # Add a lunar radius in float64; float32 native heights would quantize
        # radii in 0.125 m steps and corrupt a five-metre ground gradient.
        positions = local_positions(site["lat"], site["lon"], site["groundM"], lat, lon,
                                    np.where(valid, data.data.astype(np.float64), np.nan))
        result = central_difference_slope(positions, valid)
        description = _raster_description(dataset)
        center_x, center_y = dataset.xy(row, col)
    return {"siteId": site["id"], "name": site["name"], "latitudeDeg": site["lat"],
            "longitudeEastDeg": site["lon"], "coordinateStatus": site["coordinateStatus"],
            "groundM": site["groundM"], "observerHeightM": site["heightM"],
            "sourceFrame": site["sourceFrame"], "workingFrame": site["workingFrame"],
            "slope": result,
            "stencil": {"centerRow": row, "centerColumn": col,
                        "nativePixelSpacingM": description["spacingM"],
                        "windowOffsetColumnRow": [col - 1, row - 1],
                        "centerProjectedCoordinateM": [center_x, center_y],
                        "studyPointProjectedCoordinateM": [float(x), float(y)],
                        "centerOffsetFromStudyPointProjectedM": [center_x - float(x), center_y - float(y)],
                        "elevationM": [[float(data.data[r, c]) if valid[r, c] else None for c in range(3)] for r in range(3)],
                        "valid": valid.tolist(),
                        "requiredCellsRowColumn": [[1, 1], [1, 0], [1, 2], [0, 1], [2, 1]],
                        "sampleLocation": "Native raster cell containing the exact published observer point; a gradient of its neighboring cell centers, not a point-scale measured surface slope"},
            "source": source,
            "warning": "Local NASA DEM-model ground gradient; this is not a skyline elevation, landing-site approval, lander limit, hazard certification or a slope constraint in the mission engine. Nominal 5 m spacing does not imply independent 5 m measurements."}


def _ray_audit(bundle):
    timestamp = datetime.fromisoformat(RAY_AUDIT_UTC.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    site = next((item for item in bundle["sites"] if item["id"] == "de-gerlache-rim"), None)
    if site is None:
        return {"siteId": "de-gerlache-rim", "utc": RAY_AUDIT_UTC, "rays": [], "status": "INDETERMINATE",
                "reason": "The recovery demonstration study point is not present in this bundle"}
    sample = next((row for row in site.get("geometry", []) if row[0] == timestamp), None)
    report = {"siteId": site["id"], "utc": RAY_AUDIT_UTC, "observerHeightM": site["heightM"],
              "scope": "Only these exact cached azimuth samples at the Nov 17 03:00 UTC recovery start; blocker positions and ranges vary with azimuth and time. These are nominal model witnesses, not an independent rescan or a finite-disc visibility calculation.",
              "source": "Frozen bundle terrain.skyline and geometry; skyline columns retain their original meanings",
              "rays": []}
    if sample is None:
        return report | {"status": "INDETERMINATE", "reason": "Exact audit UTC has no cached geometry row"}
    width = site["terrain"]["fine"]["azimuthBinDeg"]
    for body, azimuth_column, elevation_column in (("sun", 1, 2), ("earth", 4, 5)):
        azimuth = sample[azimuth_column] % 360
        index = int(np.floor(azimuth / width))
        row = site["terrain"]["skyline"][index]
        blocker = row[5]
        ray = {"body": body, "cachedAzimuthDeg": azimuth, "cachedElevationDeg": sample[elevation_column],
               "skylineBinIndex": index, "skylineAzimuthStartDeg": row[0], "skylineBinWidthDeg": width,
               "nominalSkylineElevationDeg": row[3], "skylineLowerDeg": row[1], "skylineUpperDeg": row[2],
               "gapCapDeg": row[4], "nominalBlocker": None}
        if blocker is not None:
            ray["nominalBlocker"] = {"latitudeDeg": blocker[0], "longitudeEastDeg": blocker[1],
                                     "surfaceDistanceM": blocker[2], "radialElevationM": blocker[3]}
        report["rays"].append(ray)
    return report | {"status": "READ_FROM_FROZEN_CACHE"}


def build_notes(raw, bundle_path, output):
    raw, bundle_path, output = Path(raw), Path(bundle_path), Path(output)
    bundle_bytes = bundle_path.read_bytes()
    bundle = json.loads(bundle_bytes)
    rows = scene_site_rows(bundle)
    sites = {site["id"]: site for site in bundle["sites"]}
    notes = {"version": "1.0.0", "kind": "Presentation verification of existing NASA terrain and frozen nominal skyline witnesses",
             "bundleFileSha256": sha256(bundle_bytes).hexdigest(),
             "bundlePayloadSha256": bundle.get("manifest", {}).get("bundleSha256"),
             "referenceSphereRadiusM": RADIUS_M,
             "method": "For each exact published study point, select its containing native 5 m DEM cell and a 3x3 window. Convert native neighboring cell centers and radial elevations to curved lunar Cartesian positions, then the point's radial-up/east/north basis. Solve [deltaEast,deltaNorth] dot [dUp/dEast,dUp/dNorth] = deltaUp for the east-west and north-south central pairs. Slope is atan(hypot(the two gradient components)). Physical horizontal chord distances account for projection scale, actual ground radius and lunar curvature. Required masked/nonfinite samples yield INDETERMINATE, never a flat slope.",
             "slopeMeaning": "Local finite-difference gradient of the native DEM model around the containing pixel; distinct from all apparent skyline angles. Not a landing-safety criterion and not used by the mission engine.",
             "sites": [_site_note(raw, sites[row[0]], row[5]) for row in rows],
             "recoveryStartRayAudit": _ray_audit(bundle),
             "reproduce": "python -m science.rendering_notes --raw data/raw --bundle web/data/bundle.json --output web/data/rendering-notes.json",
             "aiUse": "OpenAI Codex and Anthropic Claude assisted implementation, testing and writing of this presentation-only evidence derivative under human teammates Arya Ergin and Aras."}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(notes, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    return notes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=Path("data/raw"))
    parser.add_argument("--bundle", type=Path, default=Path("web/data/bundle.json"))
    parser.add_argument("--output", type=Path, default=Path("web/data/rendering-notes.json"))
    args = parser.parse_args()
    notes = build_notes(args.raw, args.bundle, args.output)
    print(json.dumps({"slopes": [{"siteId": site["siteId"], **site["slope"]} for site in notes["sites"]],
                      "rayAudit": notes["recoveryStartRayAudit"]}))


if __name__ == "__main__":
    main()
