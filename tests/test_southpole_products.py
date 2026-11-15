"""Additive south-pole meshes must preserve the frozen four-site display."""
import copy
import importlib
import json
import os
import sys
from hashlib import sha256
from pathlib import Path
from types import ModuleType

import numpy as np
import pytest

from science.ephemerides import FRAME
from science.sources import REGIONAL, SITE_SOURCE
from science.terrain import RADIUS_M, project

ROWS = (
    ("nobile-rim-1", "Nobile Rim 1", "Nobile Rim 1 ? PGDA Site06", -85.4381, 37.36667, "Site06"),
    ("malapert-massif", "Malapert Massif", "Malapert Massif ? PGDA Site23", -85.9948, 359.76422, "Site23"),
    ("leibnitz-beta-plateau", "Leibnitz Beta Plateau", "Leibnitz Beta Plateau ? PGDA Site20", -85.4266, 31.74276, "Site20"),
    ("de-gerlache-kocher", "de Gerlache-Kocher Massif", "de Gerlache-Kocher Massif ? PGDA Site42", -85.8296, 243.678, "Site42"),
    ("haworth", "Haworth", "Haworth ? PGDA Haworth", -86.7639, 337.223, "Haworth"),
    ("nobile-rim-2", "Nobile Rim 2", "Nobile Rim 2 ? PGDA DM2", -83.954, 58.82206, "DM2"),
)
OUTER = "LDEM_60S_240MPP_ADJ.TIF"
ROOT = Path(__file__).resolve().parents[1]


def products():
    return importlib.import_module("science.southpole_products")


def pin(filename, payload=b"synthetic source"):
    return {"filename": filename, "bytes": len(payload), "sha256": sha256(payload).hexdigest(),
            "url": "https://pgda.gsfc.nasa.gov/data/" + filename,
            "citation": "https://pgda.gsfc.nasa.gov/products/90" if filename == OUTER else "https://pgda.gsfc.nasa.gov/products/78",
            "acquiredUtc": "2026-11-15T12:00:00+00:00", "publisherChecksumAvailable": False,
            "checksumOrigin": "Synthetic test fixture, not NASA data"}


@pytest.fixture
def registry(monkeypatch):
    module = ModuleType("science.southpole_sites")
    module.SOUTHPOLE_SITES = ROWS
    module.SOURCE_PINS = [pin(f"{row[5]}_final_adj_5mpp_surf.tif") for row in ROWS] + [pin(OUTER)]
    monkeypatch.setitem(sys.modules, "science.southpole_sites", module)
    return module


def expanded_bundle(registry, *, grounds=None):
    result = json.loads((ROOT / "web/data/bundle.json").read_bytes())
    # Existing extended bundle has the original four study points.
    assert len(result["sites"]) == 4
    grounds = grounds or {}
    for row in ROWS:
        ground = grounds.get(row[0], 100.)
        model = {"local": {"filename": f"{row[5]}_final_adj_5mpp_surf.tif"},
                 "regional": {"filename": REGIONAL}, "outerRegional": {"filename": OUTER},
                 "groundM": ground, "observerRadiusM": RADIUS_M + ground + 2.}
        result["sites"].append({"id": row[0], "name": row[1], "lat": row[3], "lon": row[4],
                                "heightM": 2., "groundM": ground, "referenceRadiusM": RADIUS_M,
                                "source": SITE_SOURCE, "sourceFrame": "DE421 MOON_ME", "workingFrame": FRAME,
                                "coordinateStatus": "Published region center", "terrain": {"coarse": copy.deepcopy(model), "fine": copy.deepcopy(model)}})
    result["manifest"]["files"].extend(copy.deepcopy(registry.SOURCE_PINS))
    return result


def test_new_products_module_has_required_callable():
    assert callable(products().append_products)


def test_scene_registry_accepts_exact_six_new_points_and_source_pins(registry):
    terrain = importlib.import_module("science.scene_terrain")
    bundle = expanded_bundle(registry)
    assert [r[0] for r in terrain.scene_site_rows(bundle)][-6:] == [r[0] for r in ROWS]
    for record in registry.SOURCE_PINS:
        actual = terrain.terrain_source_spec(record["filename"])
        assert actual["sha256"] == record["sha256"]
        assert actual["expectedBytes"] == record["bytes"]
    with pytest.raises(ValueError, match="Unsupported native terrain source"):
        terrain.terrain_source_spec("unregistered.tif")


@pytest.mark.parametrize("mutation", ["coordinate", "observer", "frame", "local", "regional", "outer", "pin", "missing_outer_pin", "duplicate"])
def test_new_scene_registry_fails_closed_on_identity_or_source_changes(registry, mutation):
    terrain = importlib.import_module("science.scene_terrain")
    bundle = expanded_bundle(registry)
    site = bundle["sites"][-1]
    if mutation == "coordinate": site["lat"] += 0.00001
    elif mutation == "observer": site["heightM"] = 5.
    elif mutation == "frame": site["sourceFrame"] = "IAU_MOON"
    elif mutation == "local": site["terrain"]["fine"]["local"]["filename"] = "Site06_final_adj_5mpp_surf.tif"
    elif mutation == "regional": site["terrain"]["coarse"]["regional"]["filename"] = OUTER
    elif mutation == "outer": site["terrain"]["fine"]["outerRegional"]["filename"] = REGIONAL
    elif mutation == "pin": bundle["manifest"]["files"][-1]["sha256"] = "0" * 64
    elif mutation == "missing_outer_pin": bundle["manifest"]["files"].pop()
    elif mutation == "duplicate": bundle["sites"].append(copy.deepcopy(site))
    with pytest.raises(ValueError): terrain.scene_site_rows(bundle)


def prepare_baseline(tmp_path):
    baseline = tmp_path / "baseline"
    baseline.mkdir()
    metadata = json.loads((ROOT / "web/data/terrain-scenes.json").read_bytes())
    for record in metadata["sites"]:
        payload = (ROOT / "web/data" / record["positionFile"]).read_bytes()
        (baseline / record["positionFile"]).write_bytes(payload)
    (baseline / "terrain-scenes.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return baseline, metadata


def test_append_preserves_baseline_bytes_records_and_exact_bundle_file_hash(tmp_path, registry, monkeypatch):
    module = products()
    baseline, frozen = prepare_baseline(tmp_path)
    bundle = expanded_bundle(registry)
    bundle_path = tmp_path / "bundle.json"
    bundle_path.write_text(json.dumps(bundle, separators=(",", ":")) + "\n", encoding="utf-8")
    expected = sha256(bundle_path.read_bytes()).hexdigest()
    checked = []
    def fake_source(raw, filename):
        checked.append(filename)
        spec = module.terrain.terrain_source_spec(filename)
        return {**spec, "bytes": spec["expectedBytes"], "raster": {"spacingM": 240 if filename == OUTER else 80 if filename == REGIONAL else 5}}
    monkeypatch.setattr(module.terrain, "checked_terrain_source", fake_source)
    class Raster:
        def __enter__(self): return self
        def __exit__(self, *args): return False
    monkeypatch.setattr(module.terrain.rasterio, "open", lambda path: Raster())
    class Sampler:
        def __init__(self, local, regional, site): self.ground = site["groundM"]
        def sample(self, east, north): return np.full(np.asarray(east).shape, self.ground), np.ones(np.asarray(east).shape, dtype=bool)
    monkeypatch.setattr(module.terrain, "TerrainSampler", Sampler)
    calls = []
    def mesh(site, sampler):
        calls.append(site["id"])
        return {"positions": np.array([[0., 0., 0.], [1., 0., 0.], [0., 0., -1.]]), "indices": np.array([0, 1, 2], dtype=np.uint32),
                "chunks": [{"name": "synthetic"}], "missingCellCount": 0, "elevationRangeM": [site["groundM"], site["groundM"]]}
    monkeypatch.setattr(module.terrain, "build_mesh", mesh)
    output = tmp_path / "out"
    actual = module.append_products(tmp_path, baseline, bundle_path, output)
    assert calls == [row[0] for row in ROWS]
    assert actual["sites"][:4] == frozen["sites"]
    assert actual["sources"][:len(frozen["sources"])] == frozen["sources"]
    assert actual["bundleSha256"] == expected
    assert len(actual["sites"]) == 10
    for record in frozen["sites"]:
        assert (output / record["positionFile"]).read_bytes() == (baseline / record["positionFile"]).read_bytes()
    source_names = [record["filename"] for record in actual["sources"]]
    assert len(source_names) == len(set(source_names))
    assert {record["filename"] for record in registry.SOURCE_PINS} <= set(source_names)
    markers = json.loads((output / "southpole-markers.json").read_bytes())
    assert [(r["id"], r["name"], r["lat"], r["lon"]) for r in markers] == [(r[0], r[1], r[3], r[4]) for r in ROWS]
    assert all(marker["capability"] == "terrain-aware" and marker["source"] == SITE_SOURCE for marker in markers)
    assert json.loads((output / "terrain-scenes.json").read_bytes()) == actual
    # A changed existing output must never be silently overwritten.
    (output / frozen["sites"][0]["positionFile"]).write_bytes(b"changed")
    with pytest.raises(ValueError, match="existing|Existing"):
        module.append_products(tmp_path, baseline, bundle_path, output)


def test_mutated_baseline_mesh_rejected_before_output(tmp_path, registry):
    module = products()
    baseline, metadata = prepare_baseline(tmp_path)
    (baseline / metadata["sites"][0]["positionFile"]).write_bytes(b"not the frozen mesh")
    bundle = tmp_path / "bundle.json"
    bundle.write_text(json.dumps(expanded_bundle(registry)), encoding="utf-8")
    output = tmp_path / "out"
    with pytest.raises(ValueError, match="baseline|Baseline"):
        module.append_products(tmp_path, baseline, bundle, output)
    assert not output.exists()


def test_actual_native_sources_generate_six_additive_meshes(tmp_path, registry):
    raw_name, pins_name = os.environ.get("LUNARIS_SOUTHPOLE_RAW"), os.environ.get("LUNARIS_SOUTHPOLE_PINS")
    if not raw_name or not pins_name:
        pytest.skip("Set LUNARIS_SOUTHPOLE_RAW and LUNARIS_SOUTHPOLE_PINS for the actual NASA-data mesh check")
    import rasterio
    raw = Path(raw_name)
    registry.SOURCE_PINS = json.loads(Path(pins_name).read_bytes())
    grounds = {}
    for row in ROWS:
        path = raw / f"{row[5]}_final_adj_5mpp_surf.tif"
        if not path.exists(): pytest.skip(f"Missing actual NASA raster: {path.name}")
        with rasterio.open(path) as d:
            x, y = project(row[3], row[4])
            grounds[row[0]] = float(next(d.sample([(x, y)]))[0])
    bundle = tmp_path / "bundle.json"
    bundle.write_text(json.dumps(expanded_bundle(registry, grounds=grounds), indent=2) + "\n", encoding="utf-8")
    baseline, frozen = prepare_baseline(tmp_path)
    actual = products().append_products(raw, baseline, bundle, tmp_path / "out")
    assert actual["sites"][:4] == frozen["sites"]
    for record in actual["sites"][4:]:
        payload = (tmp_path / "out" / record["positionFile"]).read_bytes()
        positions = np.frombuffer(payload, dtype="<f4", count=3*record["vertexCount"]).reshape(-1, 3)
        indices = np.frombuffer(payload, dtype="<u4", offset=record["indicesByteOffset"])
        assert record["sha256"] == sha256(payload).hexdigest()
        assert np.isfinite(positions).all() and len(indices) > 0
        assert indices.max() < len(positions)
        assert record["groundM"] == grounds[record["siteId"]]
        assert record["heightM"] == 2.
        assert record["chunks"][-1]["nativeSourceSpacingM"] == 80
