import math
from pathlib import Path

import numpy as np
import pytest
import rasterio
from pyproj import CRS, Transformer

from science.sources import SITES
from science.terrain import angles_over_range, bin_cells, project, unproject


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
