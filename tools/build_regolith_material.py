"""Offline derivatives of Poly Haven's CC0 laboratory regolith simulant.

Install the existing requirements-build.txt dependencies, then run
``python tools/build_regolith_material.py --acquire``. Only three pinned sources
(6.92 MB total) are fetched; no displacement, AO, preview or geometry is used.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import urllib.request
import warnings

import numpy as np
from PIL import Image, __version__ as PILLOW_VERSION

ROOT = Path(__file__).resolve().parents[1]
ASSET = "moon_macro_01"
PAGE = f"https://polyhaven.com/a/{ASSET}"
LICENSE = "https://polyhaven.com/license"
TILE_WIDTH_M = .4
SOURCES = {
    "diffuse": {"filename": "moon_macro_01_diff_1k.jpg", "format": "jpg", "resolution": "1k", "byteLength": 607698,
                "md5": "83a84a44cff8c7b43b7ca35bcdecde6c", "sha256": "752421a3505eaedf5cf4dfe37ec75c559fd3cefd28aa2e9b48be781a35704068"},
    "normal": {"filename": "moon_macro_01_nor_gl_1k.png", "format": "png", "resolution": "1k", "byteLength": 5994106,
               "md5": "d261def688694c890b695bcbf1990a09", "sha256": "91d5210eba6b49006577d0544b74deba8e2924af96d7f1d54ed0edbf05b03f97"},
    "roughness": {"filename": "moon_macro_01_rough_1k.jpg", "format": "jpg", "resolution": "1k", "byteLength": 316490,
                  "md5": "9902e278c61635d3c1d1ccb4ebfe6589", "sha256": "10c0ad79f340cd28fdbaa4c92d020a6886072122836d11e8e6ce21b823262b24"},
}
for source in SOURCES.values():
    source["url"] = f"https://dl.polyhaven.org/file/ph-assets/Textures/{source['format']}/{source['resolution']}/{ASSET}/{source['filename']}"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def validate_source(path, source):
    payload = path.read_bytes()
    if len(payload) != source["byteLength"] or hashlib.md5(payload).hexdigest() != source["md5"] or sha256(payload) != source["sha256"]:
        raise ValueError(f"Pinned material source differs: {path.name}")


def acquire(raw):
    if sum(row["byteLength"] for row in SOURCES.values()) > 12_000_000:
        raise ValueError("Material source request exceeds the12MB budget")
    raw.mkdir(parents=True, exist_ok=True)
    for source in SOURCES.values():
        path = raw/source["filename"]
        if not path.is_file():
            request = urllib.request.Request(source["url"], headers={"User-Agent": "LUNARIS/1.0 offline material build"})
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = response.read(source["byteLength"]+1)
            if len(payload) != source["byteLength"] or hashlib.md5(payload).hexdigest() != source["md5"] or sha256(payload) != source["sha256"]:
                raise ValueError("Downloaded material source does not match its pin")
            path.write_bytes(payload)
        validate_source(path, source)


def mean_linear_luminance(rgb):
    """Mean Rec.709 luminance after the exact piecewise sRGB decoding curve."""
    values = np.asarray(rgb, dtype=np.float64)/255
    if values.ndim < 3 or values.shape[-1] != 3 or not np.isfinite(values).all():
        raise ValueError("Expected finite8-bit RGB pixels")
    linear = np.where(values <= .04045, values/12.92, ((values+.055)/1.055)**2.4)
    return float(np.mean(linear @ np.array([.2126, .7152, .0722])))


def normalize_vectors(normals):
    values = np.asarray(normals, dtype=np.float64)
    if values.ndim != 3 or values.shape[-1] != 3 or not np.isfinite(values).all():
        raise ValueError("Expected finite linear XYZ normals")
    length = np.linalg.norm(values, axis=-1, keepdims=True)
    safe = np.divide(values, length, out=np.zeros_like(values), where=length > 1e-12)
    safe[length[..., 0] <= 1e-12] = [0, 0, 1]
    return safe


def resize_normal_vectors(normals, size):
    """Average linear XYZ, then renormalize; never apply an sRGB transfer curve."""
    values = normalize_vectors(normals)
    if (values.shape[1], values.shape[0]) != tuple(size):
        values = np.stack([np.asarray(Image.fromarray(values[..., axis].astype(np.float32)).resize(size, Image.Resampling.BOX), dtype=np.float64)
                           for axis in range(3)], axis=-1)
    return normalize_vectors(values)


def read_native_normals(path):
    header = path.read_bytes()[:26]
    bits = header[24] if header[:8] == b"\x89PNG\r\n\x1a\n" else 8
    if bits == 16:
        # Pillow's RGB decoder truncates16-bit PNGs to8-bit. GDAL preserves the
        # original integer precision before linear vector conversion.
        import rasterio
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", rasterio.errors.NotGeoreferencedWarning)
            with rasterio.open(path) as dataset:
                pixels = np.moveaxis(dataset.read((1, 2, 3)), 0, -1)
        scale = np.iinfo(pixels.dtype).max
    else:
        with Image.open(path) as image:
            pixels = np.asarray(image.convert("RGB"))
        scale = 255
    return normalize_vectors(pixels.astype(np.float64)/scale*2-1), bits


def file_record(path, **extra):
    payload = path.read_bytes()
    with Image.open(path) as image:
        width, height = image.size
    return {"url": path.name, "sha256": sha256(payload), "byteLength": len(payload), "width": width, "height": height, **extra}


def build(raw, output):
    for source in SOURCES.values():
        validate_source(raw/source["filename"], source)
    with Image.open(raw/SOURCES["diffuse"]["filename"]) as source:
        diffuse = source.convert("RGB").copy()
    with Image.open(raw/SOURCES["roughness"]["filename"]) as source:
        roughness = source.convert("L").copy()
    normals, native_normal_bits = read_native_normals(raw/SOURCES["normal"]["filename"])
    if diffuse.size != (1024, 1024) or roughness.size != (1024, 1024) or normals.shape != (1024, 1024, 3):
        raise ValueError("Pinned material dimensions changed")
    output.mkdir(parents=True, exist_ok=True)
    textures = {}
    for tier, diffuse_size, detail_size in (("desktop", 1024, 1024), ("mobile", 512, 512)):
        color = diffuse if diffuse.size == (diffuse_size, diffuse_size) else diffuse.resize((diffuse_size, diffuse_size), Image.Resampling.LANCZOS)
        diffuse_path = output/f"regolith-diffuse-{tier}.webp"
        color.save(diffuse_path, format="WEBP", quality=90, method=6)
        # The normalization reference describes the actual decoded output, not
        # the input JPEG or a gamma-space channel mean.
        with Image.open(diffuse_path) as encoded:
            luminance = mean_linear_luminance(np.asarray(encoded.convert("RGB")))
        vectors = resize_normal_vectors(normals, (detail_size, detail_size))
        normal_pixels = np.rint(np.clip(vectors*.5+.5, 0, 1)*255).astype(np.uint8)
        normal_path = output/f"regolith-normal-{tier}.png"
        Image.fromarray(normal_pixels).save(normal_path, optimize=True)
        rough = roughness if detail_size == 1024 else roughness.resize((detail_size, detail_size), Image.Resampling.BOX)
        rough_path = output/f"regolith-roughness-{tier}.png"
        rough.save(rough_path, optimize=True)
        textures[tier] = {
            "diffuse": file_record(diffuse_path, colorSpace="srgb", meanLinearLuminance=luminance),
            "normal": file_record(normal_path, colorSpace="linear", encoding="OpenGL tangent-space XYZ; normalized,8-bit RGB PNG"),
            "roughness": file_record(rough_path, colorSpace="linear", encoding="8-bit grayscale PNG"),
        }
    source_pins = {"assetId": ASSET, "pageUrl": PAGE, "license": "CC0-1.0", "licenseUrl": LICENSE,
                   "licenseTextUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                   "collectionUrl": "https://polyhaven.com/collections/moon", "captureDescriptionUrl": "https://blog.polyhaven.com/moon/",
                   "apiInfoUrl": f"https://api.polyhaven.com/info/{ASSET}", "apiFilesUrl": f"https://api.polyhaven.com/files/{ASSET}",
                   "authors": {"Dario Barresi": "Processing", "Greg Zaal": "Photography", "Jenelle van Heerden": "Photography", "Rico Cilliers": "Photography"},
                   "captureLab": "Spaceport Rostock, Germany", "captureMaterial": "Laboratory regolith simulant, prepared and photographed on Earth",
                   "tileWidthM": TILE_WIDTH_M, "tileHeightM": TILE_WIDTH_M, "apiDimensionsMm": [399.9999761581421, 399.9999761581421],
                   "sourcePinsEstablishedUtcDate": "2026-11-15", "sources": SOURCES,
                   "totalSourceBytes": sum(row["byteLength"] for row in SOURCES.values()),
                   "unusedMaps": ["Displacement", "AO"], "previewRendersIncluded": False}
    manifest = {"schemaVersion": 1, "kind": "laboratory-regolith-simulant", "displayOnly": True,
                "displacementApplied": False, "tileWidthM": TILE_WIDTH_M, "tileHeightM": TILE_WIDTH_M,
                "diffuseMeanLinear": textures["desktop"]["diffuse"]["meanLinearLuminance"], "textures": textures,
                "sourcePinsUrl": "source-pins.json", "license": "CC0-1.0", "sourceUrl": PAGE,
                "credit": "Poly Haven / Spaceport Rostock; Dario Barresi, Greg Zaal, Jenelle van Heerden, Rico Cilliers",
                "limits": ["Representative laboratory simulant material, not NASA-measured regolith at any study point.",
                           "Material normals change display shading only; they do not modify terrain vertices, horizons, visibility, landing hazards or mission decisions.",
                           "No displacement or ambient-occlusion map is applied. Photometric power and exact lunar reflectance are not validated."],
                "conversion": {"nativeDiffuseResolution": list(diffuse.size), "nativeNormalBitDepth": native_normal_bits, "outputNormalBitDepth": 8,
                               "normalResampling": "Linear XYZ box average and unit-vector renormalization; no sRGB decoding",
                               "diffuseEncoding": "sRGB WebP, quality90", "diffuseMeanBasis": "Mean linear-sRGB Rec.709 luminance of the decoded desktop output",
                               "PillowVersion": PILLOW_VERSION, "numpyVersion": np.__version__},
                "reproduce": "python tools/build_regolith_material.py --acquire",
                "aiUse": "OpenAI Codex assisted deterministic conversion code, tests and documentation. The credited source is a human-captured laboratory scan; no generated texture or topography is used."}
    for filename, content in (("source-pins.json", source_pins), ("manifest.json", manifest)):
        path = output/filename
        path.write_text(json.dumps(content, indent=2, sort_keys=True, allow_nan=False)+"\n", encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=ROOT/"data/raw/material")
    parser.add_argument("--output", type=Path, default=ROOT/"web/assets/surface/material")
    parser.add_argument("--acquire", action="store_true")
    args = parser.parse_args()
    if args.acquire:
        acquire(args.raw)
    manifest = build(args.raw, args.output)
    print(json.dumps({"diffuseMeanLinear": manifest["diffuseMeanLinear"], "textures": manifest["textures"], "conversion": manifest["conversion"]}, indent=2))


if __name__ == "__main__":
    main()
