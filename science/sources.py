"""Pinned NASA source locations and reproducible, checked acquisition."""

import argparse
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from hashlib import file_digest
from pathlib import Path
from urllib.request import Request, urlopen

PGDA = "https://pgda.gsfc.nasa.gov"
NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
REGIONAL = "LDEM_80S_80MPP_ADJ.TIF"
SITES = (
    ("connecting-ridge", "Connecting Ridge", "Connecting Ridge · PGDA Site 01", -89.4632, 222.510, "Site01"),
    ("shackleton-rim", "Shackleton Rim", "Shackleton crater · PGDA Site 04", -89.7668, 188.130, "Site04"),
    ("de-gerlache-rim", "de Gerlache Rim 1", "de Gerlache crater · PGDA Site 11", -88.6834, 292.0679, "Site11"),
)
SITE_SOURCE = "https://ntrs.nasa.gov/citations/20250002845"
FILES = {
    REGIONAL: (f"{PGDA}/data/LOLA_20mpp/{REGIONAL}", 189158392, f"{PGDA}/products/90"),
    "Site01_final_adj_5mpp_surf.tif": (
        f"{PGDA}/data/LOLA_5mpp/Site01/Site01_final_adj_5mpp_surf.tif", 40980810, f"{PGDA}/products/78",
    ),
    "Site04_final_adj_5mpp_surf.tif": (
        f"{PGDA}/data/LOLA_5mpp/Site04/Site04_final_adj_5mpp_surf.tif", 40980806, f"{PGDA}/products/78",
    ),
    "Site11_final_adj_5mpp_surf.tif": (
        f"{PGDA}/data/LOLA_5mpp/Site11/Site11_final_adj_5mpp_surf.tif", 40980806, f"{PGDA}/products/78",
    ),
    "de440s.bsp": (f"{NAIF}/spk/planets/de440s.bsp", 32726016, "https://doi.org/10.3847/1538-3881/abd414"),
    "moon_pa_de440_200625.bpc": (f"{NAIF}/pck/moon_pa_de440_200625.bpc", 12863488, f"{NAIF}/pck/"),
    "moon_de440_250416.tf": (f"{NAIF}/fk/satellites/moon_de440_250416.tf", 19478, f"{NAIF}/fk/satellites/"),
    "naif0012.tls": (f"{NAIF}/lsk/naif0012.tls", 5257, f"{NAIF}/lsk/"),
}
SHA256 = {
    REGIONAL: "82030dcbdd7c4bb0c7d858e9b4b293b9f2cda5a543ba31ec0f42784bd6beee5a",
    "Site01_final_adj_5mpp_surf.tif": "3ba7b97cb00a2bcf21189c3aeb535f65afc21207154ab9f0d43c5bdc1f7e747e",
    "Site04_final_adj_5mpp_surf.tif": "38ff70dbdf2f066c2cfa94a646c3a59d653ce7f6b4528b15fc1b43ee397ce758",
    "Site11_final_adj_5mpp_surf.tif": "58f3372c35bbd6baf38ffd5633c1c96b59bd89dbd252150581d12893a43136e5",
    "de440s.bsp": "c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2",
    "moon_pa_de440_200625.bpc": "60cd55aa401ea2ea97360636f567554bfe4e37bb829f901b4460a455dfaf783f",
    "moon_de440_250416.tf": "a47c71e9c9f33796bdafb2c9d69a7ee447b6016ecad80f71cd6f3e479f9cf768",
    "naif0012.tls": "678e32bdb5a744117a467cd9601cd6b373f0e9bc9bbde1371d5eee39600a039b",
}
# Original local acquisition timestamps from the verified November release.
# Preserve provenance on rebuilds when newly downloaded bytes match the pins.
ACQUIRED_UTC = {
    REGIONAL: "2026-11-14T06:12:13.494318+00:00",
    "Site01_final_adj_5mpp_surf.tif": "2026-11-14T06:14:21.992905+00:00",
    "Site04_final_adj_5mpp_surf.tif": "2026-11-14T06:14:39.661391+00:00",
    "Site11_final_adj_5mpp_surf.tif": "2026-11-14T06:14:33.327541+00:00",
    "de440s.bsp": "2026-11-14T06:12:27.445103+00:00",
    "moon_pa_de440_200625.bpc": "2026-11-14T06:12:32.300673+00:00",
    "moon_de440_250416.tf": "2026-11-14T06:12:28.191050+00:00",
    "naif0012.tls": "2026-11-14T06:12:27.991396+00:00",
}
CLONES = {
    "0001": (40987163, "251b610f015194c625439a84edf07c14ea9f8112238a38e90173319546118637",
             "2026-11-14T06:47:35Z"),
    "0002": (40987159, "3c2cf20ec6e594ecb2802ed253a65a299a5476e23829f3feec08ee7c9d44427b",
             "2026-11-14T06:48:17Z"),
}


def _sha256(path):
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def _range(span, *, url, size):
    start, end = span
    last_error = None
    for attempt in range(3):
        try:
            request = Request(url, headers={"Range": f"bytes={start}-{end}", "Accept-Encoding": "identity"})
            with urlopen(request, timeout=45) as response:
                expected = f"bytes {start}-{end}/{size}"
                actual = response.headers.get("content-range")
                if response.status != 206 or actual != expected:
                    raise ValueError(f"Unexpected response {response.status} {actual!r} for {expected}")
                body = response.read(end - start + 2)
                if len(body) != end - start + 1:
                    raise ValueError(f"Truncated range from {url} at {start}")
                return start, body
        except (OSError, ValueError) as error:
            last_error = error
            time.sleep(attempt + 1)
    raise RuntimeError(f"Could not retrieve {url} bytes {start}-{end}") from last_error


def fetch(root, prefixes):
    entries = [(name, url, size, SHA256[name]) for name, (url, size, _) in FILES.items()
               if not prefixes or any(name.startswith(prefix) for prefix in prefixes)]
    _fetch(root, entries)


def _fetch(root, entries):
    root.mkdir(parents=True, exist_ok=True)
    for name, url, size, digest in entries:
        path = root / name
        if path.is_file() and path.stat().st_size == size and _sha256(path) == digest:
            print(f"Already present: {name}", flush=True)
            continue
        part = path.with_suffix(path.suffix + ".download")
        step = 4 * 1024 * 1024
        print(f"Downloading {name} ({size:,} bytes)", flush=True)
        with part.open("wb") as stream, ThreadPoolExecutor(max_workers=6) as workers:
            if size < step:
                with urlopen(url, timeout=45) as response:
                    stream.write(response.read(size + 1))
            else:
                spans = [(start, min(size - 1, start + step - 1)) for start in range(0, size, step)]
                # Bound memory even if an early range retries while later ones complete.
                for i in range(0, len(spans), 6):
                    for offset, body in workers.map(partial(_range, url=url, size=size), spans[i:i + 6]):
                        stream.seek(offset)
                        stream.write(body)
        if part.stat().st_size != size or _sha256(part) != digest:
            raise ValueError(f"{name}: bytes or SHA-256 mismatch with the pinned archive")
        part.replace(path)
        print(f"Verified bytes and SHA-256: {name}", flush=True)


def clone_manifest(root, *, download=False):
    products = []
    for clone, (size, digest, acquired) in CLONES.items():
        name = f"Site11_final_adj_5mpp_{clone}_err.tif"
        url = f"{PGDA}/data/LOLA_5mpp/Site11/Clones/{name}"
        if download:
            _fetch(root, [(name, url, size, digest)])
        path = root / name
        if path.stat().st_size != size or _sha256(path) != digest:
            raise ValueError(f"{name}: bytes or SHA-256 mismatch with the pinned archive")
        products.append({
            "clone": clone, "filename": name, "url": url, "bytes": size, "sha256": digest,
            "local_file_acquired_utc": acquired, "product_version": f"PGDA Site11 clone {clone}",
            "citation": "https://doi.org/10.1016/j.pss.2020.105119",
            "use": "Local 5 m absolute radial elevation realization in metres",
            "access": "NASA public archive. Cite the publisher and linked product.",
        })
    return products


def source_manifest(root):
    entries = []
    for name, (url, size, citation) in FILES.items():
        path = root / name
        stat = path.stat()
        if stat.st_size != size:
            raise ValueError(f"{name}: received {stat.st_size} bytes, expected {size}")
        checksum = _sha256(path)
        if checksum != SHA256[name]:
            raise ValueError(f"{name}: SHA-256 mismatch with the pinned archive")
        entries.append({
            "filename": name,
            "url": url,
            "citation": citation,
            "bytes": size,
            "sha256": checksum,
            "local_file_acquired_utc": ACQUIRED_UTC[name],
            "product_version": re.sub(r"\.[^.]+$", "", name),
            "use": "DE421 ME radial-height raster in metres" if name.lower().endswith(".tif") else "JPL SPICE kernel",
            "access": "NASA public archive. Cite the publisher and linked product.",
        })
    return entries


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=Path("data/raw"))
    parser.add_argument("--prefix", action="append")
    parser.add_argument("--manifest", action="store_true")
    parser.add_argument("--clones", action="store_true", help="Include two pinned regional-study local DEM realizations")
    args = parser.parse_args()
    if args.manifest:
        records = source_manifest(args.raw)
        if args.clones:
            records.extend(clone_manifest(args.raw / "clones"))
        print(json.dumps(records, indent=2))
    else:
        fetch(args.raw, args.prefix)
        if args.clones:
            clone_manifest(args.raw / "clones", download=True)
