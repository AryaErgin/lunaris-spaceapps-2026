import math
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import rasterio
from affine import Affine
from pyproj import CRS, Transformer
from rasterio.io import MemoryFile

from science.sources import SITES
from science.terrain import (
    RADIUS_M,
    STEREO,
    _scan,
    angles_over_range,
    bin_cells,
    project,
    unproject,
)
from science.visibility import Visibility


def test_t02_lunar_stereographic_round_trip():
    lat = np.array([-89.4632, -89.7668, -88.6834, -80.9])
    lon = np.array([222.510, 188.130, 292.0679, 94.0])
    x, y = project(lat, lon)
    recovered_lat, recovered_lon = unproject(x, y)
    round_x, round_y = project(recovered_lat, recovered_lon)
    assert max(np.hypot(x - round_x, y - round_y)) < 0.5
    np.testing.assert_allclose(recovered_lat, lat, atol=1e-10)
    np.testing.assert_allclose(recovered_lon, lon, atol=1e-10)
    assert project(-89, 90)[0] > 30000
    assert abs(project(-89, 0)[0]) < 1e-9
    assert project(-89, 0)[1] > 30000


def test_t02_real_tiff_crs_matches_analytic_projection():
    paths = [Path("data/raw") / f"{row[-1]}_final_adj_5mpp_surf.tif" for row in SITES]
    if not all(path.is_file() for path in paths):
        pytest.skip("download NASA terrain to run native CRS verification")
    for (_, _, _, lat, lon, _), path in zip(SITES, paths, strict=True):
        with rasterio.open(path) as raster:
            crs = CRS.from_wkt(raster.crs.to_wkt())
            forward = Transformer.from_crs(crs.geodetic_crs, crs, always_xy=True)
            np.testing.assert_allclose(forward.transform(lon, lat), project(lat, lon),
                                       atol=raster.res[0] * 0.1, rtol=0)


def test_t04_elevated_sphere_has_negative_horizon():
    radius = 1737400.0
    observer = radius + 15
    low, high = angles_over_range(radius, observer, np.array([0.00005]), np.array([0.02]))
    expected = -math.degrees(math.acos(radius / observer))
    assert low[0] < high[0] < 0
    assert abs(high[0] - expected) < 0.01


def test_t05_narrow_ridge_between_ray_centers_contributes_to_upper_bound():
    start, end = np.array([0.484]), np.array([0.498])
    elevated_height = math.degrees(math.atan2(12, 100))
    heights, indices = bin_cells(start, end, np.array([elevated_height]), 360, entire=False)
    assert heights[0] == elevated_height
    assert indices[0] == 0
    assert np.isneginf(heights[1])
    lower, _ = bin_cells(start, end, np.array([elevated_height]), 360, entire=True)
    assert np.isneginf(lower[0])


def test_t05_cell_spanning_north_populates_both_sides():
    values, _ = bin_cells(np.array([-0.2]), np.array([0.2]), np.array([-0.5]), 360, entire=False)
    assert values[-1] == values[0] == -0.5
    assert np.isneginf(values[1])


def test_t09_masked_north_cell_censors_solar_intervals():
    lat, lon, observer = -89., 15., RADIUS_M + 2
    x, y = project(lat, lon)
    north = np.deg2rad(lon)
    missing_x, missing_y = x + 100 * np.sin(north), y + 100 * np.cos(north)
    with (
        MemoryFile() as memory,
        memory.open(
            driver="GTiff", width=1, height=1, count=1, dtype="float32",
            transform=Affine(5, 0, missing_x - 2.5, 0, -5, missing_y + 2.5),
            crs=STEREO.to_wkt(), nodata=-9999.,
        ) as tile,
    ):
        tile.write(np.full((1, 1, 1), -9999, dtype=np.float32))
        upper, lower, gap, nominal = (np.full(360, -np.inf) for _ in range(4))
        scan = _scan(tile, lat, lon, observer, 0, 200, 360,
                     (upper, lower, gap, nominal, np.full((360, 4), np.nan)))
    assert scan["sampledMaskedCells"] == 1
    assert np.isfinite(gap[0])
    assert np.isneginf(gap[180])

    class ConstantEphemeris:
        def vectors(self, lat, lon, radius, times):
            return (
                np.repeat([[0., 1.5e8, 1.e6]], len(times), axis=0),
                np.repeat([[370000., 0., 0.]], len(times), axis=0),
            )

    skyline = SimpleNamespace(lower=np.full(360, -1.), upper=np.full(360, -1.), gap=gap, far_cap=-2.)
    visibility = Visibility(ConstantEphemeris(), lat, lon, observer)
    assert visibility.intervals("sun", skyline, 0, 100, step=100, terminal=8) == [[0, 100, "unknown"]]
