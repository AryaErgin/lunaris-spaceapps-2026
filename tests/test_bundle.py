import json
from hashlib import sha256
from itertools import pairwise
from pathlib import Path

import pytest

from science.build import _canonical
from science.sources import SHA256
from science.terrain import project
from science.terrain_study import check_product

BUNDLE = Path("web/data/bundle.json")
HEIGHT_STUDY = Path("web/data/height-study.json")
POSITION_STUDY = Path("web/data/position-study.json")
TERRAIN_STUDY = Path("web/data/terrain-study.json")


def verify_payload_fingerprint(bundle):
    manifest = bundle["manifest"].copy()
    expected = manifest.pop("bundleSha256")
    manifest.pop("bundleHashConvention")
    assert sha256(_canonical(bundle | {"manifest": manifest})).hexdigest() == expected


@pytest.mark.skipif(not BUNDLE.is_file(), reason="offline release bundle not built")
def test_release_bundle_fingerprint_and_source_hashes():
    bundle = json.loads(BUNDLE.read_bytes())
    verify_payload_fingerprint(bundle)
    manifest = bundle["manifest"]
    assert {item["filename"]: item["sha256"] for item in manifest["files"] if item["filename"] in SHA256} == SHA256
    assert len(bundle["sites"]) >= 3
    start, end = bundle["coverage"]
    for site in bundle["sites"]:
        assert site["terrain"]["fine"]["nativeRasterRoundTripErrorPixels"] < 0.1
        for channel in ("sun", "earth"):
            timelines = [site[channel], *site["refinementIntervals"][channel].values()]
            for timeline in timelines:
                assert timeline[0][0] == start
                assert timeline[-1][1] == end
                assert all(left[1] == right[0] for left, right in pairwise(timeline))


@pytest.mark.skipif(not HEIGHT_STUDY.is_file(), reason="observer-height bundle not built")
def test_height_bundle_reuses_nominal_and_moves_only_observer_height():
    baseline = json.loads(BUNDLE.read_bytes())
    study = json.loads(HEIGHT_STUDY.read_bytes())
    verify_payload_fingerprint(study)
    assert study["coverage"] == baseline["coverage"]
    assert study["manifest"]["baselineBundleSha256"] == baseline["manifest"]["bundleSha256"]
    site = next(site for site in baseline["sites"] if site["id"] == study["siteId"])
    assert study["manifest"]["pointCoordinates"] == [site["lat"], site["lon"]]
    assert study["manifest"]["groundM"] == site["groundM"]
    nominal_radius = site["terrain"]["fine"]["observerRadiusM"]
    low, nominal, high = study["scenarios"]
    assert nominal == {"id": "h2m", "heightM": 2, "baseline": True}
    assert low["terrain"]["fine"]["observerRadiusM"] == nominal_radius - 1
    assert high["terrain"]["fine"]["observerRadiusM"] == nominal_radius + 3
    assert low["sun"] != site["sun"] and high["sun"] != site["sun"]


@pytest.mark.skipif(not POSITION_STUDY.is_file(), reason="landing-position bundle not built")
def test_position_bundle_moves_map_easting_and_keeps_height_above_local_ground():
    baseline = json.loads(BUNDLE.read_bytes())
    study = json.loads(POSITION_STUDY.read_bytes())
    verify_payload_fingerprint(study)
    assert study["coverage"] == baseline["coverage"]
    assert study["manifest"]["baselineBundleSha256"] == baseline["manifest"]["bundleSha256"]
    site = next(site for site in baseline["sites"] if site["id"] == study["siteId"])
    x_origin, y_origin = project(site["lat"], site["lon"])
    assert [item["offsetEastingM"] for item in study["scenarios"]] == [-25, 0, 25]
    for scenario in study["scenarios"]:
        x, y = project(scenario["lat"], scenario["lon"])
        assert x - x_origin == pytest.approx(scenario["offsetEastingM"], abs=1e-7)
        assert y == pytest.approx(y_origin, abs=1e-7)
        assert scenario["heightM"] == 2
        if scenario.get("baseline"):
            assert "sun" not in scenario
        else:
            assert scenario["groundM"] != site["groundM"]
            assert scenario["terrain"]["fine"]["observerRadiusM"] == site["referenceRadiusM"] + scenario["groundM"] + 2


@pytest.mark.skipif(not TERRAIN_STUDY.is_file(), reason="terrain realization bundle not built")
def test_terrain_bundle_changes_local_surface_only_at_fixed_point():
    baseline = json.loads(BUNDLE.read_bytes())
    study = json.loads(TERRAIN_STUDY.read_bytes())
    verify_payload_fingerprint(study)
    assert study["coverage"] == baseline["coverage"]
    assert study["manifest"]["baselineBundleSha256"] == baseline["manifest"]["bundleSha256"]
    site = next(site for site in baseline["sites"] if site["id"] == study["siteId"])
    nominal, first, second = study["scenarios"]
    assert nominal["baseline"] is True
    for clone, actual in zip((first, second), (1794.544677734375, 1793.816650390625), strict=True):
        assert (clone["lat"], clone["lon"], clone["heightM"]) == (site["lat"], site["lon"], site["heightM"])
        assert clone["groundM"] == actual
        assert clone["encodingCheck"]["deltaGroundM"] == actual - site["groundM"]
        nominal_terrain = site["terrain"]["fine"]
        cloned_terrain = clone["terrain"]["fine"]
        assert cloned_terrain["regional"] == nominal_terrain["regional"]
        assert cloned_terrain["local"]["filename"] != nominal_terrain["local"]["filename"]
        assert clone["sun"] != site["sun"]


def test_actual_terrain_clone_sample_matches_absolute_raster():
    raw = Path("data/raw")
    nominal = raw / "Site11_final_adj_5mpp_surf.tif"
    clone = raw / "clones/Site11_final_adj_5mpp_0001_err.tif"
    if not nominal.is_file() or not clone.is_file():
        pytest.skip("download NASA terrain realizations to run native raster verification")
    result = check_product(nominal, clone, -88.6834, 292.0679)
    assert result == {
        "nominalGroundM": 1793.7939453125,
        "realizedGroundM": 1794.544677734375,
        "deltaGroundM": 0.750732421875,
    }
