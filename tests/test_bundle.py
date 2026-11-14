import json
from hashlib import sha256
from itertools import pairwise
from pathlib import Path

import pytest

from science.build import _canonical
from science.sources import SHA256

BUNDLE = Path("web/data/bundle.json")
HEIGHT_STUDY = Path("web/data/height-study.json")


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
