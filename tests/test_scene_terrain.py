"""Display mesh must preserve physical ENU geometry and missing NASA terrain."""

import importlib
import importlib.util
from hashlib import sha256

import numpy as np
import pytest
from affine import Affine
from rasterio.io import MemoryFile

from science.terrain import RADIUS_M, STEREO


def module():
    assert importlib.util.find_spec("science.scene_terrain") is not None, "3D DEM mesh builder is missing"
    return importlib.import_module("science.scene_terrain")


def raster(memory, values, spacing):
    size = len(values)
    dataset = memory.open(driver="GTiff", width=size, height=size, count=1,
                          dtype="float32", crs=STEREO.to_wkt(), nodata=-9999,
                          transform=Affine(spacing, 0, -size * spacing / 2,
                                           0, -spacing, size * spacing / 2))
    dataset.write(np.asarray(values, dtype=np.float32), 1)
    return dataset


SITE = {"id": "test", "lat": -90., "lon": 0., "groundM": 100., "heightM": 2.}


def test_cardinal_local_positions_have_renderer_axes_and_exact_ground_anchor():
    terrain = module()
    # At the equator: longitude is east, latitude is north, radial height is up.
    positions = terrain.local_positions(0., 0., 100., [0., 0., 0.001],
                                        [0., 0.001, 0.], [100., 103., 100.])
    assert np.allclose(positions[0], [0., 0., 0.], atol=1e-9)
    assert positions[1, 0] > 30 and positions[1, 2] == 0
    assert positions[2, 2] < -30 and positions[2, 0] == 0
    assert positions[1, 1] == pytest.approx(2.99973536, abs=1e-7)


def test_curvature_is_not_flattened_or_vertically_exaggerated():
    terrain = module()
    # Quarter-circle direction has zero local north and radial drop of one R.
    actual = terrain.local_positions(0., 0., 0., [0.], [90.], [0.])[0]
    assert actual == pytest.approx([RADIUS_M, -RADIUS_M, 0.], abs=1e-8)
    raised = terrain.local_positions(0., 0., 100., [0.], [0.], [107.])[0]
    assert raised == pytest.approx([0., 7., 0.], abs=1e-9)


def test_nested_mesh_stitches_shared_boundary_without_overlapping_triangles():
    terrain = module()
    with (MemoryFile() as local_mem, MemoryFile() as far_mem,
          raster(local_mem, np.full((32, 32), 100.), 5) as local,
          raster(far_mem, np.full((32, 32), 100.), 10) as regional):
        sampler = terrain.TerrainSampler(local, regional, SITE, local_half_extent_m=10.)
        mesh = terrain.build_mesh(SITE, sampler, levels=((10., 5), (30., 7)))
    positions, indices = mesh["positions"], mesh["indices"].reshape(-1, 3)
    assert np.isfinite(positions).all()
    assert indices.min() >= 0 and indices.max() < len(positions)
    assert mesh["missingCellCount"] == 0
    # Every non-exterior edge belongs to exactly two triangles, including seams.
    counts = {}
    for triangle in indices:
        for a, b in zip(triangle, np.roll(triangle, -1), strict=True):
            edge = tuple(sorted((int(a), int(b))))
            counts[edge] = counts.get(edge, 0) + 1
        a, b, c = positions[triangle]
        assert np.cross(b - a, c - a)[1] > 0
    open_edges = [edge for edge, count in counts.items() if count == 1]
    assert open_edges
    for a, b in open_edges:
        # The only open edges lie on the +/-30 m outside boundary.
        points = mesh["gridCoordinatesM"][[a, b]]
        assert any(np.allclose(points[:, axis], sign * 30.)
                   for axis in (0, 1) for sign in (-1, 1))
    assert max(counts.values()) == 2


def test_missing_native_cell_removes_display_triangles_even_between_vertices():
    terrain = module()
    values = np.full((32, 32), 100., dtype=np.float32)
    # This 5 m cell is strictly between the display's 10 m vertices.
    values[12, 18] = -9999
    with (MemoryFile() as local_mem, MemoryFile() as far_mem,
          raster(local_mem, values, 5) as local,
          raster(far_mem, np.full((32, 32), 100.), 10) as regional):
        sampler = terrain.TerrainSampler(local, regional, SITE, local_half_extent_m=30.)
        mesh = terrain.build_mesh(SITE, sampler, levels=((30., 7),))
    assert mesh["missingCellCount"] >= 1
    assert len(mesh["indices"]) < 6 * 36
    assert np.isfinite(mesh["positions"]).all()


def test_binary_layout_roundtrips_and_hash_detects_mutation():
    terrain = module()
    positions = np.array([[1., 2., -3.], [4., 5., -6.], [7., 8., -9.]], dtype=float)
    indices = np.array([0, 2, 1])
    payload, description = terrain.encode_mesh(positions, indices)
    assert description["positionsByteOffset"] == 0
    assert description["indicesByteOffset"] == 36
    assert description["indexCount"] == 3
    assert len(payload) == 48
    assert np.array_equal(np.frombuffer(payload, dtype="<f4", count=9).reshape(-1, 3), positions)
    assert np.array_equal(np.frombuffer(payload, dtype="<u4", offset=36), indices)
    assert description["sha256"] == sha256(payload).hexdigest()
    assert payload == terrain.encode_mesh(positions, indices)[0]
    changed = bytearray(payload)
    changed[0] ^= 1
    assert sha256(changed).hexdigest() != description["sha256"]
