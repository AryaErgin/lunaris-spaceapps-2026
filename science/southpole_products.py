"""Append six pinned south-pole display meshes without rebuilding the frozen four.

The input bundle is a JSON file: bundleSha256 always hashes those exact bytes.
Display meshes sample local 5 m and existing regional 80 m terrain only. The
240 m outer-horizon source is identified separately and never used as display
terrain. No visibility or mission status is calculated by this module.
"""
from __future__ import annotations

import argparse
import copy
import json
from hashlib import sha256
from pathlib import Path

import numpy as np

from science import scene_terrain as terrain
from science.sources import REGIONAL


def _json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")


def _frozen_baseline(baseline_dir, bundle_sites):
    """Authenticate existing binary files and their exact four site records."""
    baseline = json.loads((baseline_dir / "terrain-scenes.json").read_bytes())
    records = baseline.get("sites", [])
    from science.extended_sites import EXTENDED_SITES
    from science.sources import SITES
    expected = {row[0] for row in (*SITES, *EXTENDED_SITES)}
    if len(records) != 4 or {record.get("siteId") for record in records} != expected:
        raise ValueError("Baseline must contain the original four display sites exactly once")
    payloads = {}
    for record in records:
        identifier, filename = record["siteId"], record["positionFile"]
        if filename != f"terrain-{identifier}.mesh":
            raise ValueError(f"Unexpected baseline mesh filename: {filename}")
        payload = (baseline_dir / filename).read_bytes()
        if len(payload) != record["byteLength"] or sha256(payload).hexdigest() != record["sha256"]:
            raise ValueError(f"Changed baseline mesh bytes or hash: {filename}")
        current = bundle_sites.get(identifier, {})
        for key in ("lat", "lon", "groundM", "heightM"):
            if record.get(key) != current.get(key):
                raise ValueError(f"Changed baseline display observer: {identifier}/{key}")
        payloads[filename] = payload
    return baseline, payloads


def append_products(raw, baseline_dir, bundle, outdir):
    """Create only the six new meshes and carry original files/records unchanged.

    All identity, source, baseline and output-conflict checks complete before
    publishing files. A repeated run is allowed only when existing mesh bytes
    are identical; it never overwrites a different mesh.
    """
    raw, baseline_dir, outdir = Path(raw), Path(baseline_dir), Path(outdir)
    if not isinstance(bundle, (str, Path)):
        raise TypeError("bundle must be the serialized JSON file path")
    bundle_bytes = Path(bundle).read_bytes()
    document = json.loads(bundle_bytes)
    sites = {site["id"]: site for site in document.get("sites", [])}
    # Baseline mutation errors must be reported before any output or raw reads.
    baseline, payloads = _frozen_baseline(baseline_dir, sites)
    rows = terrain.scene_site_rows(document)
    southpole, _ = terrain._southpole_registry()
    wanted = [row[0] for row in southpole]
    if len(wanted) != 6 or len(set(wanted)) != 6:
        raise ValueError("The south-pole extension requires six unique registered study points")
    baseline_ids = {record["siteId"] for record in baseline["sites"]}
    if set(sites) != baseline_ids | set(wanted) or len(rows) != 10:
        raise ValueError("Bundle must contain the original four and exact six additional study points")
    metadata = copy.deepcopy(baseline)
    source_names = [record.get("filename") for record in metadata.get("sources", [])]
    if len(source_names) != len(set(source_names)) or REGIONAL not in source_names:
        raise ValueError("Baseline source metadata is missing or duplicated")
    # Verify original sources while retaining their published metadata verbatim.
    for record in metadata["sources"]:
        checked = terrain.checked_terrain_source(raw, record["filename"])
        if record.get("sha256") != checked["sha256"] or record.get("bytes") != checked["bytes"]:
            raise ValueError(f"Changed baseline source metadata: {record['filename']}")
    new_sources = [f"{row[5]}_final_adj_5mpp_surf.tif" for row in southpole]
    new_sources.append(terrain.SOUTHPOLE_OUTER_REGIONAL)
    for filename in new_sources:
        checked = terrain.checked_terrain_source(raw, filename)
        if filename in source_names:
            raise ValueError(f"New source already appears in the frozen baseline: {filename}")
        if filename == terrain.SOUTHPOLE_OUTER_REGIONAL:
            checked["use"] = "Scientific outer-horizon source only; not sampled by this 32 km display mesh"
        metadata["sources"].append(checked)
        source_names.append(filename)
    with terrain.rasterio.open(raw / REGIONAL) as regional:
        for row in southpole:
            site = sites[row[0]]
            with terrain.rasterio.open(raw / f"{row[5]}_final_adj_5mpp_surf.tif") as local:
                sampler = terrain.TerrainSampler(local, regional, site)
                ground, valid = sampler.sample(np.array([0.]), np.array([0.]))
                if not valid[0] or float(ground[0]) != site["groundM"]:
                    raise ValueError(f"Bundle ground anchor differs from native local DEM: {row[0]}")
                mesh = terrain.build_mesh(site, sampler)
            payload, encoding = terrain.encode_mesh(mesh["positions"], mesh["indices"])
            filename = f"terrain-{row[0]}.mesh"
            payloads[filename] = payload
            metadata["sites"].append({"siteId": row[0], "positionFile": filename, **encoding,
                                      "lat": site["lat"], "lon": site["lon"], "groundM": site["groundM"],
                                      "heightM": site["heightM"], "chunks": mesh["chunks"],
                                      "missingCellCount": mesh["missingCellCount"],
                                      "elevationRangeM": mesh["elevationRangeM"],
                                      "boundsM": [mesh["positions"].min(0).tolist(), mesh["positions"].max(0).tolist()]})
    metadata["bundleSha256"] = sha256(bundle_bytes).hexdigest()
    markers = [{"id": identifier, "name": sites[identifier]["name"],
                "lat": sites[identifier]["lat"], "lon": sites[identifier]["lon"],
                "capability": "terrain-aware", "source": sites[identifier]["source"]}
               for identifier in wanted]
    for filename, payload in payloads.items():
        destination = outdir / filename
        if destination.exists() and destination.read_bytes() != payload:
            raise ValueError(f"Existing mesh differs; refusing overwrite: {filename}")
    # Serialize before writes so non-finite or malformed metadata fails closed.
    metadata_bytes, marker_bytes = _json_bytes(metadata), _json_bytes(markers)
    outdir.mkdir(parents=True, exist_ok=True)
    for filename, payload in payloads.items():
        destination = outdir / filename
        if not destination.exists():
            destination.write_bytes(payload)
    (outdir / "terrain-scenes.json").write_bytes(metadata_bytes)
    (outdir / "southpole-markers.json").write_bytes(marker_bytes)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=Path("data/raw"))
    parser.add_argument("--baseline-dir", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    metadata = append_products(args.raw, args.baseline_dir, args.bundle, args.output)
    print(json.dumps({"siteCount": len(metadata["sites"]), "bundleSha256": metadata["bundleSha256"],
                      "meshes": [{key: item[key] for key in ("siteId", "byteLength", "sha256", "missingCellCount")}
                                 for item in metadata["sites"][4:]]}, indent=2))


if __name__ == "__main__":
    main()
