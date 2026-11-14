"""Reproduce the offline NASA visual assets and pinned Three.js bundle.

Build-only requirements: Python 3.11+, Pillow==12.3.0, NumPy, Node 18+ and npm.
Run ``python -m science.visual_assets`` from any directory. Downloads and npm
packages stay in the ignored .operator folder. Use --images-only to omit npm.
Use --derivatives-only to build the preview and inset from verified shipped
images without downloading sources or rebuilding the original images/vendor.
These rendering maps never enter the terrain/visibility calculation pipeline.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image
from PIL import __version__ as pillow_version

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / ".operator" / "visual-assets"
ASSETS = ROOT / "web" / "assets"
VENDOR_BUILD = ROOT / ".operator" / "3d-vendor"
VENDOR = ROOT / "web" / "vendor"
NASA_TERMS = "https://www.nasa.gov/nasa-brand-center/images-and-media/"
SOURCES = {
    "moon-color": {
        "filename": "lroc_color_16bit_srgb_4k.tif",
        "url": "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_4k.tif",
        "page": "https://svs.gsfc.nasa.gov/4720/",
        "sha256": "9731fa8af425b6c2f88f277ecca82bf8c603f3743894f64ed7b25c5bfefa22ff",
        "credit": "NASA's Scientific Visualization Studio; Ernie Wright; LRO/LROC and LOLA instrument teams",
    },
    "moon-bump": {
        "filename": "moon-bump.jpg",
        "url": "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_3_8bit.jpg",
        "page": "https://svs.gsfc.nasa.gov/4720/",
        "sha256": "6d93f887e7d8bedfe35ab89ba785e5e3ca12381bd092a5e6abe2c707dda8bb98",
        "credit": "NASA's Scientific Visualization Studio; LRO/LOLA instrument team",
    },
    "moon-poster": {
        "filename": "moon-poster.jpg",
        "url": "https://svs.gsfc.nasa.gov/vis/a010000/a014900/a014959/Moon-Model-Preview-Flat.jpg",
        "page": "https://svs.gsfc.nasa.gov/14959/",
        "sha256": "7db7cc91f6c29ce42748ffcf2bc9ba1f3bb5faff817ad0a0b24be898db41ba8e",
        "credit": "NASA's Goddard Space Flight Center",
    },
    "earth-color": {
        "filename": "bluemarble-2048.png",
        "url": "https://svs.gsfc.nasa.gov/vis/a000000/a002900/a002915/bluemarble-2048.png",
        "page": "https://svs.gsfc.nasa.gov/2915/",
        "sha256": "ae6214b078ed0864c96f74bcb10ae3021f6eb116f8059797efe0fa9ea8b89d35",
        "credit": "NASA/Goddard Space Flight Center Scientific Visualization Studio; Reto Stockli (NASA/GSFC); NASA Earth Observatory",
    },
}
MODEL_INSPECTIONS = {
    "moon_small.glb": {
        "url": "https://svs.gsfc.nasa.gov/vis/a010000/a014900/a014959/moon_small.glb",
        "page": "https://svs.gsfc.nasa.gov/14959/",
        "sha256": "12d3b0bb7fe214903f51447d1bc61710f442e92a11c703fcaca6d4e7ff8e67d4",
        "bytes": 13799876,
        "finding": "4096x4096 cube-cross color atlas, not an equirectangular texture. The source page links the CGI Moon Kit used for the runtime color map instead.",
    },
    "earth.glb": {
        "url": "https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/e/Earth_1_12756.glb",
        "page": "https://science.nasa.gov/learn/heat/resource/earth-3d-model/",
        "sha256": "05a5aea99db8ab472487a06debc3b5d0b2cae7636a1a6b9ecfa40b7d1722ba23",
        "bytes": 12916400,
        "finding": "4096x3072 cube-cross color and normal atlases, not equirectangular textures. NASA's Blue Marble equirectangular map is used instead.",
    },
}
PACKAGES = {
    "three": {
        "version": "0.186.0",
        "integrity": "sha512-cr/fIM2ddMSVbYVgkfD4jLJv7Fh/8ZTjvo+7gQeSVGUZHxpx9FDwoL5iC7hUz/LiRA8wMbqfnb90xKfm1/HHkQ==",
    },
    "esbuild": {
        "version": "0.27.0",
        "integrity": "sha512-jd0f4NHbD6cALCyGElNpGAOtWxSq46l9X/sWB0Nzd5er4Kz2YTm+Vl0qKFT9KUJvD8+fiO8AvoHhFvEatfVixA==",
    },
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def download(source: dict, path: Path) -> Path:
    """Preserve cached originals; reject publisher changes instead of guessing."""
    if not path.exists():
        request = urllib.request.Request(source["url"], headers={"User-Agent": "LUNARIS-asset-build/1.0"})
        with urllib.request.urlopen(request, timeout=90) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != source["sha256"]:
            raise ValueError(f"Source changed: {source['url']}")
        path.write_bytes(data)
    if digest(path) != source["sha256"]:
        raise ValueError(f"Cached source checksum mismatch: {path}")
    return path


def source_record(source: dict, path: Path) -> dict:
    return {
        **source,
        "bytes": path.stat().st_size,
        "retrieved_utc": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
    }


def render_moon_poster(color_map: Image.Image, output: Path) -> None:
    """Orthographically project the actual NASA pixels onto a smooth sphere."""
    width, height, center_x, center_y, radius = 1920, 1080, 1268, 540, 438
    # Work only in the sphere's bounding square, sampling at pixel centers.
    coordinate = np.arange(-radius - 1, radius + 1, dtype=np.float64) + 0.5
    screen_x, screen_y = np.meshgrid(coordinate / radius, -coordinate / radius)
    radial_squared = screen_x**2 + screen_y**2
    normal_z = np.sqrt(np.maximum(0, 1 - radial_squared))
    longitude = np.arctan2(screen_x, normal_z)
    latitude = np.arcsin(np.clip(screen_y, -1, 1))
    texture = np.asarray(color_map.convert("RGB"), dtype=np.float64) / 255
    tex_height, tex_width = texture.shape[:2]
    source_x = (longitude / (2 * np.pi) + 0.5) * tex_width - 0.5
    source_y = np.clip((0.5 - latitude / np.pi) * tex_height - 0.5, 0, tex_height - 1)
    x0 = np.floor(source_x).astype(int) % tex_width
    y0 = np.floor(source_y).astype(int)
    x1, y1 = (x0 + 1) % tex_width, np.minimum(y0 + 1, tex_height - 1)
    x_weight = (source_x - np.floor(source_x))[..., None]
    y_weight = (source_y - y0)[..., None]
    albedo = ((1 - y_weight) * ((1 - x_weight) * texture[y0, x0] + x_weight * texture[y0, x1])
              + y_weight * ((1 - x_weight) * texture[y1, x0] + x_weight * texture[y1, x1]))
    # Decode sRGB for lighting; this is a fixed illustrative illumination,
    # unrelated to any selected mission UTC or scientific Sun visibility.
    linear = np.where(albedo <= 0.04045, albedo / 12.92, ((albedo + 0.055) / 1.055) ** 2.4)
    light = np.array([-0.35, 0.22, 0.91])
    light /= np.linalg.norm(light)
    diffuse = np.maximum(0, screen_x * light[0] + screen_y * light[1] + normal_z * light[2])
    linear *= (0.12 + 0.88 * diffuse)[..., None]
    lit = np.where(linear <= 0.0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - 0.055)
    coverage = np.clip((1 - np.sqrt(radial_squared)) * radius + 0.5, 0, 1)[..., None]
    background = np.array([4, 9, 12], dtype=np.float64) / 255
    pixels = np.rint(np.clip(lit * coverage + background * (1 - coverage), 0, 1) * 255).astype(np.uint8)
    poster = Image.new("RGB", (width, height), (4, 9, 12))
    poster.paste(Image.fromarray(pixels), (center_x - radius - 1, center_y - radius - 1))
    poster.save(output, format="JPEG", quality=93, subsampling=0, optimize=True, progressive=True)


def build_images() -> list[dict]:
    RAW.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)
    products = []
    for name, source in SOURCES.items():
        raw = download(source, RAW / source["filename"])
        output = ASSETS / f"{name}.jpg"
        with Image.open(raw) as original:
            original.load()
            if name == "moon-poster":
                color_source = SOURCES["moon-color"]
                color_path = download(color_source, RAW / color_source["filename"])
                with Image.open(color_path) as color_map:
                    render_moon_poster(color_map, output)
                recipe = "Deterministic 1920x1080 orthographic projection of NASA's 2025 CGI Moon Kit color map; Moon center=(1268,540), radius=438px; view latitude=0 and east longitude=0 degrees; bilinear sampling; sRGB linearized for Lambert lighting in viewer coordinates with unit direction normalize([-0.35,0.22,0.91]), ambient=0.12 and diffuse=0.88; JPEG quality=93, subsampling=0. No synthetic craters, terrain or generative image model."
            elif name == "moon-bump":
                shutil.copyfile(raw, output)
                recipe = "Unmodified byte-for-byte copy of the NASA-published JPEG."
            else:
                # The lunar TIFF is sRGB 16-bit RGB. Pillow decodes its high
                # eight bits per channel; no gamma or artistic edits are made.
                original.convert("RGB").save(
                    output, format="JPEG", quality=93, subsampling=0,
                    optimize=True, progressive=True,
                )
                recipe = "Pillow RGB decode to 8 bits/channel; JPEG quality=93, subsampling=0, optimize=True, progressive=True; no resize, shift, flip, added features or gamma adjustment."
            with Image.open(output) as result:
                dimensions = list(result.size)
            products.append({
                "path": output.relative_to(ROOT / "web").as_posix(),
                "sha256": digest(output),
                "bytes": output.stat().st_size,
                "dimensions": dimensions,
                "source": source_record(color_source, color_path) if name == "moon-poster" else source_record(source, raw),
                **({"original_preview_considered": {**source_record(source, raw), "finding": "NASA's original model preview contains viewport grid lines and axes; the runtime poster instead projects the NASA color texture deterministically."}} if name == "moon-poster" else {}),
                "conversion": recipe,
                "role": "Static orthographic rendering from NASA texture; fixed illustrative lighting" if name == "moon-poster" else "Visual globe texture only; excluded from terrain, ephemeris and decision calculations",
                "orientation": None if name == "moon-poster" else {
                    "projection": "equirectangular",
                    "image_top_latitude_deg": 90,
                    "image_bottom_latitude_deg": -90,
                    "left_longitude_east_deg": -180,
                    "center_longitude_east_deg": 0,
                    "right_longitude_east_deg": 180,
                    "texture_u": "(longitude_east_deg + 180) / 360",
                    "image_v_from_top": "(90 - latitude_deg) / 180",
                    "note": "Rendering axes must be matched to these UVs; the texture does not define the application's Moon-fixed frame.",
                },
            })
    return products


def render_earth_inset(color_map: Image.Image, output: Path) -> None:
    """Project historical NASA pixels without adding light or a terminator."""
    radius = 246
    coordinate = np.arange(-radius - 1, radius + 1, dtype=np.float64) + 0.5
    screen_x, screen_y = np.meshgrid(coordinate / radius, -coordinate / radius)
    radial_squared = screen_x**2 + screen_y**2
    normal_z = np.sqrt(np.maximum(0, 1 - radial_squared))
    longitude, latitude = np.arctan2(screen_x, normal_z), np.arcsin(np.clip(screen_y, -1, 1))
    texture = np.asarray(color_map.convert("RGB"), dtype=np.float64) / 255
    height, width = texture.shape[:2]
    source_x = (longitude / (2 * np.pi) + 0.5) * width - 0.5
    source_y = np.clip((0.5 - latitude / np.pi) * height - 0.5, 0, height - 1)
    x0, y0 = np.floor(source_x).astype(int) % width, np.floor(source_y).astype(int)
    x1, y1 = (x0 + 1) % width, np.minimum(y0 + 1, height - 1)
    wx, wy = (source_x - np.floor(source_x))[..., None], (source_y - y0)[..., None]
    pixels = ((1 - wy) * ((1 - wx) * texture[y0, x0] + wx * texture[y0, x1])
              + wy * ((1 - wx) * texture[y1, x0] + wx * texture[y1, x1]))
    coverage = np.clip((1 - np.sqrt(radial_squared)) * radius + 0.5, 0, 1)[..., None]
    pixels = np.rint(np.clip(pixels * coverage, 0, 1) * 255).astype(np.uint8)
    inset = Image.new("RGB", (512, 512), (0, 0, 0))
    inset.paste(Image.fromarray(pixels), (256 - radius - 1, 256 - radius - 1))
    inset.save(output, format="JPEG", quality=82, subsampling=0, optimize=True, progressive=True)


def build_derivatives(products: list[dict]) -> list[dict]:
    """Keep the full-resolution image intact; derive a bounded opening view."""
    products = [item for item in products if item["path"] not in ("assets/moon-preview.jpg", "assets/earth-inset.jpg")]
    for parent_name, output_name in [("moon-color", "moon-preview"), ("earth-color", "earth-inset")]:
        parent = next(item for item in products if item["path"] == f"assets/{parent_name}.jpg")
        source_path = ROOT / "web" / parent["path"]
        if digest(source_path) != parent["sha256"]:
            raise ValueError(f"Shipped source checksum mismatch: {source_path}")
        output = ASSETS / f"{output_name}.jpg"
        with Image.open(source_path) as image:
            if list(image.size) != parent["dimensions"]:
                raise ValueError(f"Shipped source dimensions mismatch: {source_path}")
            if output_name == "moon-preview":
                image.convert("RGB").resize((2048, 1024), Image.Resampling.LANCZOS).save(
                    output, format="JPEG", quality=80, subsampling=0, optimize=True, progressive=True,
                )
                recipe = "Verified shipped 4096x2048 NASA Moon JPEG decoded to RGB, resized to 2048x1024 with Pillow LANCZOS; JPEG quality=80, subsampling=0, optimize=True, progressive=True. No other pixel, gamma, meridian or lighting edits. The unchanged 4K parent remains available for explicitly requested HD."
                role = "Opening globe preview; NASA imagery, display only"
                limit = 700_000
            else:
                render_earth_inset(image, output)
                recipe = "Verified shipped NASA Blue Marble JPEG orthographically projected to 512x512; radius=246px, center=(256,256); fixed illustrative view latitude=0 and longitude=0 degrees, bilinear equirectangular sampling, antialiased limb on black; JPEG quality=82, subsampling=0, optimize=True, progressive=True. No added illumination, shadows, atmospheric layer, clouds, terminator or color adjustment; existing source topographic shading is retained."
                role = "Historical composite illustration; face and phase are unregistered; not current weather or a time-matched Earth view"
                limit = 150_000
        if output.stat().st_size >= limit:
            raise ValueError(f"Derivative exceeds its byte budget: {output}")
        with Image.open(output) as image:
            dimensions = list(image.size)
        products.append({
            "path": output.relative_to(ROOT / "web").as_posix(),
            "sha256": digest(output), "bytes": output.stat().st_size, "dimensions": dimensions,
            "source": parent["source"],
            "derived_from": {key: parent[key] for key in ("path", "sha256", "bytes", "dimensions")},
            "conversion": recipe, "role": role,
            "orientation": parent["orientation"] if output_name == "moon-preview" else None,
            **({"required_display_label": "Historical NASA Blue Marble composite. Face and phase unregistered; not current weather."} if output_name == "earth-inset" else {}),
        })
    return products


def build_vendor() -> dict:
    """Bundle core plus controls with no runtime npm, CDN or bare imports."""
    VENDOR_BUILD.mkdir(parents=True, exist_ok=True)
    VENDOR.mkdir(parents=True, exist_ok=True)
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    node = shutil.which("node")
    if not npm or not node:
        raise RuntimeError("Node and npm are required only when rebuilding the vendor module")
    subprocess.run([
        npm, "install", "--prefix", str(VENDOR_BUILD), "--ignore-scripts",
        "--no-audit", "--no-fund", "--save-exact",
        *[f"{name}@{data['version']}" for name, data in PACKAGES.items()],
    ], check=True, cwd=ROOT)
    lock = json.loads((VENDOR_BUILD / "package-lock.json").read_text(encoding="utf-8"))
    dependencies = {}
    for name, pinned in PACKAGES.items():
        installed = lock["packages"][f"node_modules/{name}"]
        if installed["version"] != pinned["version"] or installed["integrity"] != pinned["integrity"]:
            raise ValueError(f"Pinned package integrity mismatch for {name}")
        dependencies[name] = {
            **pinned, "source_url": installed["resolved"], "license": "MIT",
        }
    entry = VENDOR_BUILD / "entry.mjs"
    entry.write_text("export * from 'three';\nexport { OrbitControls } from 'three/addons/controls/OrbitControls.js';\n", encoding="utf-8")
    output = VENDOR / "three-bundle.mjs"
    metafile = VENDOR_BUILD / "metafile.json"
    subprocess.run([
        node, str(VENDOR_BUILD / "node_modules/esbuild/bin/esbuild"), str(entry),
        "--bundle", "--format=esm", "--platform=browser", "--target=es2022",
        "--minify", "--legal-comments=inline", "--tsconfig-raw={}",
        f"--outfile={output}", f"--metafile={metafile}",
    ], check=True, cwd=ROOT)
    graph = json.loads(metafile.read_text(encoding="utf-8"))
    if any(item["imports"] for item in graph["outputs"].values()):
        raise ValueError("Vendor output retains an external module import")
    shutil.copyfile(VENDOR_BUILD / "node_modules/three/LICENSE", VENDOR / "three-LICENSE.txt")
    return {
        "path": output.relative_to(ROOT / "web").as_posix(),
        "bytes": output.stat().st_size,
        "sha256": digest(output),
        "packages": dependencies,
        "exports": "All exports from three@0.186.0 plus the named OrbitControls export",
        "external_runtime_imports": [],
        "license_file": "vendor/three-LICENSE.txt",
        "build": "science.visual_assets.build_vendor; esbuild --bundle --format=esm --platform=browser --target=es2022 --minify --legal-comments=inline --tsconfig-raw={}",
    }


def inspect_models() -> list[dict]:
    inspected = []
    for filename, source in MODEL_INSPECTIONS.items():
        raw = download(source, RAW / filename)
        data = raw.read_bytes()
        if data[:4] != b"glTF" or struct.unpack_from("<I", data, 8)[0] != len(data):
            raise ValueError(f"Invalid GLB header: {filename}")
        length = struct.unpack_from("<I", data, 12)[0]
        gltf = json.loads(data[20:20 + length])
        inspected.append({
            **source_record(source, raw),
            "embedded_image_count": len(gltf["images"]),
            "shipped_to_browser": False,
        })
    return inspected


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--images-only", action="store_true", help="Retain the existing vendor metadata and omit npm/esbuild")
    mode.add_argument("--derivatives-only", action="store_true", help="Verify shipped parent images and build only preview/inset; no downloads or vendor/original image writes")
    args = parser.parse_args()
    if pillow_version != "12.3.0":
        raise RuntimeError("Use Pillow==12.3.0 for byte-identical image reproduction")
    manifest_path = ASSETS / "visual-sources.json"
    existing = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    if args.derivatives_only:
        if not existing.get("assets"):
            raise RuntimeError("Build the original images once before using --derivatives-only")
        products = build_derivatives(existing["assets"])
        existing["assets"] = products
        existing["pillow_version"], existing["numpy_version"] = pillow_version, np.__version__
        existing["derivative_reproduce"] = "python -m science.visual_assets --derivatives-only"
        manifest_path.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"derivatives": [item["path"] for item in products[-2:]], "derivative_bytes": sum(item["bytes"] for item in products[-2:])}, indent=2))
        return
    products = build_derivatives(build_images())
    vendor = existing.get("vendor") if args.images_only else build_vendor()
    manifest = {
        "schema_version": "1.0",
        "purpose": "Offline educational rendering; visual maps do not determine mission constraints or certify terrain clearance",
        "reproduce": "python -m pip install -r requirements-build.txt Pillow==12.3.0; python -m science.visual_assets",
        "derivative_reproduce": "python -m science.visual_assets --derivatives-only",
        "pillow_version": pillow_version,
        "numpy_version": np.__version__,
        "nasa_media_usage_guidelines": NASA_TERMS,
        "nasa_usage_note": "Acknowledge the identified NASA sources. No NASA endorsement is implied. NASA identifiers are not used as product branding. Follow the linked NASA media guidelines and any separately identified third-party terms.",
        "ai_disclosure": "AI assisted this asset acquisition, conversion and orthographic projection script, dependency bundling and verification. The visual imagery is NASA-published satellite-derived data; the poster is a deterministic sphere projection of those pixels. No generative images were used.",
        "limitations": [
            "The Moon color mosaic is optimized for aesthetics. NASA describes inpainted small high-latitude gaps and monochromatic LOLA albedo replacing the polar areas outside 70 degrees latitude.",
            "The 1024x512 LOLA JPEG is an 8-bit visual bump preview, not a numeric terrain source or a scientifically scaled displacement map.",
            "The Blue Marble texture is a historical multi-date composite with baked topographic shading, not current Earth imagery, current weather, or an Earth-fixed attitude calculation.",
            "The poster is a smooth-sphere rendering with fixed illustrative lighting and does not depict terrain relief or illumination at the selected mission UTC.",
        ],
        "assets": products,
        "inspected_alternatives": inspect_models(),
        "vendor": vendor,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"assets": len(products), "image_bytes": sum(p["bytes"] for p in products), "vendor_bytes": vendor["bytes"] if vendor else None, "manifest": str(manifest_path)}, indent=2))


if __name__ == "__main__":
    main()
