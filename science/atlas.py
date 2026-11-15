"""Reproducible display-only relief from the pinned NASA LOLA regional DEM.

This derivative never enters the skyline, visibility or mission calculation.
Run ``python -m science.atlas`` after acquiring the existing regional source.
"""

import argparse
import json
import struct
import zlib
from hashlib import sha256
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

from science.sources import ACQUIRED_UTC, FILES, REGIONAL, SHA256, _sha256
from science.terrain import RADIUS_M, _raster_description


def reduce_dem(dataset, bounds, size):
    """Average a native-pixel-aligned crop, retaining every missing contributor."""
    left, bottom, right, top = map(float, bounds)
    actual = dataset.bounds
    if (left < actual.left or bottom < actual.bottom or right > actual.right
            or top > actual.top or left >= right or bottom >= top):
        raise ValueError("Atlas crop is outside the actual DEM bounds or empty")
    if not isinstance(size, int) or size < 2:
        raise ValueError("Atlas size must be an integer of at least two pixels")
    window = from_bounds(left, bottom, right, top, transform=dataset.transform)
    components = (window.col_off, window.row_off, window.width, window.height)
    if any(abs(value - round(value)) > 1e-7 for value in components):
        raise ValueError("Atlas bounds must align with native DEM pixels")
    window = window.round_offsets().round_lengths()
    elevation = dataset.read(1, window=window, out_shape=(size, size),
                             resampling=Resampling.average)
    # read_masks cannot use GDAL's warp-only minimum resampler. Count every
    # intersecting native invalid cell explicitly, including partial overlaps.
    native = dataset.read(1, window=window, masked=True)
    invalid = np.ma.getmaskarray(native) | ~np.isfinite(native.data)
    prefix = np.pad(invalid.astype(np.int64), ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    row_edges = np.arange(size + 1) * window.height / size
    col_edges = np.arange(size + 1) * window.width / size
    r0, r1 = np.floor(row_edges[:-1]).astype(int), np.ceil(row_edges[1:]).astype(int)
    c0, c1 = np.floor(col_edges[:-1]).astype(int), np.ceil(col_edges[1:]).astype(int)
    missing = (prefix[r1[:, None], c1[None, :]] - prefix[r0[:, None], c1[None, :]]
               - prefix[r1[:, None], c0[None, :]] + prefix[r0[:, None], c0[None, :]])
    valid = (missing == 0) & np.isfinite(elevation)
    elevation = elevation.astype(float)
    elevation[~valid] = np.nan
    return {"elevationM": elevation, "valid": valid,
            "boundsM": [left, bottom, right, top],
            "spacingM": [(right - left) / size, (top - bottom) / size],
            "nativeWindow": [int(value) for value in components]}


def shaded_relief(elevation, valid, spacing):
    """Synthetic map light (315 degrees / 45 degrees), never actual sunlight."""
    valid = np.asarray(valid, dtype=bool) & np.isfinite(elevation)
    if not valid.any():
        return np.zeros((*elevation.shape, 4), dtype=np.uint8)
    clean = np.where(valid, elevation, np.median(elevation[valid]))
    slope_row, slope_x = np.gradient(clean, spacing[1], spacing[0])
    slope_y = -slope_row  # image rows increase toward decreasing northing
    light = np.array([-0.5, 0.5, np.sqrt(0.5)])
    intensity = (-slope_x * light[0] - slope_y * light[1] + light[2])
    intensity /= np.sqrt(1 + slope_x ** 2 + slope_y ** 2)
    intensity = 0.36 + 0.64 * np.clip(intensity, 0, 1)
    # Do not let an invented gap fill produce an artificial cliff in the image.
    neighbors = valid.copy()
    neighbors[1:, :] &= valid[:-1, :]
    neighbors[:-1, :] &= valid[1:, :]
    neighbors[:, 1:] &= valid[:, :-1]
    neighbors[:, :-1] &= valid[:, 1:]
    intensity[~neighbors] = 0.72
    low, high = np.percentile(elevation[valid], [2, 98])
    level = np.clip((clean - low) / max(1, high - low), 0, 1)
    stops = [0., 0.5, 1.]
    colors = np.array([[33, 49, 63], [133, 153, 158], [225, 231, 224]])
    rgb = np.stack([np.interp(level, stops, colors[:, i]) for i in range(3)], axis=-1)
    rgba = np.zeros((*elevation.shape, 4), dtype=np.uint8)
    rgba[..., :3] = np.rint(rgb * intensity[..., None]).astype(np.uint8)
    rgba[..., 3] = valid.astype(np.uint8) * 255
    rgba[~valid, :3] = 0
    return rgba


def png_bytes(rgba):
    """Small deterministic RGBA PNG without an additional image dependency."""
    height, width, channels = rgba.shape
    if channels != 4 or rgba.dtype != np.uint8:
        raise ValueError("Expected an unsigned 8-bit RGBA image")

    def chunk(kind, content):
        return (struct.pack(">I", len(content)) + kind + content
                + struct.pack(">I", zlib.crc32(kind + content) & 0xffffffff))

    scanlines = b"".join(b"\0" + row.tobytes() for row in rgba)
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(scanlines, 9)) + chunk(b"IEND", b""))


def missing_runs(valid):
    """Compact row-major missing-cell runs for offline coordinate inspection."""
    missing = ~np.asarray(valid, dtype=bool).ravel()
    padded = np.concatenate(([False], missing, [False])).astype(np.int8)
    changes = np.diff(padded)
    return [[int(start), int(end - start)] for start, end
            in zip(np.flatnonzero(changes == 1), np.flatnonzero(changes == -1), strict=True)]


def build_atlas(raw, output, *, size=640, bounds=(-64000, -64000, 64000, 64000)):
    source = Path(raw) / REGIONAL
    digest = _sha256(source)
    if digest != SHA256[REGIONAL]:
        raise ValueError("Regional DEM SHA-256 differs from the pinned NASA source")
    with rasterio.open(source) as dataset:
        source_raster = _raster_description(dataset)
        reduced = reduce_dem(dataset, bounds, size)
    valid, elevation = reduced["valid"], reduced["elevationM"]
    pixels = shaded_relief(elevation, valid, reduced["spacingM"])
    image = png_bytes(pixels)
    url, byte_count, citation = FILES[REGIONAL]
    metadata = {
        "version": "1.0.0",
        "kind": "NASA LOLA DEM display derivative; independent of mission calculations",
        "source": {"filename": REGIONAL, "url": url, "citation": citation,
                   "sha256": digest, "bytes": source.stat().st_size,
                   "expectedBytes": byte_count, "acquiredUtc": ACQUIRED_UTC[REGIONAL],
                   "raster": source_raster},
        "projection": {"name": "Lunar south polar stereographic", "radiusM": RADIUS_M,
                       "latitudeOriginDeg": -90, "longitudeOriginDegE": 0,
                       "scaleAtPole": 1, "falseEastingM": 0, "falseNorthingM": 0,
                       "frame": "DE421 mean Earth / polar axis (ME)",
                       "latitudeConvention": "planetocentric degrees north",
                       "longitudeConvention": "east-positive; normalized to [0,360)",
                       "mapOrientation": "0 E up; 90 E right; 180 E down; 270 E left",
                       "verticalDatum": "radial metres above the 1,737,400 m reference sphere"},
        "display": {"image": "terrain-atlas.png", "sha256": sha256(image).hexdigest(),
                    "width": size, "height": size, "boundsM": reduced["boundsM"],
                    "spacingM": reduced["spacingM"], "nativeWindow": reduced["nativeWindow"],
                    "nativePixelsPerDisplayPixel": [reduced["nativeWindow"][2] / size,
                                                     reduced["nativeWindow"][3] / size],
                    "reduction": "GDAL area-weighted average; any contributing masked native pixel masks the output pixel",
                    "validPixels": int(valid.sum()), "missingPixels": int((~valid).sum()),
                    "noDataRuns": missing_runs(valid),
                    "missingEncoding": "[startIndex,length], row-major, zero-based; transparent PNG pixels",
                    "elevationRangeM": [float(elevation[valid].min()), float(elevation[valid].max())]
                    if valid.any() else None,
                    "colorStretchPercentiles": [2, 98],
                    "syntheticLight": {"mapAzimuthDegClockwiseFromUp": 315, "elevationDeg": 45}},
        "limits": [
            "Relief shading uses an artificial fixed map light, not Sun geometry or actual lunar illumination.",
            "This reduced 200 m display is not used to compute any horizon, visibility interval or mission decision.",
            "A valid display cell establishes only valid source pixels in this reduced map; it is not a terrain-aware calculation at that coordinate.",
            "Only exact cached study points have terrain-aware mission calculations; other coordinates support level-horizon exploration, not terrain-aware feasibility.",
            "This regional crop omits the rest of the source raster. Transparent cells would indicate missing terrain, never flat terrain.",
            "Nominal raster spacing is not effective spatial resolution. Interpolation and unresolved small terrain remain limitations.",
            "Study-point labels are published region centers, not approved landing locations. No landing safety or trajectory claim is made.",
        ],
        "reproduce": "python -m science.atlas --raw data/raw --output web/data",
        "aiUse": "OpenAI Codex and Anthropic Claude assisted derivative implementation, tests and interface text under human teammates Arya Ergin and Aras. Image pixels are a deterministic NASA DEM transformation, not generative artwork.",
    }
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    (output / "terrain-atlas.png").write_bytes(image)
    (output / "terrain-atlas.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=Path("data/raw"))
    parser.add_argument("--output", type=Path, default=Path("web/data"))
    args = parser.parse_args()
    metadata = build_atlas(args.raw, args.output)
    print(json.dumps({"imageSha256": metadata["display"]["sha256"],
                      "validPixels": metadata["display"]["validPixels"],
                      "missingPixels": metadata["display"]["missingPixels"]}))


if __name__ == "__main__":
    main()
