"""Local ground slope uses physical ENU differences and never fills gaps."""

import importlib
import importlib.util

import numpy as np
import pytest


def test_central_ground_gradient_preserves_axes_physical_units_and_missing_data():
    assert importlib.util.find_spec("science.rendering_notes") is not None, "Rendering evidence builder is missing"
    notes = importlib.import_module("science.rendering_notes")
    east, north = np.meshgrid([-5., 0., 5.], [5., 0., -5.])
    # Hand-derived physical plane: rise/run = hypot(0.6,0.8) = 1 -> 45 degrees.
    positions = np.stack((east, 1000 + .6 * east + .8 * north, -north), axis=-1)
    valid = np.ones((3, 3), dtype=bool)
    result = notes.central_difference_slope(positions, valid)
    assert result["status"] == "COMPUTED"
    assert result["slopeDeg"] == pytest.approx(45., abs=1e-10)
    assert result["gradientEast"] == pytest.approx(.6, abs=1e-10)
    assert result["gradientNorth"] == pytest.approx(.8, abs=1e-10)
    # Diagonal cells do not contribute to the documented cross stencil.
    valid[0, 0] = False
    assert notes.central_difference_slope(positions, valid)["slopeDeg"] == pytest.approx(45.)
    valid[0, 1] = False
    missing = notes.central_difference_slope(positions, valid)
    assert missing["status"] == "INDETERMINATE"
    assert missing["slopeDeg"] is None
