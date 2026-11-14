"""Sampled SPICE-domain checks for an explicitly requested experimental period.

This is a numerical domain screen, not a proof of rates between samples, an
independent astronomical validation, or a physical-accuracy certificate.
"""

import argparse
import json
from datetime import datetime, timezone
from hashlib import file_digest
from math import ceil, isfinite
from pathlib import Path

import numpy as np

from science.ephemerides import CORRECTION, FILES, FRAME, Ephemeris, _utc
from science.sources import FILES as SOURCE_FILES
from science.sources import SHA256
from science.visibility import RATE_DEG_PER_S

LIGHT_SPEED_KM_S = 299_792.458
EARTH_MIN_RANGE_KM = 350_000.0
EARTH_MAX_ABS_RANGE_RATE_KM_S = 2.0
LIGHT_TIME_GUARD_SECONDS = 600.0
INTERLACED_RATE_TOLERANCE_DEG_MIN = 0.000001

_MAXIMA = {
    "max_range_km": "max_range_utc",
    "max_abs_range_rate_km_s": "max_abs_range_rate_utc",
    "max_angular_rate_deg_min": "max_angular_rate_utc",
    "max_light_time_seconds": "max_light_time_utc",
}


def summarize_states(states, epochs):
    """Measure actual state-vector derivatives at the supplied sample epochs."""
    values, times = np.asarray(states, dtype=float), np.asarray(epochs, dtype=float)
    if values.ndim != 2 or values.shape[1] != 6 or times.shape != (len(values),) or not len(values):
        raise ValueError("Expected a nonempty N×6 state array and N epochs")
    if not np.all(np.isfinite(values)) or not np.all(np.isfinite(times)):
        raise ValueError("All sampled states and epochs must be finite")
    position, velocity = values[:, :3], values[:, 3:]
    distance = np.linalg.norm(position, axis=1)
    if not np.all(np.isfinite(distance)) or np.any(distance <= 0):
        raise ValueError("Every target range must be finite and positive")
    angular = np.linalg.norm(np.cross(position, velocity), axis=1) / distance**2 * 180 / np.pi * 60
    radial = np.abs(np.sum(position * velocity, axis=1) / distance)
    light_time = distance / LIGHT_SPEED_KM_S
    if not np.all(np.isfinite(angular)) or not np.all(np.isfinite(radial)):
        raise ValueError("All derived sampled rates must be finite")

    def stamp(index):
        return _utc(times[index]).isoformat().replace("+00:00", "Z")

    minimum = int(distance.argmin())
    result = {
        "sample_count": len(values), "all_finite": True,
        "min_range_km": float(distance[minimum]), "min_range_utc": stamp(minimum),
    }
    for key, array in (("max_range_km", distance), ("max_abs_range_rate_km_s", radial),
                       ("max_angular_rate_deg_min", angular), ("max_light_time_seconds", light_time)):
        index = int(array.argmax())
        result[key], result[_MAXIMA[key]] = float(array[index]), stamp(index)
    return result


def _merge_summary(previous, latest):
    if previous is None:
        return latest.copy()
    result = previous.copy()
    result["sample_count"] += latest["sample_count"]
    if latest["min_range_km"] < result["min_range_km"]:
        for key in ("min_range_km", "min_range_utc"):
            result[key] = latest[key]
    for key, time_key in _MAXIMA.items():
        if latest[key] > result[key]:
            result[key], result[time_key] = latest[key], latest[time_key]
    return result


def _batches(start, end, cadence, batch_size, *, interlaced=False):
    # Use multiplication from a fixed origin instead of accumulated float steps.
    count = max(0, ceil((end - start) / cadence))
    pending = []
    for index in range(count):
        left = start + index * cadence
        if left >= end:
            break
        pending.append((left + min(left + cadence, end)) / 2 if interlaced else left)
        if len(pending) == batch_size:
            yield pending
            pending = []
    if not interlaced:
        pending.append(end)  # The plot/interval cache includes its final boundary.
    if pending:
        yield pending


def _fingerprint(path):
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def _kernel_provenance(raw):
    records = []
    for filename in FILES:
        path = raw / filename
        digest = _fingerprint(path)
        if digest != SHA256[filename]:
            raise ValueError(f"Kernel {filename} does not match its pinned SHA-256")
        url, expected_size, citation = SOURCE_FILES[filename]
        if path.stat().st_size != expected_size:
            raise ValueError(f"Kernel {filename} does not match its pinned byte count")
        records.append({"filename": filename, "bytes": expected_size, "sha256": digest,
                        "url": url, "citation": citation})
    return records


def audit_domain(raw, sites, start, end, *, cadence_seconds=60, interlaced=False, batch_size=4096,
                 generator_commit=None, progress=None):
    """Audit sampled CN+S states without changing any visibility cone constant.

    ``sites`` contains (id, latitude_deg, longitude_deg_east, observer_radius_m).
    Interlacing adds midpoint samples to the regular cadence, measures changes
    in sampled angular-rate maxima, and reports an explicit numerical tolerance.
    It does not prove an envelope at all times between the new samples.
    """
    if not all(isfinite(value) for value in (start, end)) or end <= start:
        raise ValueError("A positive, finite domain interval is required")
    if not isfinite(cadence_seconds) or cadence_seconds <= 0:
        raise ValueError("The sampling cadence must be finite and positive")
    if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size < 1:
        raise ValueError("The state batch size must be a positive integer")
    sites = list(sites)
    if any(not isinstance(site, (tuple, list)) or len(site) != 4 for site in sites):
        raise ValueError("Each site requires an ID and three finite observation coordinates")
    identifiers = [site[0] for site in sites]
    if not sites or any(not isinstance(value, str) or not value for value in identifiers) or len(set(identifiers)) != len(sites):
        raise ValueError("The domain audit requires distinct, nonempty site identifiers")
    for site in sites:
        if not all(isfinite(value) for value in site[1:]):
            raise ValueError("Each site requires an ID and three finite observation coordinates")
        if not -90 <= site[1] <= 90 or site[3] <= 0:
            raise ValueError("Each site requires a valid latitude and positive observer radius")
    raw = Path(raw)
    kernels = _kernel_provenance(raw)
    results, angular_changes = [], []
    envelope = RATE_DEG_PER_S * 60
    with Ephemeris(raw) as ephemeris:
        coverage = ephemeris.assert_coverage(start, end, light_time_margin_s=LIGHT_TIME_GUARD_SECONDS)
        for site_id, latitude, longitude, radius in sites:
            summaries = {key: None for key in ("sun", "earth")}
            regular = None
            for midpoint_grid in ([False, True] if interlaced else [False]):
                for epochs in _batches(start, end, cadence_seconds, batch_size, interlaced=midpoint_grid):
                    states = ephemeris.states(latitude, longitude, radius, epochs)
                    for key, state in zip(("sun", "earth"), states, strict=True):
                        summaries[key] = _merge_summary(summaries[key], summarize_states(state, epochs))
                    if progress:
                        progress({"site_id": site_id, "interlaced_grid": midpoint_grid,
                                  "sample_count": summaries["sun"]["sample_count"], "last_epoch": epochs[-1]})
                if not midpoint_grid:
                    regular = {key: value.copy() for key, value in summaries.items()}
            if interlaced:
                angular_changes.extend(abs(summaries[key]["max_angular_rate_deg_min"] - regular[key]["max_angular_rate_deg_min"])
                                       for key in ("sun", "earth"))
            checks = {
                "sun_angular_rate_below_envelope": summaries["sun"]["max_angular_rate_deg_min"] < envelope,
                "earth_angular_rate_below_envelope": summaries["earth"]["max_angular_rate_deg_min"] < envelope,
                "earth_range_above_assumed_minimum": summaries["earth"]["min_range_km"] > EARTH_MIN_RANGE_KM,
                "earth_abs_range_rate_below_assumed_maximum": summaries["earth"]["max_abs_range_rate_km_s"] < EARTH_MAX_ABS_RANGE_RATE_KM_S,
                "sampled_light_times_inside_coverage_guard": max(value["max_light_time_seconds"] for value in summaries.values()) < LIGHT_TIME_GUARD_SECONDS,
            }
            results.append({"site_id": site_id, "latitude_deg": latitude, "longitude_deg_east": longitude % 360,
                            "observer_radius_m": radius, **summaries, "regular_grid": regular,
                            "checks": checks, "status": "PASS" if all(checks.values()) else "FAIL"})
    maximum_change = max(angular_changes, default=0.0)
    agrees = maximum_change <= INTERLACED_RATE_TOLERANCE_DEG_MIN
    return {
        "version": "1.0.0", "status": "PASS" if all(site["status"] == "PASS" for site in results) and agrees else "FAIL",
        "scope": "Sampled apparent-state domain checks; shared SPICE model, not independent physical validation.",
        "sampled_only": True, "between_sample_bound_proven": False,
        "start_utc": _utc(start).isoformat().replace("+00:00", "Z"),
        "end_utc": _utc(end).isoformat().replace("+00:00", "Z"),
        "cadence_seconds": cadence_seconds, "interlaced_cadence_seconds": cadence_seconds / 2 if interlaced else None,
        "frame": FRAME, "correction": CORRECTION, "state_units": ["km", "km/s"],
        "rate_method": "Instantaneous |position cross velocity| / range², from SPKCPO reception states in fixed local ENU.",
        "coverage": coverage, "sites": results,
        "limits": {"angular_rate_envelope_deg_min": envelope, "earth_min_range_km": EARTH_MIN_RANGE_KM,
                   "earth_max_abs_range_rate_km_s": EARTH_MAX_ABS_RANGE_RATE_KM_S,
                   "light_time_guard_s": LIGHT_TIME_GUARD_SECONDS},
        "interlaced_check": {"performed": bool(interlaced), "maximum_angular_rate_change_deg_min": maximum_change if interlaced else None,
                             "tolerance_deg_min": INTERLACED_RATE_TOLERANCE_DEG_MIN,
                             "within_declared_tolerance": agrees if interlaced else None,
                             "interpretation": "Agreement of sampled extrema is numerical evidence, not physical accuracy or a between-sample proof."},
        "kernels": kernels, "generator_commit": generator_commit,
        "code_sha256": {path.name: _fingerprint(path) for path in (Path(__file__), Path(__file__).with_name("ephemerides.py"))},
        "limitations": ["A sampled maximum can miss a peak between samples, including after interlacing.",
                        "This audit does not establish terrain skyline accuracy, full-disc illumination, electrical power or a radio link.",
                        "The existing visibility angular cone and occultation constants are unchanged; no new continuous bound is claimed."],
    }


def _parse_epoch(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=Path("data/raw"))
    parser.add_argument("--start", type=_parse_epoch, default=_parse_epoch("2026-11-01"))
    parser.add_argument("--end", type=_parse_epoch, default=_parse_epoch("2028-01-01"))
    parser.add_argument("--site", action="append", required=True, metavar="ID,LAT,LON,RADIUS_M")
    parser.add_argument("--cadence-seconds", type=float, default=60)
    parser.add_argument("--interlaced", action="store_true")
    parser.add_argument("--batch-size", type=int, default=4096)
    parser.add_argument("--generator-commit")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    sites = []
    for value in args.site:
        site_id, latitude, longitude, radius = value.split(",")
        sites.append((site_id, float(latitude), float(longitude), float(radius)))
    report = audit_domain(args.raw, sites, args.start, args.end, cadence_seconds=args.cadence_seconds,
                          interlaced=args.interlaced, batch_size=args.batch_size, generator_commit=args.generator_commit)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(f"Sampled domain checks {report['status']} at {args.cadence_seconds:g} s cadence; interlaced={args.interlaced}. No between-sample proof claimed.")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
