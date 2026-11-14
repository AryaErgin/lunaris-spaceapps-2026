import json
from hashlib import sha256
from itertools import pairwise
from pathlib import Path

import pytest

from science.build import _canonical
from science.sources import SHA256

BUNDLE = Path("web/data/bundle.json")


@pytest.mark.skipif(not BUNDLE.is_file(), reason="offline release bundle not built")
def test_release_bundle_fingerprint_and_source_hashes():
    bundle = json.loads(BUNDLE.read_bytes())
    manifest = bundle["manifest"]
    expected = manifest.pop("bundleSha256")
    manifest.pop("bundleHashConvention")
    assert sha256(_canonical(bundle)).hexdigest() == expected
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
