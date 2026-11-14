"""Curved lunar skyline enclosures over a nested, radial-height DEM model."""

from dataclasses import dataclass
from math import floor
from pathlib import Path

import numpy as np
import rasterio
from pyproj import CRS
from rasterio.windows import Window

from science.sources import REGIONAL

RADIUS_M = 1_737_400.0
# 1,750 km deliberately rounds above the highest LOLA radius (~1,748.2 km).
CAP_RADIUS_M = 1_750_000.0
STEREO = CRS.from_proj4(
    "+proj=stere +lat_0=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs"
)


def project(lat_deg, lon_deg):
    rho = 2 * RADIUS_M * np.tan(np.deg2rad(90 + np.asarray(lat_deg)) / 2)
    lon = np.deg2rad(lon_deg)
    return rho * np.sin(lon), rho * np.cos(lon)


def unproject(x, y):
    lat = np.rad2deg(2 * np.arctan2(np.hypot(x, y), 2 * RADIUS_M)) - 90
    lon = np.rad2deg(np.arctan2(x, y)) % 360
    return lat, lon


def _elevation(radius, observer, angle):
    rise = radius - observer - 2 * radius * np.sin(angle / 2) ** 2
    return np.rad2deg(np.arctan2(rise, radius * np.sin(angle)))


def angles_over_range(radius, observer, near, far):
    first = _elevation(radius, observer, near)
    last = _elevation(radius, observer, far)
    tangent = np.arccos(np.clip(radius / observer, -1, 1))
    peak = _elevation(radius, observer, np.clip(tangent, near, far))
    return np.minimum(first, last), np.maximum(np.maximum(first, last), peak)


def bin_cells(start, end, values, count, *, entire, track=True):
    """Aggregate all cells overlapping bins, or just cells covering a whole bin."""
    width = 360 / count
    if entire:
        left = np.ceil(start / width).astype(np.int32)
        right = np.floor(end / width).astype(np.int32) - 1
    else:
        left = np.floor(start / width).astype(np.int32)
        right = np.floor(end / width).astype(np.int32)
    distance = np.minimum(count - 1, right - left)
    winners = np.full(count, -np.inf)
    indices = np.full(count, -1, dtype=np.int32)
    offsets = np.flatnonzero(distance >= 0)
    for step in range(int(distance.max(initial=-1)) + 1):
        sectors = (left[offsets] + step) % count
        sample = values[offsets]
        np.maximum.at(winners, sectors, sample)
        if track:
            hit = sample == winners[sectors]
            indices[sectors[hit]] = offsets[hit]
        offsets = offsets[distance[offsets] > step]
    return winners, indices


@dataclass
class Skyline:
    lower: np.ndarray
    upper: np.ndarray
    nominal: np.ndarray
    gap: np.ndarray
    far_cap: float
    blockers: np.ndarray
    info: dict


def _raster_description(dataset):
    actual = CRS.from_wkt(dataset.crs.to_wkt())
    params = actual.coordinate_operation.params
    by_name = {p.name: p.value for p in params}
    if (
        abs(actual.ellipsoid.semi_major_metre - RADIUS_M) > 0.1
        or abs(actual.ellipsoid.semi_minor_metre - RADIUS_M) > 0.1
        or "stereographic" not in actual.coordinate_operation.method_name.lower()
        or dataset.transform.b != 0 or dataset.transform.d != 0
        or abs(dataset.transform.a + dataset.transform.e) > 1e-6
        or dataset.transform.a <= 0
        or abs(by_name.get("Longitude of natural origin", by_name.get("Longitude of origin", 999))) > 1e-8
        or abs(by_name.get("Scale factor at natural origin", 1.) - 1.) > 1e-8
        or abs(by_name.get("Latitude of natural origin", by_name.get("Latitude of standard parallel", 999)) + 90) > 1e-6
        or abs(by_name.get("False easting", 0)) > 1e-8
        or abs(by_name.get("False northing", 0)) > 1e-8
    ):
        raise ValueError(f"Unexpected lunar CRS/transform in {dataset.name}: {dataset.crs}, {by_name}")
    return {
        "filename": Path(dataset.name).name,
        "wkt": actual.to_wkt(),
        "affine": list(dataset.transform)[:6],
        "spacingM": dataset.res[0],
        "boundsM": tuple(dataset.bounds),
        "dimensions": [dataset.width, dataset.height],
        "noData": "NaN" if dataset.nodata is not None and np.isnan(dataset.nodata) else dataset.nodata,
        "maskFlags": [flag.name for flag in dataset.mask_flag_enums[0]],
        "areaOrPoint": dataset.tags().get("AREA_OR_POINT"),
    }


def _coverage_radius(dataset, x, y):
    left, bottom, right, top = dataset.bounds
    return min(x - left, right - x, y - bottom, top - y)


def _scan(dataset, lat, lon, observer, inner, outer, count, horizon):
    x, y = project(lat, lon)
    transform = dataset.transform
    pixel = dataset.res[0]
    half_diag = pixel / np.sqrt(2)
    # Stereographic projection scale equals 1 + rho²/(4R²). Window
    # coordinates overestimate the length of spherical surface paths.
    projected = outer * 1.015 + 2 * pixel
    col, row = (~transform) * (x, y)
    c0, c1 = max(0, floor(col - projected / pixel)), min(dataset.width, floor(col + projected / pixel) + 1)
    r0, r1 = max(0, floor(row - projected / pixel)), min(dataset.height, floor(row + projected / pixel) + 1)
    clipping = np.deg2rad(lat)
    sin_ref, cos_ref = np.sin(clipping), np.cos(clipping)
    upper, lower, gaps, nominal, blockers = horizon
    valid_count = invalid_count = 0
    for start_row in range(r0, r1, 96):
        stop = min(start_row + 96, r1)
        data = dataset.read(1, window=Window(c0, start_row, c1 - c0, stop - start_row), masked=True)
        east_m = transform.c + (np.arange(c0, c1) + 0.5) * pixel
        north_m = transform.f - (np.arange(start_row, stop) + 0.5) * pixel
        grid_lat, grid_lon = unproject(east_m[None, :], north_m[:, None])
        phi = np.deg2rad(grid_lat)
        dlon = np.deg2rad(grid_lon - lon)
        east = np.cos(phi) * np.sin(dlon)
        north = cos_ref * np.sin(phi) - sin_ref * np.cos(phi) * np.cos(dlon)
        radial = sin_ref * np.sin(phi) + cos_ref * np.cos(phi) * np.cos(dlon)
        angular = np.arctan2(np.hypot(east, north), radial)
        angular_pad = half_diag / RADIUS_M
        near = np.maximum(0., angular - angular_pad)
        far = angular + angular_pad
        included = (far * RADIUS_M > inner) & (near * RADIUS_M < outer)
        core = (near * RADIUS_M >= inner) & (far * RADIUS_M <= outer)
        # Bounds cover entire interface cells. Their lower contribution
        # requires a full footprint within the active annulus.
        valid = included & ~np.ma.getmaskarray(data) & np.isfinite(data.data)
        invalid = included & ~valid
        valid_count += int(valid.sum())
        invalid_count += int(invalid.sum())
        az = np.rad2deg(np.arctan2(east, north)) % 360
        horizontal = np.sin(angular)
        # Use an enclosing spherical cap for the upper bound and the
        # inscribed circle of the native square for the lower bound.
        upper_span = np.rad2deg(np.arcsin(np.minimum(1., np.sin(angular_pad) / np.maximum(horizontal, 1e-16))))
        upper_span = np.where(angular <= angular_pad, 180., upper_span)
        projected_rho = np.hypot(east_m[None, :], north_m[:, None]) + half_diag
        local_scale = 1. + (projected_rho / (2 * RADIUS_M)) ** 2
        inscribed = pixel / (2 * RADIUS_M * local_scale)
        lower_span = np.rad2deg(np.arcsin(np.minimum(1., np.sin(inscribed) / np.maximum(horizontal, 1e-16))))
        lower_span = np.where(angular < inscribed, 180., lower_span)
        if invalid.any():
            cap = _elevation(CAP_RADIUS_M, observer, near[invalid])
            gap_az, gap_pad = az[invalid], upper_span[invalid]
            missing, _ = bin_cells(gap_az-gap_pad, gap_az+gap_pad, cap, count, entire=False, track=False)
            np.maximum(gaps, missing, out=gaps)
        if not valid.any():
            continue
        radius = RADIUS_M + data.data[valid].astype(float)
        if radius.max() > CAP_RADIUS_M:
            raise ValueError("A DEM sample exceeds the documented radial cap")
        lo, hi = angles_over_range(radius, observer, near[valid], far[valid])
        az_valid, pad_valid = az[valid], upper_span[valid]
        strip_upper, _ = bin_cells(az_valid-pad_valid, az_valid+pad_valid, hi, count, entire=False, track=False)
        np.maximum(upper, strip_upper, out=upper)
        whole = core[valid]
        low_pad = lower_span[valid][whole]
        strip_lower, _ = bin_cells(az_valid[whole]-low_pad, az_valid[whole]+low_pad, lo[whole], count,
                                  entire=True, track=False)
        np.maximum(lower, strip_lower, out=lower)
        representative = _elevation(radius, observer, angular[valid])
        strip_nominal, idx = bin_cells(az_valid-pad_valid, az_valid+pad_valid, representative, count, entire=False)
        winners = strip_nominal > nominal
        if winners.any():
            selected = idx[winners]
            blockers[winners] = np.column_stack((grid_lat[valid][selected], grid_lon[valid][selected],
                                                 angular[valid][selected] * RADIUS_M, data.data[valid][selected]))
        np.maximum(nominal, strip_nominal, out=nominal)
    return {"sampledValidCells": valid_count, "sampledMaskedCells": invalid_count}


def build_skyline(raw, tile, lat, lon, height_m, *, count=3600, radius_m=240_000):
    x, y = project(lat, lon)
    with (
        rasterio.open(raw / f"{tile}_final_adj_5mpp_surf.tif") as local,
        rasterio.open(raw / REGIONAL) as regional,
    ):
        local_info, regional_info = _raster_description(local), _raster_description(regional)
        local_limit = _coverage_radius(local, x, y)
        regional_limit = _coverage_radius(regional, x, y)
        if local_limit < 500 or regional_limit < radius_m * 1.015:
            raise ValueError(f"Site/radius outside raster coverage: {tile}, {local_limit=}, {regional_limit=}")
        row, col = local.index(x, y)
        delta_x, delta_y = local.xy(row, col)
        back_row, back_col = (~local.transform) * (delta_x, delta_y)
        raster_error = max(abs(back_row - col - 0.5), abs(back_col - row - 0.5))
        lat_check, lon_check = unproject(x, y)
        check_x, check_y = project(lat_check, lon_check)
        projected_error = np.hypot(check_x - x, check_y - y) / local.res[0]
        if max(raster_error, projected_error) > 0.1:
            raise ValueError(f"Site round-trip exceeds 0.1 pixel: {tile}")
        cell = local.read(1, window=Window(col, row, 1, 1), masked=True)[0, 0]
        if np.ma.is_masked(cell) or not np.isfinite(cell):
            raise ValueError(f"No local DEM observer height at {tile}")
        ground = float(cell)
        observer = RADIUS_M + ground + height_m
        arrays = [np.full(count, -np.inf) for _ in range(4)]
        blockers = np.full((count, 4), np.nan)
        horizon = (*arrays, blockers)
        local_outer = min(5_000, (local_limit - 20) / 1.015)
        regional_inner = max(0, local_outer - 180)
        local_scan = _scan(local, lat, lon, observer, 0, local_outer, count, horizon)
        region_scan = _scan(regional, lat, lon, observer, regional_inner, radius_m, count, horizon)
        upper, lower, gaps, nominal = arrays
        empty = ~np.isfinite(upper)
        upper[empty] = 90.
        lower[~np.isfinite(lower)] = -90.
        gaps[~np.isfinite(gaps)] = -90.
        gaps[empty] = 90.
        nominal[empty] = np.nan
        far_cap = float(_elevation(CAP_RADIUS_M, observer, radius_m / RADIUS_M))
        info = {
            "groundM": ground, "observerRadiusM": observer, "radialCapM": CAP_RADIUS_M,
            "searchRadiusM": radius_m, "azimuthBinDeg": 360 / count,
            "localOuterM": local_outer, "regionalInnerM": regional_inner,
            "outerUnmodeledElevationCapDeg": far_cap,
            "nativeRasterRoundTripErrorPixels": max(raster_error, projected_error),
            "local": local_info | local_scan, "regional": regional_info | region_scan,
            "gapBins": int((gaps > upper).sum()),
            "farBoundBins": int((far_cap > upper).sum()),
        }
        return Skyline(lower, upper, nominal, gaps, far_cap, blockers, info)
