"""Build Moon-fixed, airless apparent directions from NASA/JPL kernels."""

import argparse
import csv
import json
from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
from math import isfinite
from pathlib import Path
from threading import RLock
from urllib.parse import urlencode
from urllib.request import urlopen

import numpy as np
import spiceypy as spice

FRAME = "MOON_ME_DE440_ME421"
CORRECTION = "CN+S"
OBSERVER_CENTER = "MOON"
REFERENCE_RADIUS_M = 1_737_400.0
FILES = ("naif0012.tls", "de440s.bsp", "moon_pa_de440_200625.bpc", "moon_de440_250416.tf")
TARGETS = {"sun": "10", "earth": "399"}
HORIZONS_API = "https://ssd.jpl.nasa.gov/api/horizons.api"
HORIZONS_LIMIT_DEG = 0.01
_KERNEL_LOCK = RLock()


def enu_basis(latitude_deg, longitude_deg_east):
    """Rows are east, north and radial up in lunar Cartesian coordinates."""
    if not -90 <= latitude_deg <= 90 or not isfinite(longitude_deg_east):
        raise ValueError("Invalid planetocentric latitude or east longitude")
    lat, lon = np.deg2rad((latitude_deg, longitude_deg_east % 360))
    sin_lat, cos_lat = np.sin(lat), np.cos(lat)
    sin_lon, cos_lon = np.sin(lon), np.cos(lon)
    return np.array((
        (-sin_lon, cos_lon, 0),
        (-sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat),
        (cos_lat * cos_lon, cos_lat * sin_lon, sin_lat),
    ))


def unit_from_azimuth_elevation(azimuth_deg, elevation_deg):
    azimuth = np.deg2rad(azimuth_deg)
    elevation = np.deg2rad(elevation_deg)
    horizontal = np.cos(elevation)
    return np.stack((horizontal * np.sin(azimuth), horizontal * np.cos(azimuth), np.sin(elevation)), axis=-1)


def azimuth_elevation(vectors):
    east, north, up = np.moveaxis(np.asarray(vectors), -1, 0)
    azimuth_deg = np.rad2deg(np.arctan2(east, north)) % 360
    elevation_deg = np.rad2deg(np.arctan2(up, np.hypot(east, north)))
    return azimuth_deg, elevation_deg


def angular_distance_deg(left, right):
    sine = np.linalg.norm(np.cross(left, right), axis=-1)
    cosine = np.sum(left * right, axis=-1)
    return np.rad2deg(np.arctan2(sine, cosine))


def _utc(timestamp):
    try:
        return datetime.fromtimestamp(float(timestamp), tz=timezone.utc)
    except OSError:
        # Windows' C runtime rejects some valid pre-1970 timestamps. Kernel
        # coverage checks still need to express their actual 19th-century edge.
        return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=float(timestamp))


class Ephemeris:
    """Own loaded SPICE files for one offline computation."""

    def __init__(self, raw_dir):
        self.raw_dir = Path(raw_dir).resolve()
        self._loaded = None

    def __enter__(self):
        _KERNEL_LOCK.acquire()
        if self._loaded is not None:
            _KERNEL_LOCK.release()
            raise RuntimeError("This ephemeris context is already open")
        self._loaded = []
        try:
            for filename in FILES:
                path = self.raw_dir / filename
                if not path.is_file():
                    raise FileNotFoundError(path)
                filename = str(path)
                with spice.no_found_check():
                    *_, found = spice.kinfo(filename)
                if not found:
                    spice.furnsh(filename)
                    self._loaded.append(filename)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        try:
            for filename in reversed(self._loaded):
                spice.unload(filename)
        finally:
            self._loaded = None
            _KERNEL_LOCK.release()

    def _require_open(self):
        if self._loaded is None:
            raise RuntimeError("Open the ephemeris as a context manager")

    def coverage(self):
        """Read actual SPK and orientation intervals from the frozen kernels."""
        self._require_open()

        def intervals(window):
            grouped = []
            for index in range(spice.wncard(window)):
                start, end = spice.wnfetd(window, index)
                grouped.append({
                    "start_tdb_s_past_j2000": start,
                    "end_tdb_s_past_j2000": end,
                    "start_utc": spice.et2utc(start, "ISOC", 3) + "Z",
                    "end_utc": spice.et2utc(end, "ISOC", 3) + "Z",
                })
            return grouped

        spk = str(self.raw_dir / "de440s.bsp")
        pck = str(self.raw_dir / "moon_pa_de440_200625.bpc")
        return {
            "spk": {str(body): intervals(spice.spkcov(spk, body)) for body in (3, 10, 301, 399)},
            "orientation": intervals(spice.pckcov(pck, 31008)),
            "observer_frame": FRAME,
            "orientation_class_id": 31008,
            "correction": CORRECTION,
            "output_frame_epoch": "OBSERVER",
            "toolkit_version": spice.tkvrsn("TOOLKIT"),
            "spiceypy_version": spice.__version__,
            "note": "Raw kernel intervals. Reception calculations also require target coverage at retarded epochs.",
        }

    def assert_coverage(self, start_unix_s, end_unix_s, *, light_time_margin_s=600.0):
        """Require kernel coverage for an inclusive reception interval and guard.

        The guard must also exceed the actual target light times in a domain
        audit; raw kernel coverage alone is not a bound on target motion.
        """
        self._require_open()
        if not all(isfinite(value) for value in (start_unix_s, end_unix_s)) or end_unix_s <= start_unix_s:
            raise ValueError("A positive, finite reception coverage interval is required")
        if not isfinite(light_time_margin_s) or light_time_margin_s <= 0:
            raise ValueError("A positive, finite light-time coverage margin is required")
        start_et, end_et = spice.str2et([
            _utc(value).strftime("%Y-%m-%d %H:%M:%S.%f UTC") for value in (start_unix_s, end_unix_s)
        ])
        guarded_start = start_et - light_time_margin_s
        coverage = self.coverage()

        def contains(intervals, begin, final):
            cursor = begin
            for interval in sorted(intervals, key=lambda row: row["start_tdb_s_past_j2000"]):
                left, right = interval["start_tdb_s_past_j2000"], interval["end_tdb_s_past_j2000"]
                if right < cursor:
                    continue
                if left > cursor:
                    return False
                cursor = max(cursor, right)
                if cursor >= final:
                    return True
            return False

        for body, intervals in coverage["spk"].items():
            if not contains(intervals, guarded_start, end_et):
                raise ValueError(f"SPK coverage for body {body} does not enclose reception and retarded epochs")
        if not contains(coverage["orientation"], start_et, end_et):
            raise ValueError("Lunar orientation coverage does not enclose the reception interval")
        return {
            "status": "PASS", "start_utc": _utc(start_unix_s).isoformat().replace("+00:00", "Z"),
            "end_utc": _utc(end_unix_s).isoformat().replace("+00:00", "Z"),
            "light_time_margin_s": float(light_time_margin_s),
            "guarded_spk_start_utc": spice.et2utc(guarded_start, "ISOC", 6) + "Z",
            "kernel_intervals": coverage,
            "scope": "Raw SPK and orientation coverage; actual sampled light times must fit the declared guard.",
        }

    def states(self, site_lat_deg, lon_deg_east, observer_radius_m, times_unix_s):
        """Return Sun and Earth-center N×6 apparent ENU states, km and km/s.

        SPKCPO includes the time-dependent observer/output frame in its state
        derivative. The local ENU basis is fixed relative to that lunar frame.
        """
        self._require_open()
        basis = enu_basis(site_lat_deg, lon_deg_east)
        if not isfinite(observer_radius_m) or observer_radius_m <= 0:
            raise ValueError("Observer radius must be finite and positive")
        position_km = basis[2] * (observer_radius_m / 1000)
        seconds = np.asarray(times_unix_s, dtype=np.float64)
        if seconds.ndim != 1 or not np.all(np.isfinite(seconds)):
            raise ValueError("Expected a one-dimensional list of finite Unix UTC times")
        if not seconds.size:
            return np.empty((0, 6)), np.empty((0, 6))
        utc_strings = [_utc(second).strftime("%Y-%m-%d %H:%M:%S.%f UTC") for second in seconds]
        epochs = spice.str2et(utc_strings)

        def target_states(target):
            raw = np.array([
                spice.spkcpo(target, et, FRAME, "OBSERVER", CORRECTION, position_km, OBSERVER_CENTER, FRAME)[0]
                for et in epochs
            ])
            # Keep the original contiguous N×3 position transform bit-for-bit.
            position = np.ascontiguousarray(raw[:, :3]) @ basis.T
            velocity = np.ascontiguousarray(raw[:, 3:]) @ basis.T
            return np.concatenate((position, velocity), axis=1)

        return target_states(TARGETS["sun"]), target_states(TARGETS["earth"])

    def vectors(self, site_lat_deg, lon_deg_east, observer_radius_m, times_unix_s):
        """Return Sun and Earth-center N×3 ENU vectors in km for Unix UTC times."""
        return tuple(state[:, :3] for state in self.states(
            site_lat_deg, lon_deg_east, observer_radius_m, times_unix_s
        ))


def parse_horizons(output):
    """Read target-center apparent azimuth/elevation (Horizons quantity 4)."""
    header, start, rest = output.partition("$$SOE")
    table, end, _ = rest.partition("$$EOE")
    if not start or not end:
        raise ValueError("NASA/JPL Horizons response lacks ephemeris delimiters")
    if "(a-app)" not in header:
        raise ValueError("NASA/JPL Horizons response lacks airless apparent columns")
    months = {name: i for i, name in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
    results = []
    for row in csv.reader(table.strip().splitlines()):
        if not row:
            continue
        timestamp = row[0].strip().removeprefix("A.D. ")
        epoch_date, clock = timestamp.split(maxsplit=1)
        year, month, day = epoch_date.split("-")
        if len(clock) == 5:
            clock += ":00"
        utc = datetime.fromisoformat(f"{year}-{months[month]:02d}-{day}T{clock}").isoformat() + "Z"
        azimuth, elevation = float(row[3]), float(row[4])
        if not (0 <= azimuth <= 360 and -90 <= elevation <= 90):
            raise ValueError("Invalid angle in NASA/JPL Horizons response")
        results.append({"utc": utc, "azimuth_deg": azimuth, "elevation_deg": elevation})
    if not results:
        raise ValueError("NASA/JPL Horizons response contains no angle rows")
    return results


def validate_horizons_header(output, body, target, latitude, longitude, radius_m):
    """Confirm the comparison service echoed the same origin and conventions."""
    header = output.split("$$SOE", maxsplit=1)[0].splitlines()
    required = {
        "Target body name": f"{body.title()} ({target})",
        "Center body name": "Moon (301)",
        "Center pole/equ": "MEAN_ME",
        "Atmos refraction": "AIRLESS",
        "Center radii": "1737.4, 1737.4, 1737.4",
    }
    for field, token in required.items():
        if not any(line.startswith(field) and token in line for line in header):
            raise ValueError(f"Unexpected {field} in NASA/JPL Horizons response")
    geodetic = next((line for line in header if line.startswith("Center geodetic")), "")
    site = geodetic.partition(":")[2].partition("{")[0]
    try:
        ref_lon, ref_lat, ref_alt_km = (float(value) for value in site.split(","))
    except ValueError as error:
        raise ValueError("Missing observer coordinates or height in NASA/JPL Horizons response") from error
    longitude_error = abs((ref_lon - longitude + 180) % 360 - 180)
    altitude_error_km = abs(ref_alt_km - (radius_m - REFERENCE_RADIUS_M) / 1000)
    if longitude_error > 0.0001 or abs(ref_lat - latitude) > 0.0001 or altitude_error_km > 0.0001:
        raise ValueError("Horizons observer coordinates or height differ from SPICE inputs")
    fields = (*required, "API VERSION", "API SOURCE", "Center geodetic")
    return [line.rstrip() for line in header if line.startswith(fields)]


def _horizons_url(target, lat, lon, radius_m, dates):
    parameters = {
        "format": "text",
        "COMMAND": target,
        "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "OBSERVER",
        "CENTER": "coord@301",
        "COORD_TYPE": "GEODETIC",
        "SITE_COORD": f"{lon % 360:.8f},{lat:.8f},{(radius_m - REFERENCE_RADIUS_M) / 1000:.9f}",
        "APPARENT": "AIRLESS",
        "QUANTITIES": "4",
        "EXTRA_PREC": "YES",
        "CSV_FORMAT": "YES",
        "START_TIME": dates[0].isoformat(),
        "STOP_TIME": dates[-1].isoformat(),
        "STEP_SIZE": "1 d",
    }
    return HORIZONS_API + "?" + urlencode({key: value if key == "format" else f"'{value}'" for key, value in parameters.items()})


def horizons_validation(ephemeris, sites, dates, archive):
    """Fetch JPL samples and compare both targets for each declared observer."""
    dates = sorted(set(dates))
    sites = list(sites)
    if len(sites) < 3 or len(dates) < 3:
        raise ValueError("T03 requires at least three lunar sites and dates")
    timestamps = [day.isoformat() + "T00:00:00Z" for day in dates]
    unix_times = [datetime.fromisoformat(value).timestamp() for value in timestamps]
    archive.mkdir(parents=True, exist_ok=True)
    evidence = []
    retrieved_utc = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    for site_id, lat, lon, radius_m in sites:
        if not site_id or any(char not in "abcdefghijklmnopqrstuvwxyz0123456789-" for char in site_id):
            raise ValueError("Validation site ID must contain lowercase letters, digits or hyphens")
        vectors = ephemeris.vectors(lat, lon, radius_m, unix_times)
        for (body, target), spice_vectors in zip(TARGETS.items(), vectors, strict=True):
            url = _horizons_url(target, lat, lon, radius_m, dates)
            with urlopen(url, timeout=45) as response:
                content = response.read()
            filename = f"{site_id}-{body}.txt"
            (archive / filename).write_bytes(content)
            output = content.decode("utf-8")
            reference_header = validate_horizons_header(output, body, target, lat, lon, radius_m)
            by_time = {row["utc"]: row for row in parse_horizons(output)}
            if any(utc not in by_time for utc in timestamps):
                raise ValueError(f"Missing requested comparison epochs in {filename}")
            azimuth_deg, elevation_deg = azimuth_elevation(spice_vectors)
            rows = []
            for index, utc in enumerate(timestamps):
                sample = by_time[utc]
                direction = unit_from_azimuth_elevation(sample["azimuth_deg"], sample["elevation_deg"])
                rows.append({
                    "utc": utc,
                    "horizons_azimuth_deg": sample["azimuth_deg"],
                    "horizons_elevation_deg": sample["elevation_deg"],
                    "spice_azimuth_deg": round(float(azimuth_deg[index]), 9),
                    "spice_elevation_deg": round(float(elevation_deg[index]), 9),
                    "separation_deg": round(float(angular_distance_deg(spice_vectors[index], direction)), 12),
                })
            evidence.append({
                "site_id": site_id,
                "latitude_deg": lat,
                "longitude_deg_east": lon % 360,
                "observer_radius_m": radius_m,
                "target": body,
                "horizons_target_id": target,
                "url": url,
                "source_filename": filename,
                "source_bytes": len(content),
                "source_sha256": sha256(content).hexdigest(),
                "reference_header": reference_header,
                "samples": rows,
            })
    maximum = max(row["separation_deg"] for report in evidence for row in report["samples"])
    return {
        "test_id": "T03",
        "status": "PASS" if maximum < HORIZONS_LIMIT_DEG else "FAIL",
        "retrieved_utc": retrieved_utc,
        "comparison_count": sum(len(report["samples"]) for report in evidence),
        "angular_tolerance_deg": HORIZONS_LIMIT_DEG,
        "max_angular_separation_deg": maximum,
        "comparison_conventions": {
            "lunar_spice_frame": FRAME,
            "lunar_horizons_frame": "MEAN_ME (DE440-family realization of DE421 mean Earth/polar axis)",
            "spice_correction": CORRECTION,
            "horizons_correction": "Airless apparent; additionally includes relativistic deflection",
            "observer_reference_radius_m": REFERENCE_RADIUS_M,
            "interpretation": "Topocentric implementation comparison with shared JPL ephemeris lineage; tests no terrain or physical visibility.",
        },
        "references": evidence,
    }


def main():
    parser = argparse.ArgumentParser(description="Compare lunar surface SPICE directions with JPL Horizons")
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--site", action="append", required=True, metavar="ID,LAT,LON,RADIUS_M")
    parser.add_argument("--date", action="append", required=True, type=date.fromisoformat, metavar="YYYY-MM-DD")
    args = parser.parse_args()
    sites = []
    for value in args.site:
        site_id, lat, lon, radius_m = value.split(",")
        sites.append((site_id, float(lat), float(lon), float(radius_m)))
    with Ephemeris(args.raw_dir) as ephemeris:
        evidence = horizons_validation(ephemeris, sites, args.date, args.archive)
    args.output.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(f"T03 {evidence['status']} across {evidence['comparison_count']} comparisons. Maximum separation {evidence['max_angular_separation_deg']:.9f}°.")
    return 0 if evidence["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
