"""Pinned, display-only NASA surface derivatives; never builds visibility data.

Reproduce with ``python tools/build_surface_visuals.py --acquire``. Network
access is optional, bounded to individual ZIP members and one NAC strip range.
Raw products remain in ignored data/raw/surface. Original science and meshes are
read-only inputs. See the emitted manifest for individual raster resolutions.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import urllib.request
import zipfile
import zlib

import numpy as np
from PIL import Image
import rasterio
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from science.ephemerides import enu_basis
from science.scene_terrain import build_mesh, encode_mesh, _coordinates
from science.terrain import RADIUS_M, project

BUNDLE_SHA = "c5b4c18fba7052cd628d6b5af26ec255f2df4597b489c38b994a76809d80c7aa"
SITE_ID = "nobile-rim-2"
ARCHIVE = "A3CLR22_1_Nobile_Rim_2.zip"
ARCHIVE_URL = f"https://zenodo.org/api/records/17954508/files/{ARCHIVE}/content"
ARCHIVE_BYTES = 1839070131
ARCHIVE_MD5 = "964310cb7f2a5033e2e12cd34e7aa7b1"
PINS = {
    "A301_GLDELEV_005.tif": "4e75ed06a48af4d2dfaaed3476cefce636d4bf0dfd004d66193fc714df0011a8",
    "A301_GLDMASK_005.tif": "ca288f61a76f8f7319f8b808b5a0a5884e439f0082f09cbbd3519b9651b5147f",
    "A301_GLDSBCT_005.tif": "1b982641e9a65d1161e2fcf70bec41a88e444f6632528f2361380d78326ccc46",
    "A301_GLDBRES_005.tif": "f4fd05ca1e7ce9d4f1292b891637e45132bce962d0999c2a9c4eb7012020570a",
}
NAC_URL = "https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/lroc/lro-l-lroc-5-rdr/LROLRC_2001/EXTRAS/BROWSE/NAC_ROI/NOBILE02LOC/NAC_ROI_NOBILE02LOC_P839S0587.TIF"
NAC_RANGE = (180141575, 220141574)
NAC_RANGE_SHA = "14b4d66bbc0ae48558ec693957099eae22e2b57ac2aad6f5ebc3d05c39a27c1c"
NAC_PIXEL_SHA = "819c41c65e43f2d0c73f5ac031860201a6a5463bbc55b5987731aa8242b9e541"
NAC_CROP = "nobile2-lroc-crop.tif"
NAC_TRANSFORM = rasterio.Affine(1, 0, 155999.99991753, 0, -1, 96000.99994675)
PROJECTION = "+proj=stere +lat_0=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs"
LEVELS = {"desktop": ((500., 201), (2000., 257), (4000., 129)),
          "mobile": ((250., 101), (2000., 129), (4000., 129))}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_range(url, start, end):
    if start < 0 or end < start or end-start+1 > 50_000_000:
        raise ValueError("Refusing an invalid or oversized source range")
    request = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(request, timeout=90) as response:
        if response.status != 206:
            raise ValueError("Source did not honor HTTP Range; refusing full download")
        if response.headers.get("Content-Range", "").split("/")[0] != f"bytes {start}-{end}":
            raise ValueError("Source range differs from requested bytes")
        data = response.read(end-start+2)
    if len(data) != end-start+1:
        raise ValueError("Incomplete source byte range")
    return data


class RangeArchive(io.RawIOBase):
    def __init__(self):
        self.position = 0

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        self.position = offset if whence == 0 else self.position+offset if whence == 1 else ARCHIVE_BYTES+offset
        return self.position

    def read(self, size=-1):
        size = min(size if size >= 0 else ARCHIVE_BYTES-self.position, ARCHIVE_BYTES-self.position)
        if not size:
            return b""
        data = read_range(ARCHIVE_URL, self.position, self.position+size-1)
        self.position += len(data)
        return data


def acquire(raw):
    raw.mkdir(parents=True, exist_ok=True)
    missing = [name for name in PINS if not (raw/name).is_file()]
    if missing:
        remote = RangeArchive()
        with zipfile.ZipFile(remote) as archive:
            for name in missing:
                matches = [entry for entry in archive.infolist() if entry.filename.endswith("/"+name)]
                if len(matches) != 1:
                    raise ValueError(f"Missing or ambiguous source ZIP member: {name}")
                entry = matches[0]
                header = read_range(ARCHIVE_URL, entry.header_offset, entry.header_offset+29)
                fields = struct.unpack("<4s5H3L2H", header)
                offset = entry.header_offset+30+fields[-2]+fields[-1]
                compressed = read_range(ARCHIVE_URL, offset, offset+entry.compress_size-1)
                if entry.compress_type != zipfile.ZIP_DEFLATED:
                    raise ValueError("Changed ZIP member compression")
                data = zlib.decompress(compressed, -15)
                if len(data) != entry.file_size or zlib.crc32(data) != entry.CRC or digest(data) != PINS[name]:
                    raise ValueError(f"Native source integrity failure: {name}")
                (raw/name).write_bytes(data)
    if not (raw/NAC_CROP).is_file():
        strip = read_range(NAC_URL, *NAC_RANGE)
        if digest(strip) != NAC_RANGE_SHA:
            raise ValueError("NAC source strip range hash changed")
        crop = np.frombuffer(strip, dtype=np.uint8).reshape(2000, 20000)[:, 9000:11000].copy()
        if digest(crop.tobytes()) != NAC_PIXEL_SHA:
            raise ValueError("NAC crop pixels differ from pinned source")
        with rasterio.open(raw/NAC_CROP, "w", driver="GTiff", width=2000, height=2000, count=1,
                           dtype="uint8", nodata=0, crs=PROJECTION, transform=NAC_TRANSFORM,
                           compress="DEFLATE") as destination:
            destination.write(crop, 1)


def raster_metadata(dataset):
    return {"width": dataset.width, "height": dataset.height, "dtype": dataset.dtypes[0],
            "bounds": list(dataset.bounds), "transform": list(dataset.transform),
            "crsWkt": dataset.crs.to_wkt(), "nodata": dataset.nodata,
            "registration": dataset.tags().get("AREA_OR_POINT"), "tags": dataset.tags()}


def validate_projection(dataset):
    # WKT names differ between the PDS mosaic and SfS product; parameters agree.
    from pyproj import CRS
    params = CRS.from_wkt(dataset.crs.to_wkt()).to_dict()
    if (params.get("proj") != "stere" or params.get("lat_0") != -90
            or params.get("lon_0") != 0 or params.get("R") != RADIUS_M
            or dataset.tags().get("AREA_OR_POINT") != "Area"):
        raise ValueError("Unexpected lunar projection, datum, or pixel registration")


def local_coordinates(site, positions):
    basis = enu_basis(site["lat"], site["lon"])
    enu = np.column_stack((positions[:, 0], -positions[:, 2], positions[:, 1]))
    world = enu @ basis + basis[2]*(RADIUS_M+site["groundM"])
    radial = world @ basis[2]
    grid = np.column_stack((RADIUS_M*(world@basis[0])/radial, RADIUS_M*(world@basis[1])/radial))
    return grid, np.linalg.norm(world, axis=1)-RADIUS_M


class FrozenBoundary:
    def __init__(self, site, record, payload):
        if digest(payload) != record["sha256"] or len(payload) != record["byteLength"]:
            raise ValueError("Frozen base display mesh differs from its manifest")
        positions = np.frombuffer(payload, dtype="<f4", count=record["vertexCount"]*3).reshape(-1, 3)
        grid, heights = local_coordinates(site, positions)
        snapped = np.rint(grid/62.5).astype(int)
        aligned = np.max(np.abs(grid-snapped*62.5), axis=1) < .02
        selected = aligned & (np.max(np.abs(snapped), axis=1) <= 64) & (np.max(np.abs(snapped), axis=1) >= 55)
        self.values = {tuple(key): (position.copy(), float(height)) for key, position, height in zip(snapped[selected], positions[selected], heights[selected])}
        self.edge = {key: value[0] for key, value in self.values.items() if max(map(abs, key)) == 64}
        if len(self.edge) != 512:
            raise ValueError("Frozen 4 km mesh seam is incomplete")

    def height(self, east, north):
        shape = np.shape(east)
        flat = np.column_stack((np.ravel(east), np.ravel(north)))/62.5
        low = np.clip(np.floor(flat).astype(int), -64, 63)
        fraction = flat-low
        output = np.zeros(len(flat))
        for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
            values = np.array([self.values[(int(x+dx), int(y+dy))][1] for x, y in low])
            weight = (fraction[:, 0] if dx else 1-fraction[:, 0])*(fraction[:, 1] if dy else 1-fraction[:, 1])
            output += weight*values
        return output.reshape(shape)

    def anchor(self, positions, grid):
        selected = np.flatnonzero(np.isclose(np.max(np.abs(grid), axis=1), 4000, atol=1e-8))
        for index in selected:
            key = tuple(np.rint(grid[index]/62.5).astype(int))
            positions[index] = self.edge[key]
        if len(selected) != 512:
            raise ValueError("Patch boundary does not match the 512-vertex frozen seam")
        return len(selected)


class SurfaceSampler:
    local_half_extent_m = 4000

    def __init__(self, dataset, site, boundary):
        self.site, self.boundary = site, boundary
        self.data = dataset.read(1, masked=True)
        self.valid = ~np.ma.getmaskarray(self.data) & np.isfinite(self.data.data)
        self.inverse = ~dataset.transform
        self.missing = None if self.valid.all() else np.pad((~self.valid).astype(np.int32), ((1, 0), (1, 0))).cumsum(0).cumsum(1)

    def indices(self, east, north):
        x, y = project(*_coordinates(self.site, east, north))
        return self.inverse @ (x, y)

    def sample(self, east, north):
        east, north = np.broadcast_arrays(np.asarray(east, dtype=float), np.asarray(north, dtype=float))
        col, row = self.indices(east, north)
        # Affine maps pixel corners; samples are at native pixel centers.
        col, row = np.asarray(col)-.5, np.asarray(row)-.5
        rows, columns = self.data.shape
        if min(rows, columns) < 2:
            return np.full(east.shape, np.nan), np.zeros(east.shape, dtype=bool)
        finite = np.isfinite(col) & np.isfinite(row)
        # Nanometre-scale arithmetic tolerance only, not an extrapolation halo.
        valid = finite & (col >= -1e-9) & (row >= -1e-9) & (col <= columns-1+1e-9) & (row <= rows-1+1e-9)
        col, row = np.clip(np.where(finite, col, 0), 0, columns-1), np.clip(np.where(finite, row, 0), 0, rows-1)
        c = np.minimum(np.floor(col).astype(int), columns-2)
        r = np.minimum(np.floor(row).astype(int), rows-2)
        fx, fy = col-c, row-r
        height = np.zeros(east.shape, dtype=float)
        for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
            neighbor = self.data.data[r+dy, c+dx]
            valid &= self.valid[r+dy, c+dx] & np.isfinite(neighbor)
            weight = (fx if dx else 1-fx)*(fy if dy else 1-fy)
            height += np.where(np.isfinite(neighbor), neighbor, 0)*weight
        belt = np.maximum(np.abs(east), np.abs(north)) > 3500
        if np.any(belt):
            t = np.clip((np.maximum(np.abs(east[belt]), np.abs(north[belt]))-3500)/500, 0, 1)
            t = t*t*(3-2*t)
            height[belt] = height[belt]*(1-t)+self.boundary.height(east[belt], north[belt])*t
        return np.where(valid, height, np.nan), valid

    def cells_valid(self, east, north, *, local):
        col, row = self.indices(east, north)
        c0, r0 = np.floor(col.min(-1)).astype(int)-1, np.floor(row.min(-1)).astype(int)-1
        c1, r1 = np.floor(col.max(-1)).astype(int)+2, np.floor(row.max(-1)).astype(int)+2
        inside = (c0 >= 0) & (r0 >= 0) & (c1 <= self.data.shape[1]) & (r1 <= self.data.shape[0])
        if self.missing is None:
            return inside
        c0, c1 = np.clip(c0, 0, self.data.shape[1]), np.clip(c1, 0, self.data.shape[1])
        r0, r1 = np.clip(r0, 0, self.data.shape[0]), np.clip(r1, 0, self.data.shape[0])
        count = self.missing[r1, c1]-self.missing[r0, c1]-self.missing[r1, c0]+self.missing[r0, c0]
        return inside & (count == 0)


def observer_height_metadata(site, native_height, sampler):
    values, valid = sampler.sample(np.array([0.]), np.array([0.]))
    interpolated = float(values[0]) if valid[0] and np.isfinite(values[0]) else None
    return {"baselineGroundM": site["groundM"], "nativeSfsGroundM": native_height,
            "sfsMinusBaselineGroundM": native_height-site["groundM"],
            "rigidVerticalOffsetAppliedM": 0,
            "cameraAboveNativeSfsCellM": site["groundM"]+site["heightM"]-native_height,
            "interpolatedSfsGroundM": interpolated,
            "interpolatedSfsMinusBaselineGroundM": None if interpolated is None else interpolated-site["groundM"],
            "cameraAboveInterpolatedSfsM": None if interpolated is None else site["groundM"]+site["heightM"]-interpolated,
            "interpolatedSfsGroundValid": interpolated is not None,
            "displayHeightSampling": "Bilinear radial height at native pixel centers; all four contributors must be finite and valid. No edge extrapolation."}


def file_record(path, **extra):
    payload = path.read_bytes()
    return {"url": path.name, "byteLength": len(payload), "sha256": digest(payload), **extra}


def acquire_pinned_regions(raw, sources):
    """Reproduce only the pinned native members, never whole regional archives."""
    raw.mkdir(parents=True, exist_ok=True)
    for source in sources:
        url = source["archive"]["links"]["self"]
        for member in source["files"]:
            path = raw/member["filename"]
            if not path.is_file():
                header = read_range(url, member["headerOffset"], member["headerOffset"]+29)
                fields = struct.unpack("<4s5H3L2H", header)
                offset = member["headerOffset"]+30+fields[-2]+fields[-1]
                compressed = b"".join(read_range(url, start, min(offset+member["compressedBytes"], start+40_000_000)-1)
                                      for start in range(offset, offset+member["compressedBytes"], 40_000_000))
                if member["method"] != zipfile.ZIP_DEFLATED:
                    raise ValueError("Changed native ZIP compression")
                data = zlib.decompress(compressed, -15)
                if len(data) != member["bytes"] or f"{zlib.crc32(data):08x}" != member["crc"] or digest(data) != member["sha256"]:
                    raise ValueError("Pinned native surface source changed")
                path.write_bytes(data)
            if digest(path.read_bytes()) != member["sha256"]:
                raise ValueError(f"Pinned native surface source changed: {path.name}")


def tiff_layout(url):
    """Read only classic TIFF directory arrays needed for uncompressed NAC tiles."""
    header = read_range(url, 0, 7)
    if header[:4] != b"II*\x00":
        raise ValueError("Unsupported source TIFF directory layout")
    offset = struct.unpack_from("<L", header, 4)[0]
    count = struct.unpack("<H", read_range(url, offset, offset+1))[0]
    if count > 256:
        raise ValueError("Unexpected source TIFF directory size")
    entries = read_range(url, offset+2, offset+2+12*count-1)
    fields = {}
    for index in range(count):
        row = entries[index*12:(index+1)*12]
        tag, kind, length, value = struct.unpack("<HHLL", row)
        if tag not in {256, 257, 258, 259, 274, 277, 322, 323, 324, 325}:
            continue
        formats = {1: (1, "B"), 3: (2, "H"), 4: (4, "L"), 16: (8, "Q")}
        if kind not in formats or length > 100000:
            raise ValueError("Unsupported source TIFF field type")
        size, code = formats[kind]
        payload = row[8:8+size*length] if size*length <= 4 else read_range(url, value, value+size*length-1)
        fields[tag] = struct.unpack("<"+code*length, payload)
    if fields[258] != (8,) or fields[259] != (1,) or fields.get(277, (1,)) != (1,) or fields.get(274, (1,)) != (1,):
        raise ValueError("Changed NAC tile format, samples, or orientation")
    return fields


def acquire_photos(raw, specs):
    """Pinned tiled-window extraction, refusing any full-file HTTP response."""
    layouts = {}
    for spec in specs:
        path = raw/spec["rawFilename"]
        if path.is_file():
            if digest(path.read_bytes()) != spec["pixelSha256"]:
                raise ValueError("Existing photographic pixels changed")
            continue
        pixels = np.zeros((spec["height"], spec["width"]), dtype=np.uint8)
        for source in spec["sourceNativeRaster"]:
            native, window = source["nativeRaster"], source["window"]
            url = native["url"]
            if url not in layouts:
                layouts[url] = tiff_layout(url)
            fields = layouts[url]
            width, height = fields[256][0], fields[257][0]
            if (width, height) != (native["width"], native["height"]):
                raise ValueError("NAC source dimensions changed")
            tile_w, tile_h = fields[322][0], fields[323][0]
            offsets, counts = fields[324], fields[325]
            columns = (width+tile_w-1)//tile_w
            col, row, view_w, view_h = (window[key] for key in ("col", "row", "width", "height"))
            dest_c, dest_r = window.get("destCol", 0), window.get("destRow", 0)
            for tile_row in range(row//tile_h, (row+view_h-1)//tile_h+1):
                tiles = [tile_row*columns+tile_col for tile_col in range(col//tile_w, (col+view_w-1)//tile_w+1)]
                lo = min(offsets[index] for index in tiles)
                hi = max(offsets[index]+counts[index] for index in tiles)
                block = read_range(url, lo, hi-1)
                for index in tiles:
                    if counts[index] != tile_w*tile_h:
                        raise ValueError("Unexpected uncompressed NAC tile byte count")
                    tile = np.frombuffer(block, dtype=np.uint8, count=counts[index], offset=offsets[index]-lo).reshape(tile_h, tile_w)
                    x, y = index % columns*tile_w, index//columns*tile_h
                    x0, y0, x1, y1 = max(col, x), max(row, y), min(col+view_w, x+tile_w), min(row+view_h, y+tile_h)
                    pixels[dest_r+y0-row:dest_r+y1-row, dest_c+x0-col:dest_c+x1-col] = tile[y0-y:y1-y, x0-x:x1-x]
        if digest(pixels.tobytes()) != spec["pixelSha256"]:
            raise ValueError("Extracted photographic pixels differ from pinned window")
        path.write_bytes(pixels.tobytes())


def build_photos(raw, output, specs):
    path = output/"manifest.json"
    manifest = json.loads(path.read_text())
    for spec in specs:
        profile = next(row for row in manifest["sites"] if row["site"]["id"] == spec["siteId"])
        payload = (raw/spec["rawFilename"]).read_bytes()
        if digest(payload) != spec["pixelSha256"] or len(payload) != spec["width"]*spec["height"]:
            raise ValueError("Photo pixels do not match pinned native window")
        pixels = np.frombuffer(payload, dtype=np.uint8).reshape(spec["height"], spec["width"])
        transform = rasterio.Affine(*spec["transform"][:6])
        if transform.a != 1 or transform.e != -1 or transform.b or transform.d:
            raise ValueError("Changed1m north-up photographic grid")
        with rasterio.io.MemoryFile() as memory:
            with memory.open(driver="GTiff", width=1, height=1, count=1, dtype="uint8", crs=spec["crsWkt"], transform=transform) as synthetic_header:
                # Source pins explicitly bind north-up Area georeferencing to
                # the matching native GeoTIFF; the one-pixel header validates
                # only those CRS parameters, not photographic pixel content.
                synthetic_header.update_tags(AREA_OR_POINT="Area")
                validate_projection(synthetic_header)
        xmin, ymin, xmax, ymax = spec["bounds"]
        x, y = project(profile["site"]["lat"], profile["site"]["lon"])
        if not (xmin <= x < xmax and ymin < y <= ymax):
            raise ValueError("Exact observer is outside its photographic crop")
        valid = pixels != 0
        textures, masks = {}, {}
        for quality, size in (("desktop", 2000), ("mobile", 1000)):
            image = Image.fromarray(pixels)
            mask = Image.fromarray(valid.astype(np.uint8)*255)
            if image.size != (size, size):
                image = image.resize((size, size), Image.Resampling.LANCZOS)
                mask = mask.resize((size, size), Image.Resampling.BOX).point(lambda value: 255 if value == 255 else 0)
            texture_path = output/f"{spec['siteId']}-photo-{quality}.webp"
            mask_path = output/f"{spec['siteId']}-photo-mask-{quality}.png"
            image.save(texture_path, format="WEBP", quality=92, method=6)
            mask.save(mask_path, optimize=True)
            textures[quality] = file_record(texture_path, width=size, height=size, metersPerPixel=(xmax-xmin)/size)
            masks[quality] = file_record(mask_path, width=size, height=size, validFraction=float(np.asarray(mask).mean()/255))
        profile["imagery"] = {"bounds": spec["bounds"], "nativeBounds": spec["bounds"], "textures": textures, "masks": masks,
                              "nativeRaster": {"width": spec["width"], "height": spec["height"], "transform": list(transform), "bounds": spec["bounds"], "crsWkt": spec["crsWkt"], "registration": "Area", "nodata": 0},
                              "sourceUrl": spec["sourceUrl"], "sourcePixelSha256": spec["pixelSha256"], "sourceNativeRaster": spec["sourceNativeRaster"],
                              "nativeResolutionM": 1, "historicIllumination": True, "photometricAlbedo": False,
                              "displayContrastGamma": 0.6 if spec["siteId"] == "de-gerlache-rim" else 1.0,
                              "displayContrastScope": "Illustrative monotonic brightness adjustment for readability, not recovered shadow detail or calibrated albedo.",
                              "validFraction": float(valid.mean()), "product": "NASA LROC controlled polar mosaic",
                              "registration": spec["registration"], "limitations": spec["limitations"],
                              "projection": {"kind": "south-polar-stereographic", "radiusM": RADIUS_M, "centralMeridianDeg": 0, "latitudeOriginDeg": -90},
                              "uvConvention": manifest["imagery"]["uvConvention"]}
        profile["sources"] = [row for row in profile["sources"] if row.get("url") != NAC_URL]
        profile["sources"].append({"url": spec["sourceUrl"], "credit": "NASA/GSFC/Arizona State University LROC"})
    temporary = output/"manifest.new.json"
    temporary.write_text(json.dumps(manifest, indent=2, sort_keys=True, allow_nan=False)+"\n", encoding="utf-8")
    temporary.replace(path)
    return manifest


def build_region(raw, output, site, source, prototype):
    profile = json.loads(json.dumps(prototype))
    for field in ("sites", "observerSfsInputs", "sourceSamplesAtObserver"):
        profile.pop(field, None)
    profile["qualityGates"].pop("imageDerivedDetailAtObserver", None)
    profile["site"] = {"id": site["id"], **{key: site[key] for key in ("lat", "lon", "groundM", "heightM")}}
    profile["terrain"], profile["imagery"] = {}, None
    profile["sourceRasters"] = []
    profile["observer"] = {"baselineGroundM": site["groundM"], "rigidVerticalOffsetAppliedM": 0}
    profile["sources"] = [row for row in profile["sources"] if row.get("url") != NAC_URL]
    profile["limits"] = [text for text in profile["limits"] if not text.startswith(("Different source coordinate grids", "The single1m NAC mosaic"))]
    profile["limits"].append("Individual raster geotransforms govern registration and resolution; a shared filename suffix does not establish equal pixel grids.")
    if source is None:
        profile["terrain"] = None
        profile["surfaceStatus"] = "SFS_NOT_COVERED"
        profile["surfaceReason"] = "None of the13 published SfS DEM footprints covers this observer point; original LOLA display terrain retained."
        profile["sourceArchive"] = None
        profile["qualityGates"]["siteInsideSources"] = False
        profile["qualityGates"]["completeFrozenSeam"] = False
        return profile
    archive = source["archive"]
    profile["sourceArchive"] = {"url": archive["links"]["self"], "byteLength": archive["size"], "publisherMd5": archive["checksum"].removeprefix("md5:"),
                                "acquiredUtcDate": "2026-11-15", "version": "1.0.0",
                                "fullArchiveDownloaded": False, "fullArchiveMd5Verified": False, "memberCrcAndSha256Verified": True}
    x, y = project(site["lat"], site["lon"])
    observer_inputs = {}
    for member in source["files"]:
        path = raw/member["filename"]
        payload = path.read_bytes()
        if digest(payload) != member["sha256"]:
            raise ValueError(f"Changed native SfS source: {path.name}")
        with rasterio.open(path) as dataset:
            validate_projection(dataset)
            profile["sourceRasters"].append({"filename": path.name, "sha256": member["sha256"], "byteLength": len(payload), **raster_metadata(dataset)})
            value = float(next(dataset.sample([(x, y)]))[0])
            observer_inputs[path.name] = value if np.isfinite(value) else None
    profile["sourceSamplesAtObserver"] = observer_inputs
    native = next(member for member in source["files"] if "GLDELEV_" in member["filename"])
    base = json.loads((ROOT/"web/data/terrain-scenes.json").read_text())
    record = next(row for row in base["sites"] if row["siteId"] == site["id"])
    boundary = FrozenBoundary(site, record, (ROOT/"web/data"/record["positionFile"]).read_bytes())
    with rasterio.open(raw/native["filename"]) as dataset:
        header = source["rasterHeader"]
        if list(dataset.shape) != header["shape"] or list(dataset.transform) != header["transform"]:
            raise ValueError("Native SfS grid changed from verified source header")
        east, north = np.meshgrid([-4000, 0, 4000], [-4000, 0, 4000])
        xx, yy = project(*_coordinates(site, east, north))
        bounds = dataset.bounds
        if not np.all((xx >= bounds.left) & (xx < bounds.right) & (yy > bounds.bottom) & (yy <= bounds.top)):
            raise ValueError("Native SfS raster does not cover the full4km display patch")
        point_height = float(next(dataset.sample([(x, y)]))[0])
        sampler = SurfaceSampler(dataset, site, boundary)
        profile["observer"] = observer_height_metadata(site, point_height, sampler)
        clearance = profile["observer"]["cameraAboveInterpolatedSfsM"]
        if not np.isfinite(point_height) or point_height == dataset.nodata or clearance is None or clearance <= 0:
            profile["terrain"] = None
            profile["surfaceStatus"] = "SFS_OBSERVER_CONFLICT"
            profile["surfaceReason"] = "SfS ground intersects the unchanged observer; original LOLA display terrain retained. No vertical offset was applied."
            profile["qualityGates"]["completeFrozenSeam"] = False
            return profile
        for quality, levels in LEVELS.items():
            mesh = build_mesh(site, sampler, levels=levels)
            seam_count = boundary.anchor(mesh["positions"], mesh["gridCoordinatesM"])
            payload, encoded = encode_mesh(mesh["positions"], mesh["indices"])
            filename = f"{site['id']}-{quality}.mesh"
            (output/filename).write_bytes(payload)
            profile["terrain"][quality] = {"positionFile": filename, **encoded, "chunks": mesh["chunks"],
                                            "missingCellCount": mesh["missingCellCount"], "seamVertexCount": seam_count,
                                            "outerHalfExtentM": 4000, "boundaryEqualsFrozenMesh": True,
                                            "boundsM": [mesh["positions"].min(0).tolist(), mesh["positions"].max(0).tolist()]}
    profile["surfaceStatus"] = "SFS_AVAILABLE"
    profile["surfaceReason"] = "Published SfS display patch; original observer and outer LOLA terrain retained."
    return profile


def build_all(raw, output):
    pins = json.loads((output/"source-pins.json").read_text())["records"]
    prototype = build(raw, output)
    bundle = json.loads((ROOT/"web/data/bundle.json").read_text())
    profiles = []
    for site in bundle["sites"]:
        if site["id"] == SITE_ID:
            profile = prototype
            profile.setdefault("surfaceStatus", "SFS_AVAILABLE" if profile["terrain"] else "SFS_OBSERVER_CONFLICT")
        else:
            source = next((row for row in pins if row["siteId"] == site["id"]), None)
            profile = build_region(raw, output, site, source, prototype)
        source = next((row for row in pins if row["siteId"] == site["id"]), None)
        if source:
            x, y = project(site["lat"], site["lon"])
            inputs = {}
            for member in source["files"]:
                with rasterio.open(raw/member["filename"]) as dataset:
                    value = float(next(dataset.sample([(x, y)]))[0])
                    field = next((name for code, name in (("GLDMASK_", "illuminatedImageCount"), ("GLDSBCT_", "solarAzimuthBinCount"), ("GLDBRES_", "bestInputResolutionM")) if code in member["filename"]), None)
                    if field:
                        inputs[field] = value if np.isfinite(value) else None
            profile["observerSfsInputs"] = inputs
            profile["qualityGates"]["imageDerivedDetailAtObserver"] = bool(inputs.get("illuminatedImageCount", 0))
            if not inputs.get("illuminatedImageCount", 0):
                profile["limits"].append("No illuminated SfS input at the observer pixel: the finite regional product retains prior terrain there; improved image-derived local detail is not established.")
        profile["reproduce"] = "PYTHONPATH=.venv/vendor python tools/build_surface_visuals.py --all --acquire"
        profiles.append(profile)
        print(json.dumps({"siteId": site["id"], "status": profile["surfaceStatus"], "observer": profile["observer"]}), flush=True)
    # Retain the prototype fields for consumers using the initial schema1. New
    # consumers select a record from sites; both refer to the same pinned inputs.
    manifest = {**prototype, "sites": profiles}
    (output/"manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True, allow_nan=False)+"\n", encoding="utf-8")
    photo_pins = output/"photo-source-pins.json"
    if photo_pins.is_file():
        manifest = build_photos(raw, output, json.loads(photo_pins.read_text())["records"])
    return manifest


def build(raw, output):
    bundle_bytes = (ROOT/"web/data/bundle.json").read_bytes()
    if digest(bundle_bytes) != BUNDLE_SHA:
        raise ValueError("Analysis bundle differs from protected baseline")
    bundle = json.loads(bundle_bytes)
    site = next(row for row in bundle["sites"] if row["id"] == SITE_ID)
    source_records = []
    for name, expected in PINS.items():
        payload = (raw/name).read_bytes()
        if digest(payload) != expected:
            raise ValueError(f"Changed native source: {name}")
        with rasterio.open(raw/name) as dataset:
            validate_projection(dataset)
            source_records.append({"filename": name, "sha256": expected, "byteLength": len(payload), **raster_metadata(dataset)})
    base = json.loads((ROOT/"web/data/terrain-scenes.json").read_text())
    record = next(row for row in base["sites"] if row["siteId"] == SITE_ID)
    boundary = FrozenBoundary(site, record, (ROOT/"web/data"/record["positionFile"]).read_bytes())
    output.mkdir(parents=True, exist_ok=True)
    terrain = {}
    with rasterio.open(raw/"A301_GLDELEV_005.tif") as dataset:
        if dataset.shape != (4000, 4000) or dataset.transform != rasterio.Affine(5, 0, 147000, 0, -5, 105000):
            raise ValueError("Changed native SfS raster grid")
        x, y = project(site["lat"], site["lon"])
        point_height = float(next(dataset.sample([(x, y)]))[0])
        sampler = SurfaceSampler(dataset, site, boundary)
        observer = observer_height_metadata(site, point_height, sampler)
        clearance = observer["cameraAboveInterpolatedSfsM"]
        if clearance is None or clearance <= 0:
            terrain = None
        for quality, levels in (LEVELS.items() if terrain is not None else []):
            mesh = build_mesh(site, sampler, levels=levels)
            seam_count = boundary.anchor(mesh["positions"], mesh["gridCoordinatesM"])
            payload, encoded = encode_mesh(mesh["positions"], mesh["indices"])
            filename = f"{SITE_ID}-{quality}.mesh"
            (output/filename).write_bytes(payload)
            terrain[quality] = {"positionFile": filename, **encoded, "chunks": mesh["chunks"],
                                "missingCellCount": mesh["missingCellCount"], "seamVertexCount": seam_count,
                                "outerHalfExtentM": 4000, "boundaryEqualsFrozenMesh": True,
                                "boundsM": [mesh["positions"].min(0).tolist(), mesh["positions"].max(0).tolist()]}
    with rasterio.open(raw/NAC_CROP) as photo:
        validate_projection(photo)
        pixels = photo.read(1)
        if photo.shape != (2000, 2000) or digest(pixels.tobytes()) != NAC_PIXEL_SHA or photo.transform != NAC_TRANSFORM:
            raise ValueError("NAC crop registration or pixels changed")
        valid = (photo.read_masks(1) > 0) & (pixels > 0)
        textures, masks = {}, {}
        for quality, size in (("desktop", 2000), ("mobile", 1000)):
            image = Image.fromarray(pixels)
            mask = Image.fromarray(valid.astype(np.uint8)*255)
            if size != 2000:
                image = image.resize((size, size), Image.Resampling.LANCZOS)
                mask = mask.resize((size, size), Image.Resampling.BOX).point(lambda value: 255 if value == 255 else 0)
            texture_path = output/f"{SITE_ID}-photo-{quality}.webp"
            mask_path = output/f"{SITE_ID}-photo-mask-{quality}.png"
            image.save(texture_path, format="WEBP", quality=92, method=6)
            mask.save(mask_path, optimize=True)
            textures[quality] = file_record(texture_path, width=size, height=size, metersPerPixel=2000/size)
            masks[quality] = file_record(mask_path, width=size, height=size, validFraction=float(np.asarray(mask).mean()/255))
        native_bounds = list(photo.bounds)
        imagery = {"bounds": [native_bounds[0]-2, native_bounds[1]-7, native_bounds[2]-2, native_bounds[3]-7],
                   "nativeBounds": native_bounds, "textures": textures, "masks": masks,
                   "nativeRaster": raster_metadata(photo), "sourceUrl": NAC_URL,
                   "sourceRangeBytes": list(NAC_RANGE), "sourceRangeSha256": NAC_RANGE_SHA,
                   "sourcePixelSha256": NAC_PIXEL_SHA, "historicIllumination": True,
                   "photometricAlbedo": False, "validFraction": float(valid.mean()),
                   "nativeResolutionM": 1, "product": "NAC_ROI_NOBILE02LOC_P839S0587",
                   "registration": {"scope": "Derived display placement only; native pixels and geotransform unchanged",
                                    "projectedEastOffsetM": -2, "projectedNorthOffsetM": -7,
                                    "derivedDisplayTransform": list(rasterio.Affine(1, 0, NAC_TRANSFORM.c-2, 0, -1, NAC_TRANSFORM.f-7)),
                                    "method": "Independent normalized cross-correlation of intensity and spatial gradients against the registered SfS orthomosaic; analytic sign fixture checked",
                                    "reference": "A301_GLDOMOS_005.tif", "referenceSha256": "6ad04e5b6669bd222f7528c82b7a09ef92419a11cd625e55522df30e4b0a40f3",
                                    "intensityNcc": .831, "fourQuadrantGradientInternalRmsM": 2.49,
                                    "limits": "Internal image alignment is not absolute physical control: published5–20m uncertainty,10m reference pixels and different baked illumination remain. No1m position-accuracy claim."},
                   "projection": {"kind": "south-polar-stereographic", "radiusM": RADIUS_M, "centralMeridianDeg": 0, "latitudeOriginDeg": -90},
                   "uvConvention": "u=(projectedX-xmin)/(xmax-xmin); v=(projectedY-ymin)/(ymax-ymin). Image row zero is north/ymax; Three.js TextureLoader flipY=true. Outside bounds is unavailable, never repeat."}
    manifest = {"schemaVersion": 1, "kind": "Display-only registered NASA surface detail",
                "analysisBundleSha256": BUNDLE_SHA, "site": {"id": site["id"], **{key: site[key] for key in ("lat", "lon", "groundM", "heightM")}},
                "frame": bundle["manifest"]["frame"]["working"], "referenceRadiusM": RADIUS_M,
                "coordinateConvention": "x=eastM, y=radialUpM above unchanged baseline ground, z=-northM",
                "terrain": terrain, "imagery": imagery, "sourceRasters": source_records,
                "sourceArchive": {"url": ARCHIVE_URL, "byteLength": ARCHIVE_BYTES, "publisherMd5": ARCHIVE_MD5,
                                  "acquiredUtcDate": "2026-11-15", "version": "1.0.0",
                                  "fullArchiveDownloaded": False, "fullArchiveMd5Verified": False, "memberCrcAndSha256Verified": True},
                "sourceFrameBasis": "PGDA104 retains the LOLA geodetic reference; PGDA78 declares DE421 MOON_ME. Raster WKT itself names Moon2015 sphere, not a DE ephemeris. No additional frame rotation applied.",
                "datum": "Radial heights in metres relative to sphere radius1737400m",
                "observer": observer,
                "transition": {"innerHalfExtentM": 3500, "outerHalfExtentM": 4000,
                               "method": "Display-only smoothstep height blend to frozen LOLA mesh; all512 outer seam vertices copied byte-exact. Original4–32km mesh and analytical skyline unchanged."},
                "sources": [{"url": "https://pgda.gsfc.nasa.gov/products/104", "doi": "10.3847/PSJ/ae5b70", "license": "CC-BY-4.0 (Zenodo record)"},
                            {"url": "https://zenodo.org/records/17954508", "doi": "10.5281/zenodo.17954508"},
                            {"url": "https://pgda.gsfc.nasa.gov/products/78"}, {"url": NAC_URL, "credit": "NASA/GSFC/Arizona State University LROC"}],
                "qualityGates": {"nativeSourceHashes": True, "lunarProjectionAndAreaRegistration": True, "siteInsideSources": True,
                                 "completeFrozenSeam": bool(terrain), "baselineObserverPreserved": True, "visibilityEngineChanged": False},
                "limits": ["Display geometry only. The frozen terrain-aware visibility engine and bundle remain authoritative.",
                           "SfS slopes are reconstructed from images over LOLA control; 5m posting is not a blanket5m physical-accuracy claim. Shadowed/poorly observed areas may retain smoother prior terrain.",
                           "The single1m NAC mosaic records historical illumination and shadows; it is not albedo or a current-epoch shadow simulation. It covers only the documented2km square.",
                           "Different source coordinate grids are preserved individually: SfS DEM5m; archive orthomosaic10m; count/solar-bin/best-resolution maps15m. The archiveorthomosaic is not used as the photo texture.",
                           "The3500–4000m transition belt is a declared display blend, not a new scientific terrain model."],
                "reproduce": "PYTHONPATH=.venv/vendor python tools/build_surface_visuals.py --acquire",
                "aiUse": "OpenAI Codex assisted source inspection, deterministic conversion, implementation and tests. Assets derive from credited NASA rasters, without generated topography."}
    path = output/"manifest.json"
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True, allow_nan=False)+"\n", encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=ROOT/"data/raw/surface")
    parser.add_argument("--output", type=Path, default=ROOT/"web/assets/surface")
    parser.add_argument("--acquire", action="store_true")
    parser.add_argument("--all", action="store_true", help="Build all source-covered sites; retain explicit original-LOLA fallbacks")
    parser.add_argument("--photos-only", action="store_true", help="Update photographic derivatives without rebuilding valid meshes")
    args = parser.parse_args()
    if args.acquire:
        acquire(args.raw)
        if args.all:
            acquire_pinned_regions(args.raw, json.loads((args.output/"source-pins.json").read_text())["records"])
        if (args.output/"photo-source-pins.json").is_file():
            acquire_photos(args.raw, json.loads((args.output/"photo-source-pins.json").read_text())["records"])
    manifest = build_photos(args.raw, args.output, json.loads((args.output/"photo-source-pins.json").read_text())["records"]) if args.photos_only else build_all(args.raw, args.output) if args.all else build(args.raw, args.output)
    print(json.dumps({"site": manifest["site"], "observer": manifest["observer"],
                      "terrain": {key: {field: value[field] for field in ("vertexCount", "indexCount", "byteLength", "sha256")} for key, value in (manifest["terrain"] or {}).items()},
                      "textures": manifest["imagery"]["textures"]}, indent=2))


if __name__ == "__main__":
    main()
