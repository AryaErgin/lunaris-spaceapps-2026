"""Independent state/rate and coverage checks for the experimental date domain."""

import importlib
import importlib.util
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest
import spiceypy as spice

from science.ephemerides import CORRECTION, FILES, FRAME, Ephemeris, enu_basis

RAW = Path("data/raw")
HAS_KERNELS = all((RAW / filename).is_file() for filename in FILES)


def epoch(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def domain_module():
    assert importlib.util.find_spec("science.domain_validation"), "A reproducible sampled-domain auditor is required"
    return importlib.import_module("science.domain_validation")


@pytest.mark.skipif(not HAS_KERNELS, reason="download pinned NASA kernels for the state integration check")
def test_states_preserve_original_position_bits_and_match_finite_difference_velocity():
    assert callable(getattr(Ephemeris, "states", None)), "Expose the full existing apparent SPICE state"
    lat, lon, radius = -88.6834, 292.0679, 1_739_195.7939453125
    dates = [epoch("2026-11-01T06:00:00Z"), epoch("2027-06-15T12:00:00Z"), epoch("2027-12-31T23:00:00Z")]
    basis = enu_basis(lat, lon)
    with Ephemeris(RAW) as ephemeris:
        states = ephemeris.states(lat, lon, radius, dates)
        vectors = ephemeris.vectors(lat, lon, radius, dates)
        before = ephemeris.vectors(lat, lon, radius, np.asarray(dates) - 1)
        after = ephemeris.vectors(lat, lon, radius, np.asarray(dates) + 1)
        ets = spice.str2et([datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f UTC") for t in dates])
        for index, target in enumerate(("10", "399")):
            # This is the exact pre-expansion implementation, independently rebuilt.
            old = np.array([spice.spkcpo(target, et, FRAME, "OBSERVER", CORRECTION,
                                        basis[2] * (radius / 1000), "MOON", FRAME)[0][:3] for et in ets]) @ basis.T
            assert states[index].shape == (3, 6)
            np.testing.assert_array_equal(states[index][:, :3], old)
            np.testing.assert_array_equal(vectors[index], old)
            numerical_velocity = (after[index] - before[index]) / 2
            np.testing.assert_allclose(states[index][:, 3:], numerical_velocity, rtol=1e-7, atol=1e-5)


@pytest.mark.skipif(not HAS_KERNELS, reason="download pinned NASA kernels for input and coverage checks")
def test_state_shapes_context_and_reception_coverage_guards():
    assert callable(getattr(Ephemeris, "states", None))
    assert callable(getattr(Ephemeris, "assert_coverage", None))
    unopened = Ephemeris(RAW)
    with pytest.raises(RuntimeError, match="context"):
        unopened.states(-89, 1, 1_737_402, [])
    with Ephemeris(RAW) as ephemeris:
        assert [state.shape for state in ephemeris.states(-89, 1, 1_737_402, [])] == [(0, 6), (0, 6)]
        for bad in ([float("nan")], [[1, 2]], [float("inf")]):
            with pytest.raises(ValueError, match="one-dimensional"):
                ephemeris.states(-89, 1, 1_737_402, bad)
        with pytest.raises(ValueError, match="radius"):
            ephemeris.states(-89, 1, 0, [0])
        result = ephemeris.assert_coverage(epoch("2026-11-01T00:00:00Z"), epoch("2028-01-01T00:00:00Z"))
        assert result["status"] == "PASS"
        assert result["light_time_margin_s"] == 600
        with pytest.raises(ValueError, match="coverage"):
            ephemeris.assert_coverage(epoch("2151-01-01T00:00:00Z"), epoch("2151-02-01T00:00:00Z"))
        first = ephemeris.coverage()["spk"]["10"][0]["start_utc"]
        # The requested epochs themselves fit, but the target's retarded epoch does not.
        with pytest.raises(ValueError, match="coverage"):
            ephemeris.assert_coverage(epoch(first) + 300, epoch(first) + 400)
        with pytest.raises(ValueError, match="positive"):
            ephemeris.assert_coverage(1, 0)
        with pytest.raises(ValueError, match="light-time"):
            ephemeris.assert_coverage(0, 1, light_time_margin_s=0)


def test_rate_summary_matches_an_analytic_circular_motion_and_radial_velocity():
    domain = domain_module()
    radius, angular_rate = 360_000.0, 0.00002
    states = np.array([[radius, 0, 0, 0.4, radius * angular_rate, 0],
                       [0, radius, 0, -radius * angular_rate, -0.2, 0]])
    summary = domain.summarize_states(states, [0, 30])
    assert summary["sample_count"] == 2
    assert summary["max_angular_rate_deg_min"] == pytest.approx(angular_rate * 180 / np.pi * 60)
    assert summary["min_range_km"] == radius
    assert summary["max_abs_range_rate_km_s"] == 0.4
    with pytest.raises(ValueError, match="finite"):
        domain.summarize_states(np.full((2, 6), np.nan), [0, 30])
    with pytest.raises(ValueError, match="positive"):
        domain.summarize_states(np.zeros((1, 6)), [0])


def test_interlaced_grid_covers_the_partial_final_interval_without_extrapolating():
    domain = domain_module()
    coarse = [time for batch in domain._batches(0, 130, 60, 2) for time in batch]
    extra = [time for batch in domain._batches(0, 130, 60, 2, interlaced=True) for time in batch]
    assert coarse == [0, 60, 120, 130]
    assert extra == [30, 90, 125]
    combined = sorted(coarse + extra)
    assert max(np.diff(combined)) <= 30
    assert combined[0] == 0 and combined[-1] == 130


@pytest.mark.skipif(not HAS_KERNELS, reason="download pinned NASA kernels for the short reproducibility audit")
def test_short_domain_audit_is_explicitly_sampled_and_interlaced():
    domain = domain_module()
    start = epoch("2027-01-01T00:00:00Z")
    report = domain.audit_domain(RAW, [("de-gerlache-rim", -88.6834, 292.0679, 1_739_195.7939453125)],
                                 start, start + 180, cadence_seconds=60, interlaced=True, batch_size=2)
    assert report["status"] == "PASS"
    assert report["sampled_only"] is True
    assert report["between_sample_bound_proven"] is False
    assert report["coverage"]["status"] == "PASS"
    assert report["interlaced_check"]["performed"] is True
    assert report["interlaced_check"]["within_declared_tolerance"] is True
    assert len(report["kernels"]) == 4
    assert all(len(row["sha256"]) == 64 for row in report["kernels"])
    assert report["sites"][0]["sun"]["sample_count"] == 7
    assert report["sites"][0]["earth"]["min_range_km"] > 350_000
    with pytest.raises(ValueError, match="distinct"):
        domain.audit_domain(RAW, [("x", -89, 1, 1_737_402)] * 2, start, start + 120)
    with pytest.raises(ValueError, match="cadence"):
        domain.audit_domain(RAW, [("x", -89, 1, 1_737_402)], start, start + 120, cadence_seconds=0)
    with pytest.raises(ValueError, match="site"):
        domain.audit_domain(RAW, [()], start, start + 120)
