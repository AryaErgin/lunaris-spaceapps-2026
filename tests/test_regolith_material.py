"""Integrity of representative display material, never mission evidence."""
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

ASSETS = Path(__file__).resolve().parents[1] / "web/assets/surface/material"


def test_material_declares_its_scale_and_non_geographic_scope():
    manifest = json.loads((ASSETS / "manifest.json").read_text())
    assert manifest["schemaVersion"] == 1
    assert manifest["kind"] == "laboratory-regolith-simulant"
    assert manifest["displayOnly"] is True
    assert manifest["displacementApplied"] is False
    assert manifest["tileWidthM"] == 3.1000001430511475
    assert manifest["sourceUrl"] == "https://polyhaven.com/a/moon_01"
    assert 0 < manifest["diffuseMeanLinear"] < 1


@pytest.mark.parametrize("tier", ["desktop", "mobile"])
def test_material_bytes_dimensions_and_normal_vectors(tier):
    manifest = json.loads((ASSETS / "manifest.json").read_text())
    records = manifest["textures"][tier]
    assert set(records) == {"diffuse", "normal", "roughness"}
    for role, record in records.items():
        path = (ASSETS / record["url"]).resolve()
        assert path.parent == ASSETS.resolve()
        payload = path.read_bytes()
        assert len(payload) == record["byteLength"]
        assert hashlib.sha256(payload).hexdigest() == record["sha256"]
        with Image.open(path) as image:
            assert image.size == (record["width"], record["height"])
            if role == "normal":
                vectors = np.asarray(image.convert("RGB"), dtype=np.float32) / 127.5 - 1
                assert np.isfinite(vectors).all()
                # Quantizing each component has <=1/255 error. The induced
                # vector-length error is bounded by sqrt(3)/255 < .007.
                assert np.max(np.abs(np.linalg.norm(vectors, axis=2) - 1)) < .007
                assert np.min(vectors[..., 2]) >= 0
