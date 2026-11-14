"""Pinned NASA source locations and reproducible, checked acquisition."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from hashlib import file_digest
import json
from pathlib import Path
import re
import time
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


def _range(url, start, end, size):
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
    root.mkdir(parents=True, exist_ok=True)
    for name, (url, size, _) in FILES.items():
        if prefixes and not any(name.startswith(prefix) for prefix in prefixes):
            continue
        path = root / name
        if path.is_file() and path.stat().st_size == size:
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
                    for offset, body in workers.map(lambda span: _range(url, *span, size), spans[i:i + 6]):
                        stream.seek(offset)
                        stream.write(body)
        if part.stat().st_size != size:
            raise ValueError(f"{name}: expected {size} bytes")
        part.replace(path)
        print(f"Verified byte count: {name}", flush=True)


def source_manifest(root):
    entries = []
    for name, (url, size, citation) in FILES.items():
        path = root / name
        stat = path.stat()
        if stat.st_size != size:
            raise ValueError(f"{name}: received {stat.st_size} bytes, expected {size}")
        with path.open("rb") as stream:
            checksum = file_digest(stream, "sha256").hexdigest()
        entries.append({
            "filename": name,
            "url": url,
            "citation": citation,
            "bytes": size,
            "sha256": checksum,
            "local_file_acquired_utc": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
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
    args = parser.parse_args()
    if args.manifest:
        print(json.dumps(source_manifest(args.raw), indent=2))
    else:
        fetch(args.raw, args.prefix)
