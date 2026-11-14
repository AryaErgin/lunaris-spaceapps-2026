"""Atlas reduction must preserve lunar placement and explicit missing data."""

import importlib
import importlib.util
import struct
import zlib

import numpy as np
import rasterio
from affine import Affine
from rasterio.io import MemoryFile

from science.terrain import STEREO


def atlas_module():
    assert importlib.util.find_spec("science.atlas") is not None, "DEM atlas builder is missing"
    return importlib.import_module("science.atlas")


def test_reduction_retains_missing_contributor_instead_of_averaging_it_away():
    atlas = atlas_module()
    values = np.arange(16, dtype=np.float32).reshape(4, 4)
    values[0, 0] = -9999
    with MemoryFile() as memory:
        with memory.open(driver="GTiff", width=4, height=4, count=1, dtype="float32",
                         transform=Affine(80, 0, -160, 0, -80, 160),
                         crs=STEREO.to_wkt(), nodata=-9999) as dataset:
            dataset.write(values, 1)
            reduced = atlas.reduce_dem(dataset, (-160, -160, 160, 160), 2)
    assert reduced["boundsM"] == [-160, -160, 160, 160]
    assert reduced["valid"].tolist() == [[False, True], [True, True]]
    assert reduced["elevationM"][1, 1] == 12.5
    assert reduced["spacingM"] == [160, 160]


def test_terrain_image_is_deterministic_and_never_colors_missing_pixels():
    atlas = atlas_module()
    heights = np.array([[2, 3, 4], [3, 4, 5], [4, 5, 6]], dtype=float)
    valid = np.ones((3, 3), dtype=bool)
    valid[0, 0] = False
    rgba = atlas.shaded_relief(heights, valid, (80, 80))
    assert rgba.shape == (3, 3, 4)
    assert rgba[0, 0, 3] == 0
    assert rgba[2, 2, 3] == 255
    image = atlas.png_bytes(rgba)
    assert image == atlas.png_bytes(rgba)
    assert image[:8] == b"\x89PNG\r\n\x1a\n"
    width, height = struct.unpack(">II", image[16:24])
    assert (width, height) == (3, 3)
    assert zlib.decompress(image[41:-16])[0] == 0


def test_missing_runs_include_edge_gaps_without_inventing_valid_coverage():
    atlas = atlas_module()
    valid = np.array([[False, False, True], [True, False, True]], dtype=bool)
    assert atlas.missing_runs(valid) == [[0, 2], [4, 1]]


def test_crop_must_stay_within_actual_dem_bounds():
    atlas = atlas_module()
    with MemoryFile() as memory:
        with memory.open(driver="GTiff", width=4, height=4, count=1, dtype="float32",
                         transform=Affine(80, 0, -160, 0, -80, 160),
                         crs=STEREO.to_wkt()) as dataset:
            dataset.write(np.ones((4, 4), dtype=np.float32), 1)
            import pytest
            with pytest.raises(ValueError, match="outside"):
                atlas.reduce_dem(dataset, (-200, -160, 160, 160), 2)
