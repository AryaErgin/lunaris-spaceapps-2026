"""Deterministic physical-scale 3D display meshes from the pinned NASA LOLA DEMs.

Run ``python -m science.scene_terrain``. These decimated surfaces are display
derivatives; the full independently computed skyline remains authoritative.
"""

import argparse
import json
from hashlib import sha256
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

from science.ephemerides import FRAME, enu_basis
from science.sources import ACQUIRED_UTC, FILES, REGIONAL, SHA256, SITES, _sha256
from science.terrain import RADIUS_M, _raster_description, project

LEVELS = ((250., 101), (4000., 129), (32000., 257))


def local_positions(lat, lon, ground, sample_lat, sample_lon, heights):
    """Lunar Cartesian positions to renderer XYZ: east, up, minus north, metres."""
    phi, lam = np.deg2rad(sample_lat), np.deg2rad(sample_lon)
    direction = np.stack((np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam),
                          np.sin(phi)), axis=-1)
    basis = enu_basis(lat, lon)
    difference = direction * (RADIUS_M + np.asarray(heights))[..., None]
    difference -= basis[2] * (RADIUS_M + ground)
    enu = difference @ basis.T
    return np.stack((enu[..., 0], enu[..., 2], -enu[..., 1]), axis=-1)


def _coordinates(site, east, north):
    """Inverse gnomonic grid on the reference sphere, using the site's ENU basis."""
    basis = enu_basis(site["lat"], site["lon"])
    direction = (basis[2] + np.asarray(east)[..., None] / RADIUS_M * basis[0]
                 + np.asarray(north)[..., None] / RADIUS_M * basis[1])
    direction /= np.linalg.norm(direction, axis=-1)[..., None]
    lat = np.rad2deg(np.arctan2(direction[..., 2], np.hypot(direction[..., 0], direction[..., 1])))
    lon = np.rad2deg(np.arctan2(direction[..., 1], direction[..., 0])) % 360
    return lat, lon


class _RasterWindow:
    def __init__(self, dataset, site, extent):
        east, north = np.meshgrid(np.linspace(-extent, extent, 9), np.linspace(-extent, extent, 9))
        x, y = project(*_coordinates(site, east, north))
        col, row = (~dataset.transform) @ (x, y)
        c0 = max(0, int(np.floor(col.min())) - 3)
        r0 = max(0, int(np.floor(row.min())) - 3)
        c1 = min(dataset.width, int(np.ceil(col.max())) + 3)
        r1 = min(dataset.height, int(np.ceil(row.max())) + 3)
        if c1 <= c0 or r1 <= r0:
            raise ValueError("Scene lies outside source terrain")
        data = dataset.read(1, window=Window(c0, r0, c1 - c0, r1 - r0), masked=True)
        self.data = data.data
        self.valid = ~np.ma.getmaskarray(data) & np.isfinite(data.data)
        self.prefix = np.pad((~self.valid).astype(np.int32), ((1, 0), (1, 0))).cumsum(0).cumsum(1)
        self.inverse = ~dataset.transform
        self.offset = c0, r0
        self.shape = data.shape

    def indices(self, lat, lon):
        x, y = project(lat, lon)
        col, row = self.inverse @ (x, y)
        return col - self.offset[0], row - self.offset[1]

    def sample(self, lat, lon):
        col, row = self.indices(lat, lon)
        col, row = np.floor(col).astype(int), np.floor(row).astype(int)
        inside = (col >= 0) & (col < self.shape[1]) & (row >= 0) & (row < self.shape[0])
        clipped_col, clipped_row = np.clip(col, 0, self.shape[1] - 1), np.clip(row, 0, self.shape[0] - 1)
        valid = inside & self.valid[clipped_row, clipped_col]
        return np.where(valid, self.data[clipped_row, clipped_col], np.nan), valid

    def cells_valid(self, lat, lon):
        col, row = self.indices(lat, lon)
        # All native cells in the enclosing projected rectangle must exist.
        # An extra native-cell halo conservatively covers curved edge extrema.
        c0, r0 = np.floor(col.min(-1)).astype(int) - 1, np.floor(row.min(-1)).astype(int) - 1
        c1, r1 = np.floor(col.max(-1)).astype(int) + 2, np.floor(row.max(-1)).astype(int) + 2
        inside = (c0 >= 0) & (r0 >= 0) & (c1 <= self.shape[1]) & (r1 <= self.shape[0])
        c0, c1 = np.clip(c0, 0, self.shape[1]), np.clip(c1, 0, self.shape[1])
        r0, r1 = np.clip(r0, 0, self.shape[0]), np.clip(r1, 0, self.shape[0])
        missing = self.prefix[r1, c1] - self.prefix[r0, c1] - self.prefix[r1, c0] + self.prefix[r0, c0]
        return inside & (missing == 0)


class TerrainSampler:
    """Nearest native-cell radial heights; gaps are retained, never filled."""

    def __init__(self, local, regional, site, *, local_half_extent_m=4000., outer_half_extent_m=32000.):
        self.site = site
        self.local_half_extent_m = local_half_extent_m
        self.local = _RasterWindow(local, site, local_half_extent_m)
        self.regional = _RasterWindow(regional, site, outer_half_extent_m)

    def sample(self, east, north):
        east, north = np.broadcast_arrays(np.asarray(east), np.asarray(north))
        lat, lon = _coordinates(self.site, east, north)
        local = (np.abs(east) <= self.local_half_extent_m + 1e-8) & (np.abs(north) <= self.local_half_extent_m + 1e-8)
        heights = np.full(east.shape, np.nan)
        valid = np.zeros(east.shape, dtype=bool)
        for selected, source in ((local, self.local), (~local, self.regional)):
            if selected.any():
                heights[selected], valid[selected] = source.sample(lat[selected], lon[selected])
        return heights, valid

    def cells_valid(self, east, north, *, local):
        lat, lon = _coordinates(self.site, east, north)
        return (self.local if local else self.regional).cells_valid(lat, lon)


def build_mesh(site, sampler, *, levels=LEVELS):
    """Nested square grids with fine-edge vertices stitched into coarse cells.

    A transition cell is a fan about one genuine sampled center. It incorporates
    every finer boundary vertex, eliminating cracks and overlapping annuli.
    """
    coords, heights, vertex_valid, lookup, indices, chunks = [], [], [], {}, [], []
    missing_count = 0

    def add_points(points):
        fresh = []
        for point in points:
            key = tuple(map(float, point))
            if key not in lookup:
                lookup[key] = len(coords) + len(fresh)
                fresh.append(key)
        if fresh:
            points_array = np.asarray(fresh)
            sample_height, valid = sampler.sample(points_array[:, 0], points_array[:, 1])
            coords.extend(fresh)
            heights.extend(sample_height.tolist())
            vertex_valid.extend(valid.tolist())
        return [lookup[tuple(map(float, point))] for point in points]

    previous_extent, previous_axis = None, None
    for level, (extent, size) in enumerate(levels):
        if size < 3 or size % 2 != 1 or (previous_extent is not None and extent <= previous_extent):
            raise ValueError("Scene levels require increasing extents and odd grid sizes")
        axis = np.linspace(-extent, extent, size)
        if previous_extent is not None and not np.any(np.isclose(axis, previous_extent, atol=1e-8)):
            raise ValueError("Inner boundary must align with the outer grid")
        east, north = np.meshgrid(axis, axis)
        grid = np.asarray(add_points(np.column_stack((east.ravel(), north.ravel())))).reshape(size, size)
        cells = np.stack((grid[:-1, :-1], grid[:-1, 1:], grid[1:, 1:], grid[1:, :-1]), axis=-1)
        cell_e = np.stack((east[:-1, :-1], east[:-1, 1:], east[1:, 1:], east[1:, :-1]), axis=-1)
        cell_n = np.stack((north[:-1, :-1], north[:-1, 1:], north[1:, 1:], north[1:, :-1]), axis=-1)
        inside_hole = np.zeros(cells.shape[:-1], dtype=bool)
        if previous_extent is not None:
            inside_hole = (np.max(np.abs(cell_e), axis=-1) <= previous_extent + 1e-8) & (np.max(np.abs(cell_n), axis=-1) <= previous_extent + 1e-8)
        valid_cells = sampler.cells_valid(cell_e, cell_n, local=extent <= sampler.local_half_extent_m)
        start = len(indices)
        for row, col in np.argwhere(~inside_hole):
            if not valid_cells[row, col]:
                missing_count += 1
                continue
            corners = cells[row, col].tolist()
            polygon = []
            transition = False
            for a, b in zip(corners, corners[1:] + corners[:1], strict=True):
                polygon.append(a)
                if previous_extent is None:
                    continue
                pa, pb = np.array(coords[a]), np.array(coords[b])
                for fixed_axis in (0, 1):
                    moving_axis = 1 - fixed_axis
                    if (abs(pa[fixed_axis] - pb[fixed_axis]) < 1e-8
                            and abs(abs(pa[fixed_axis]) - previous_extent) < 1e-8
                            and max(abs(pa[moving_axis]), abs(pb[moving_axis])) <= previous_extent + 1e-8):
                        low, high = sorted((pa[moving_axis], pb[moving_axis]))
                        intermediate = previous_axis[(previous_axis > low + 1e-8) & (previous_axis < high - 1e-8)]
                        if pb[moving_axis] < pa[moving_axis]:
                            intermediate = intermediate[::-1]
                        for value in intermediate:
                            point = pa.copy()
                            point[moving_axis] = value
                            polygon.append(lookup[tuple(point)])
                        transition |= bool(len(intermediate))
                        break
            if not all(vertex_valid[index] for index in polygon):
                missing_count += 1
                continue
            if transition:
                center = np.asarray([coords[index] for index in corners]).mean(0)
                center_index = add_points([center])[0]
                if not vertex_valid[center_index]:
                    missing_count += 1
                    continue
                for a, b in zip(polygon, polygon[1:] + polygon[:1], strict=True):
                    indices.extend((center_index, a, b))
            else:
                indices.extend((corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]))
        chunks.append({"name": ("native-core", "local-relief", "regional-relief")[min(level, 2)],
                       "indexOffset": start, "indexCount": len(indices) - start,
                       "outerHalfExtentM": extent, "innerHalfExtentM": previous_extent or 0,
                       "gridSize": size, "nominalGridSpacingM": 2 * extent / (size - 1),
                       "nativeSourceSpacingM": 5 if extent <= sampler.local_half_extent_m else 80})
        previous_extent, previous_axis = extent, axis
    coords_array = np.asarray(coords)
    lat, lon = _coordinates(site, coords_array[:, 0], coords_array[:, 1])
    # Invalid vertices are unreferenced. Remove them instead of serializing NaNs.
    indices_array = np.asarray(indices, dtype=np.uint32)
    used = np.unique(indices_array)
    remap = np.zeros(len(coords), dtype=np.uint32)
    remap[used] = np.arange(len(used), dtype=np.uint32)
    positions = local_positions(site["lat"], site["lon"], site["groundM"], lat[used], lon[used], np.asarray(heights)[used])
    return {"positions": positions, "indices": remap[indices_array], "chunks": chunks,
            "gridCoordinatesM": coords_array[used], "missingCellCount": missing_count,
            "elevationRangeM": [float(np.min(np.asarray(heights)[used])), float(np.max(np.asarray(heights)[used]))]}


def encode_mesh(positions, indices):
    positions = np.asarray(positions, dtype="<f4")
    indices = np.asarray(indices, dtype="<u4").ravel()
    if positions.ndim != 2 or positions.shape[1] != 3 or not np.isfinite(positions).all():
        raise ValueError("Expected finite XYZ positions")
    if len(indices) % 3 or (len(indices) and indices.max() >= len(positions)):
        raise ValueError("Invalid mesh triangle indices")
    payload = positions.tobytes() + indices.tobytes()
    return payload, {"vertexCount": len(positions), "indexCount": len(indices),
                     "positionsByteOffset": 0, "indicesByteOffset": positions.nbytes,
                     "byteLength": len(payload), "sha256": sha256(payload).hexdigest()}


def build_scenes(raw, bundle_path, output):
    raw, output = Path(raw), Path(output)
    bundle_bytes = Path(bundle_path).read_bytes()
    bundle = json.loads(bundle_bytes)
    sites = {site["id"]: site for site in bundle["sites"]}
    source_metadata = []
    for filename in (REGIONAL, *(f"{row[5]}_final_adj_5mpp_surf.tif" for row in SITES)):
        path = raw / filename
        digest = _sha256(path)
        if digest != SHA256[filename]:
            raise ValueError(f"NASA DEM SHA-256 differs from pin: {filename}")
        with rasterio.open(path) as dataset:
            raster = _raster_description(dataset)
        url, expected_bytes, citation = FILES[filename]
        source_metadata.append({"filename": filename, "sha256": digest, "bytes": path.stat().st_size,
                                "expectedBytes": expected_bytes, "url": url, "citation": citation,
                                "acquiredUtc": ACQUIRED_UTC[filename], "raster": raster})
    output.mkdir(parents=True, exist_ok=True)
    metadata = {"version": "1.0.0", "kind": "Physical-scale NASA LOLA display meshes",
                "binaryFormat": "little-endian contiguous Float32 XYZ, followed by Uint32 triangle indices",
                "frame": FRAME, "radiusM": RADIUS_M,
                "coordinateConvention": "x=eastM, y=radialUpM above exact bundle ground, z=-northM; right handed",
                "verticalDatum": "NASA radial metres above the 1737400 m sphere; origin at exact study point ground",
                "verticalExaggeration": 1, "metresPerUnit": 1,
                "gridProjection": "Inverse gnomonic directions from local east/north reference-sphere tangent coordinates",
                "bundleSha256": sha256(bundle_bytes).hexdigest(), "sources": source_metadata, "sites": [],
                "reduction": "Nearest native DEM cell at each vertex; triangulated multiresolution grids. Every enclosed native gap masks the containing display cell with a conservative one-cell halo. Fine grid boundaries are stitched into coarse-cell fans about genuine sampled centers.",
                "limits": ["Display mesh is not the mission horizon or a validated shadow-volume solution; computed visibility remains authoritative.",
                           "Native 5 m local DEM is displayed at 5 m within +/-250 m, 62.5 m to +/-4 km; native 80 m regional terrain at 250 m to +/-32 km. Decimation can omit narrow ridges; nominal pixel spacing is not effective resolution.",
                           "Displayed square extends 32 km along cardinal tangent axes (about 45 km to corners); horizon calculations use much greater extent. Distant blockers and sub-grid relief may be absent.",
                           "Missing terrain is omitted as holes, including any potentially missing native contributor; missing regions never become flat ground.",
                           "Nearest-cell heights and linear display triangles approximate the cell-constant scientific terrain model; no vertical exaggeration or procedural craters.",
                           "Study points are published region centers, not approved landing locations. This visual makes no landing safety, power or communication reliability claim."],
                "reproduce": "python -m science.scene_terrain --raw data/raw --bundle web/data/bundle.json --output web/data",
                "aiUse": "OpenAI Codex assisted implementation, tests and writing under sole human entrant Arya Ergin. Mesh vertices are deterministic NASA DEM derivatives, not generative artwork."}
    with rasterio.open(raw / REGIONAL) as regional:
        for site_id, _, _, expected_lat, expected_lon, tile in SITES:
            site = sites[site_id]
            if site["lat"] != expected_lat or site["lon"] != expected_lon:
                raise ValueError(f"Bundle coordinates differ from exact study-point pin: {site_id}")
            with rasterio.open(raw / f"{tile}_final_adj_5mpp_surf.tif") as local:
                sampler = TerrainSampler(local, regional, site)
                ground, valid = sampler.sample(np.array([0.]), np.array([0.]))
                if not valid[0] or float(ground[0]) != site["groundM"]:
                    raise ValueError(f"Bundle ground anchor differs from native local DEM: {site_id}")
                mesh = build_mesh(site, sampler)
            payload, encoding = encode_mesh(mesh["positions"], mesh["indices"])
            filename = f"terrain-{site_id}.bin"
            (output / filename).write_bytes(payload)
            metadata["sites"].append({"siteId": site_id, "positionFile": filename, **encoding,
                                      "lat": site["lat"], "lon": site["lon"], "groundM": site["groundM"],
                                      "heightM": site["heightM"], "chunks": mesh["chunks"],
                                      "missingCellCount": mesh["missingCellCount"],
                                      "elevationRangeM": mesh["elevationRangeM"],
                                      "boundsM": [mesh["positions"].min(0).tolist(), mesh["positions"].max(0).tolist()]})
    (output / "terrain-scenes.json").write_text(json.dumps(metadata, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=Path("data/raw"))
    parser.add_argument("--bundle", type=Path, default=Path("web/data/bundle.json"))
    parser.add_argument("--output", type=Path, default=Path("web/data"))
    args = parser.parse_args()
    result = build_scenes(args.raw, args.bundle, args.output)
    print(json.dumps([{key: site[key] for key in ("siteId", "vertexCount", "indexCount", "byteLength", "sha256", "missingCellCount")} for site in result["sites"]]))


if __name__ == "__main__":
    main()
