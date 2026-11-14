"""Synthetic and pinned-record checks for continuous kernel-model enclosures."""

import importlib
import importlib.util
import math
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path

import numpy as np
import pytest
import spiceypy as spice

from science.ephemerides import FILES, Ephemeris

RAW = Path("data/raw")
HAS_KERNELS = all((RAW / filename).is_file() for filename in FILES)


def module():
    assert importlib.util.find_spec("science.motion_envelope"), "Implement the independent kernel-polynomial enclosure"
    return importlib.import_module("science.motion_envelope")


def test_interval_enclosure_contains_internal_extremum_and_scaled_derivative():
    motion = module()
    lower, upper = motion.chebyshev_bounds([0, 0, 1], 0, 1, -1, 1)
    assert lower <= -1 and upper >= 1  # T2 has its minimum inside the interval.
    lower, upper = motion.chebyshev_bounds([0, 0, 1], 10, 2, 9.75, 10.25, derivative=1)
    assert lower <= -0.25 and upper >= 0.25
    assert upper - lower < 0.501
    with pytest.raises(ValueError, match="record"):
        motion.chebyshev_bounds([1, 2], 0, 1, -1.1, 0)


@pytest.mark.parametrize("derivative", [0, 1])
def test_outward_rounding_encloses_exact_rational_cancellation(derivative):
    motion = module()
    coefficients = [1e12, -1e12, 1e12]
    point = 0.999999
    x = Fraction.from_float(point)
    c0, c1, c2 = map(Fraction.from_float, coefficients)
    exact = c0 + c1 * x + c2 * (2 * x * x - 1) if derivative == 0 else c1 + 4 * c2 * x
    lower, upper = motion.chebyshev_bounds(coefficients, 0, 1, point, point, derivative=derivative)
    assert Fraction.from_float(lower) <= exact <= Fraction.from_float(upper)


def test_retarded_budget_includes_piecewise_record_position_and_velocity_jumps():
    motion = module()
    arithmetic = motion._Rounded(50)
    scalar = arithmetic.scalar
    # Constant position records can differ by 2 km at a seam while each has
    # zero derivative. A retarded epoch can be on the other side of that seam.
    options = {"geometric_min": scalar(102), "geometric_max": scalar(102),
               "relative_speed": scalar(0), "target_speed": scalar(0), "target_acceleration": scalar(0),
               "radius": scalar(0), "frame_speed": scalar(0), "guard": scalar(1),
               "position_jump": scalar(2), "velocity_jump": scalar(0)}
    lower, upper, _ = motion._retarded_budget(arithmetic, **options)
    assert float(lower[0]) <= 100 and float(upper[1]) >= 104
    # Co-moving target/observer records can have zero same-epoch relative
    # speed, but opposite sides of a shared velocity seam differ by 0.5 km/s.
    options.update(target_speed=scalar(0.5), position_jump=scalar(0), velocity_jump=scalar(0.5))
    _, _, speed = motion._retarded_budget(arithmetic, **options)
    assert float(speed[1]) >= 0.5


def test_disc_radius_budget_encloses_finite_range_changes():
    motion = module()
    arithmetic = motion._Rounded(50)
    rate, jump = motion._disc_budget(arithmetic, arithmetic.scalar(350_000),
                                     arithmetic.scalar(2), arithmetic.scalar(100))
    near = math.asin(6378.137 / 350_000)
    one_second_change = math.degrees(near - math.asin(6378.137 / 350_002))
    seam_change = math.degrees(near - math.asin(6378.137 / 350_100))
    assert float(rate[1]) >= one_second_change
    assert float(rate[1]) < 0.000006
    assert float(jump[1]) >= seam_change
    assert float(jump[1]) < seam_change * 1.01


@pytest.mark.skipif(not HAS_KERNELS, reason="download pinned NASA kernels for record reconstruction")
@pytest.mark.parametrize("body", [3, 10, 301, 399])
def test_pinned_spk_type2_records_reconstruct_cspice_states(body):
    motion = module()
    with Ephemeris(RAW):
        et = spice.str2et("2027-06-15 12:34:56 UTC")
        record = motion.read_type2_record(RAW, body, et)
        handle, descriptor, _ = spice.spksfs(body, et, 100)
        frame, expected, center = spice.spkpvn(handle, descriptor, et)
        assert frame == 1 and center == record["center"]
        x = (et - record["midpoint"]) / record["radius"]
        for axis, coefficients in enumerate(record["coefficients"]):
            actual = np.polynomial.chebyshev.chebval(x, coefficients)
            derivative = np.polynomial.chebyshev.chebval(x, np.polynomial.chebyshev.chebder(coefficients)) / record["radius"]
            assert abs(actual - expected[axis]) < 5e-7
            assert abs(derivative - expected[axis + 3]) < 1e-10
        assert len(record["sha256"]) == 64


@pytest.mark.skipif(not HAS_KERNELS, reason="download pinned NASA orientation kernel")
def test_pinned_pck_angles_reconstruct_the_loaded_frame():
    motion = module()
    with Ephemeris(RAW):
        et = spice.str2et("2027-06-15 12:34:56 UTC")
        record = motion.read_type2_record(RAW, 31008, et, kind="pck")
        x = (et - record["midpoint"]) / record["radius"]
        angles = [np.polynomial.chebyshev.chebval(x, axis) for axis in record["coefficients"]]
        expected = spice.pxform("J2000", "MOON_PA_DE440", et)
        np.testing.assert_allclose(spice.eul2m(*angles[::-1], 3, 1, 3), expected, rtol=0, atol=2e-11)


@pytest.mark.skipif(not HAS_KERNELS, reason="download pinned NASA kernels for continuous-model audit")
def test_short_enclosure_crosses_records_and_does_not_claim_physical_validation(monkeypatch):
    motion = module()
    with Ephemeris(RAW):
        middle = spice.str2et("2027-06-15 UTC")
        record = motion.read_type2_record(RAW, 301, middle)
        boundary = record["midpoint"] + record["radius"]
        start = datetime.fromisoformat(spice.et2utc(boundary - 120, "ISOC", 6)).replace(tzinfo=timezone.utc).timestamp()
        end = datetime.fromisoformat(spice.et2utc(boundary + 120, "ISOC", 6)).replace(tzinfo=timezone.utc).timestamp()
        final_et = spice.str2et(datetime.fromtimestamp(end, timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f UTC"))
    calls = []
    original = motion._Type2Model.record

    def record_spy(self, kind, target, time):
        calls.append((kind, target, time))
        return original(self, kind, target, time)

    monkeypatch.setattr(motion._Type2Model, "record", record_spy)
    report = motion.validate_motion_envelope(RAW, start, end)
    # A record reader can choose the next piece at an exact final boundary;
    # evaluate that endpoint itself, not only the preceding open interval.
    assert {(kind, target) for kind, target, time in calls if time == final_et} == {
        ("spk", 3), ("spk", 10), ("spk", 301), ("spk", 399), ("pck", 31008)}
    assert report["status"] == "PASS"
    assert report["formal_verification"] is False
    assert report["physical_model_error_bounded"] is False
    assert report["polynomial_interval_enclosure"] is True
    assert report["coverage"]["status"] == "PASS"
    assert report["seams_checked"] > 0
    assert report["checks"]["primitive_record_spans_exceed_retarded_window"] is True
    assert report["bounds"]["earth_angular_rate_deg_min"] < 0.03
    assert report["bounds"]["sun_angular_rate_deg_min"] < 0.03
    assert report["bounds"]["earth_range_min_km"] > 350_000
    assert report["bounds"]["earth_abs_range_rate_km_s"] < 2
    assert report["bounds"]["sun_light_time_max_s"] < 600
    assert report["bounds"]["earth_light_time_max_s"] < 2
    assert report["bounds"]["angular_seam_and_implementation_allowance_deg"] < 0.00001
    assert report["bounds"]["earth_disc_angular_radius_rate_deg_s"] < 0.000006
    assert report["bounds"]["eclipse_seam_and_implementation_allowance_deg"] < 0.00002
    assert report["rounding"]["precision_decimal_digits"] >= 30
    assert all(len(row["sha256"]) == 64 for row in report["source_records"])
