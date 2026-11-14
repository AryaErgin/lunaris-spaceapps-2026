from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

from science.ephemerides import (
    FILES,
    Ephemeris,
    angular_distance_deg,
    enu_basis,
    parse_horizons,
    unit_from_azimuth_elevation,
    validate_horizons_header,
)


@pytest.mark.parametrize("lat,lon", [(0, 0), (-89.4632, 222.51), (90, 270), (45, 123)])
def test_t01_enu_is_right_handed_and_orthonormal(lat, lon):
    basis = enu_basis(lat, lon)
    np.testing.assert_allclose(basis @ basis.T, np.eye(3), atol=1e-12, rtol=0)
    np.testing.assert_allclose(np.cross(*basis[:2]), basis[2], atol=1e-12, rtol=0)


def test_t01_axes_and_cardinal_directions():
    np.testing.assert_allclose(enu_basis(0, 0), ((0, 1, 0), (0, 0, 1), (1, 0, 0)))
    directions = unit_from_azimuth_elevation([0, 90, 180, 270, 150], [0, 0, 0, 0, 90])
    np.testing.assert_allclose(directions, ((0, 1, 0), (1, 0, 0), (0, -1, 0), (-1, 0, 0), (0, 0, 1)), atol=1e-12)


def test_angular_distance_wraps_azimuth():
    left, right = unit_from_azimuth_elevation([359.999, 0.001], [0, 0])
    assert angular_distance_deg(left, right) == pytest.approx(0.002, abs=1e-12)


def test_horizons_csv_uses_ephemeris_bounds_and_preserves_airless_angles():
    output = (
        "Center geodetic : 222.510000,-89.463200,0.0000000\n"
        "Center radii    : 1737.4, 1737.4, 1737.4 km\n"
        "Date__(UT)__HR:MN, , , Azi_(a-app), Elev_(a-app),\n"
        "$$SOE\n2026-Nov-01 00:00, , , 257.02101, 1.37804,\n"
        "2026-Nov-10 00:00, , *, 359.99900, -2.01829,\n$$EOE\n"
        "literal explanatory CSV, 17, 19,\n"
    )
    result = parse_horizons(output)
    assert result[0] == {"utc": "2026-11-01T00:00:00Z", "azimuth_deg": 257.02101, "elevation_deg": 1.37804}
    assert result[1]["elevation_deg"] == -2.01829
    assert len(result) == 2
    with pytest.raises(ValueError, match="ephemeris delimiters"):
        parse_horizons("API result with no ephemeris")


def test_horizons_header_requires_the_same_observer_height():
    output = (
        "API VERSION: 1.2\n"
        "Target body name: Earth (399) {source: DE441}\n"
        "Center body name: Moon (301) {source: DE441}\n"
        "Center geodetic : 222.51, -89.4632, 1.95 {E-lon(deg),Lat(deg),Alt(km)}\n"
        "Center pole/equ : MEAN_ME (high precision)\n"
        "Center radii    : 1737.4, 1737.4, 1737.4 km\n"
        "Atmos refraction: NO (AIRLESS)\n$$SOE\n"
    )
    assert len(validate_horizons_header(output, "earth", "399", -89.4632, 222.51, 1_739_350)) == 7
    with pytest.raises(ValueError, match="coordinates or height"):
        validate_horizons_header(output, "earth", "399", -89.4632, 222.51, 1_737_400)


KERNEL_DIRECTORY = Path(__file__).resolve().parents[1] / "data" / "raw"


@pytest.mark.skipif(any(not (KERNEL_DIRECTORY / name).is_file() for name in FILES), reason="download NASA kernels for integration test")
def test_surface_vectors_use_two_target_distances_and_declared_coverage():
    epochs = [datetime(2026, 11, date, tzinfo=timezone.utc).timestamp() for date in (1, 10)]
    with Ephemeris(KERNEL_DIRECTORY) as kernel:
        coverage = kernel.coverage()
        sun, earth = kernel.vectors(-89.4632, 222.51, 1_737_400.0, epochs)
        empty_sun, empty_earth = kernel.vectors(-89.4632, 222.51, 1_737_400.0, [])
    assert coverage["spk"]["10"]
    assert coverage["spk"]["301"]
    assert coverage["spk"]["399"]
    assert coverage["orientation"]
    assert sun.shape == earth.shape == (2, 3)
    assert empty_sun.shape == empty_earth.shape == (0, 3)
    assert 145e6 < np.linalg.norm(sun[0]) < 155e6
    assert 340e3 < np.linalg.norm(earth[0]) < 410e3
    assert angular_distance_deg(sun[0], sun[1]) > 100
