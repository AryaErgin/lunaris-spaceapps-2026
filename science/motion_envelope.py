"""Conservative enclosures of the pinned piecewise-polynomial CN+S model.

This independently reads type-2 SPK/PCK records and bounds polynomials over
intervals using directed Decimal arithmetic. It is not formal verification of
CSPICE, an observational validation, or a bound on physical ephemeris error.
"""

import argparse
import json
import math
from decimal import ROUND_CEILING, ROUND_FLOOR, Context, Decimal
from hashlib import file_digest, sha256
from itertools import pairwise
from pathlib import Path

import numpy as np
import spiceypy as spice

from science.ephemerides import FRAME, Ephemeris, _utc
from science.sources import FILES, SHA256
from science.visibility import ANGULAR_PADDING_DEG, EARTH_RADIUS_MAX_KM, RATE_DEG_PER_S

SOURCES = {
    "spk_type2": "https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/spk.html",
    "pck_type2": "https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/pck.html",
    "stellar_aberration": "https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/stelab_c.html",
    "newtonian_light_time": "https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/abcorr.html",
}
IMPLEMENTATION_POSITION_ALLOWANCE_KM = 0.001
IMPLEMENTATION_SPEED_ALLOWANCE_KM_S = 0.000001
IMPLEMENTATION_ANGULAR_POINT_ALLOWANCE_DEG = 0.0000001
MAX_SOLVER_INTERVAL_SECONDS = 256


class _Rounded:
    """Closed Decimal intervals; every arithmetic endpoint rounds outward."""

    def __init__(self, precision):
        if isinstance(precision, bool) or not isinstance(precision, int) or precision < 30:
            raise ValueError("Use at least 30 decimal digits for the interval enclosure")
        self.down = Context(prec=precision, rounding=ROUND_FLOOR)
        self.up = Context(prec=precision, rounding=ROUND_CEILING)
        self.zero = (Decimal(0), Decimal(0))
        self.one = (Decimal(1), Decimal(1))
        self.pi = (Decimal("3.14159265358979323846264338327950288419716939937510"),
                   Decimal("3.14159265358979323846264338327950288419716939937511"))

    def scalar(self, value):
        exact = Decimal.from_float(value) if isinstance(value, (float, np.floating)) else Decimal(value)
        if not exact.is_finite():
            raise ValueError("Interval inputs must be finite")
        return self.down.create_decimal(exact), self.up.create_decimal(exact)

    def add(self, a, b):
        return self.down.add(a[0], b[0]), self.up.add(a[1], b[1])

    def neg(self, a):
        return a[1].copy_negate(), a[0].copy_negate()

    def sub(self, a, b):
        return self.add(a, self.neg(b))

    def mul(self, a, b):
        if a == self.zero or b == self.zero:
            return self.zero
        return (min(self.down.multiply(x, y) for x in a for y in b),
                max(self.up.multiply(x, y) for x in a for y in b))

    def div(self, a, b):
        if b[0] <= 0 <= b[1]:
            raise ValueError("An interval denominator contains zero")
        return (min(self.down.divide(x, y) for x in a for y in b),
                max(self.up.divide(x, y) for x in a for y in b))

    def sqrt(self, a):
        if a[0] < 0:
            raise ValueError("A square-root interval must be nonnegative")
        # Decimal.sqrt is correctly rounded; one adjacent representable Decimal
        # on each side encloses it even when its rounding mode is HALF_EVEN.
        lo = self.down.next_minus(self.down.sqrt(a[0])) if a[0] else Decimal(0)
        hi = self.up.next_plus(self.up.sqrt(a[1])) if a[1] else Decimal(0)
        return lo, hi

    @staticmethod
    def absolute_upper(a):
        return max(a[0].copy_abs(), a[1].copy_abs())

    def norm(self, vector):
        low = high = Decimal(0)
        for interval in vector:
            near = max(Decimal(0), interval[0], interval[1].copy_negate())
            far = self.absolute_upper(interval)
            low = self.down.add(low, self.down.multiply(near, near))
            high = self.up.add(high, self.up.multiply(far, far))
        return self.sqrt((low, high))


def _float_endpoint(value, *, upper):
    result = float(value)
    represented = Decimal.from_float(result)
    if upper and represented < value:
        result = math.nextafter(result, math.inf)
    if not upper and represented > value:
        result = math.nextafter(result, -math.inf)
    return result


def _differentiate(coefficients, arithmetic):
    degree = len(coefficients) - 1
    if degree == 0:
        return [arithmetic.zero]
    result = [arithmetic.zero for _ in range(degree)]
    result[-1] = arithmetic.mul(arithmetic.scalar(2 * degree), coefficients[-1])
    if degree > 1:
        result[-2] = arithmetic.mul(arithmetic.scalar(2 * (degree - 1)), coefficients[-2])
    for index in range(degree - 3, -1, -1):
        result[index] = arithmetic.add(result[index + 2], arithmetic.mul(arithmetic.scalar(2 * (index + 1)), coefficients[index + 1]))
    result[0] = arithmetic.div(result[0], arithmetic.scalar(2))
    return result


def _clenshaw(coefficients, x, arithmetic):
    former = latest = arithmetic.zero
    twice_x = arithmetic.mul(arithmetic.scalar(2), x)
    for coefficient in coefficients[:0:-1]:
        former, latest = latest, arithmetic.sub(arithmetic.add(coefficient, arithmetic.mul(twice_x, latest)), former)
    return arithmetic.sub(arithmetic.add(coefficients[0], arithmetic.mul(x, latest)), former)


def chebyshev_bounds(coefficients, midpoint, radius, start, end, *, derivative=0, precision=50):
    """Enclose a scalar type-2 polynomial and its time derivative on a record."""
    if not coefficients or not all(math.isfinite(float(value)) for value in (midpoint, radius, start, end)):
        raise ValueError("Finite record coefficients and times are required")
    if radius <= 0 or end < start or start < midpoint - radius or end > midpoint + radius:
        raise ValueError("Requested interval is outside the positive-radius record")
    if isinstance(derivative, bool) or not isinstance(derivative, int) or derivative < 0:
        raise ValueError("Derivative order must be a nonnegative integer")
    arithmetic = _Rounded(precision)
    series = [arithmetic.scalar(value) for value in coefficients]
    for _ in range(derivative):
        series = _differentiate(series, arithmetic)
    x = arithmetic.div(arithmetic.sub((arithmetic.scalar(start)[0], arithmetic.scalar(end)[1]), arithmetic.scalar(midpoint)), arithmetic.scalar(radius))
    result = _clenshaw(series, x, arithmetic)
    for _ in range(derivative):
        result = arithmetic.div(result, arithmetic.scalar(radius))
    return _float_endpoint(result[0], upper=False), _float_endpoint(result[1], upper=True)


class _Type2Model:
    def __init__(self, raw, start, end):
        self.raw, self.start, self.end = Path(raw), start, end
        self.handles, self.segments, self.records = [], {}, {}

    def __enter__(self):
        try:
            for kind, filename, count in (("spk", "de440s.bsp", 6), ("pck", "moon_pa_de440_200625.bpc", 5)):
                handle = spice.dafopr(str(self.raw / filename))
                self.handles.append(handle)
                spice.dafbfs(handle)
                while spice.daffna():
                    dc, ic = spice.dafus(spice.dafgs(5), 2, count)
                    target = int(ic[0])
                    if target not in ((3, 10, 301, 399) if kind == "spk" else (31008,)) or dc[1] < self.start or dc[0] > self.end:
                        continue
                    frame, data_type = (int(ic[2]), int(ic[3])) if kind == "spk" else (int(ic[1]), int(ic[2]))
                    center = int(ic[1]) if kind == "spk" else None
                    key = (kind, target)
                    if key in self.segments or data_type != 2 or frame != 1 or dc[0] > self.start or dc[1] < self.end:
                        raise ValueError("A single pinned J2000 type-2 segment must cover the whole requested domain")
                    if kind == "spk" and center != ({3: 0, 10: 0, 301: 3, 399: 3}[target]):
                        raise ValueError("The SPK center chain differs from the documented Earth/Moon barycentric chain")
                    begin, final = int(ic[-2]), int(ic[-1])
                    init, span, size, records = spice.dafgda(handle, final - 3, final)
                    if not all(math.isfinite(value) for value in (init, span, size, records)) or span <= 0 or size != int(size) or records != int(records):
                        raise ValueError("Invalid type-2 directory")
                    size, records = int(size), int(records)
                    if size < 5 or (size - 2) % 3 or records < 1 or begin + size * records + 3 != final:
                        raise ValueError("The type-2 directory and record dimensions disagree")
                    self.segments[key] = {"kind": kind, "target": target, "center": center, "frame": frame,
                                          "handle": handle, "begin": begin, "init": float(init), "span": float(span),
                                          "size": size, "count": records, "filename": filename}
            if set(self.segments) != {("spk", 3), ("spk", 10), ("spk", 301), ("spk", 399), ("pck", 31008)}:
                raise ValueError("The required pinned SPK/PCK segment chain is incomplete")
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        for handle in reversed(self.handles):
            spice.dafcls(handle)
        self.handles = []

    def record(self, kind, target, time):
        segment = self.segments[(kind, target)]
        index = min(segment["count"] - 1, math.floor((time - segment["init"]) / segment["span"]))
        if index < 0:
            raise ValueError("An epoch falls outside the type-2 record directory")
        key = kind, target, index
        if key not in self.records:
            address = segment["begin"] + index * segment["size"]
            values = np.asarray(spice.dafgda(segment["handle"], address, address + segment["size"] - 1), dtype=float)
            midpoint, radius = map(float, values[:2])
            if not np.isfinite(values).all() or radius <= 0 or 2 * radius != segment["span"] or midpoint - radius != segment["init"] + index * segment["span"]:
                raise ValueError("The record's midpoint/radius differs from its directory")
            self.records[key] = {"kind": kind, "target": target, "center": segment["center"], "index": index,
                                 "midpoint": midpoint, "radius": radius, "coefficients": values[2:].reshape(3, -1).tolist(),
                                 "filename": segment["filename"], "sha256": sha256(values.astype("<f8").tobytes()).hexdigest()}
        return self.records[key]

    def partitions(self, step):
        points = {self.start, self.end}
        for index in range(1, math.ceil((self.end - self.start) / step)):
            points.add(min(self.end, self.start + index * step))
        for segment in self.segments.values():
            first = math.ceil((self.start - segment["init"]) / segment["span"])
            last = math.floor((self.end - segment["init"]) / segment["span"])
            points.update(segment["init"] + index * segment["span"] for index in range(first, last + 1))
        return sorted(points)


def read_type2_record(raw, target, epoch_et, *, kind="spk"):
    """Read one pinned record for independent reconstruction tests; no state API."""
    if kind not in ("spk", "pck") or not math.isfinite(epoch_et):
        raise ValueError("Specify a finite epoch and SPK or PCK record")
    with _Type2Model(raw, epoch_et, epoch_et) as model:
        return model.record(kind, target, epoch_et).copy()


def _source_files(raw):
    rows = []
    for filename in ("de440s.bsp", "moon_pa_de440_200625.bpc", "moon_de440_250416.tf", "naif0012.tls"):
        path = raw / filename
        with path.open("rb") as stream:
            digest = file_digest(stream, "sha256").hexdigest()
        url, size, citation = FILES[filename]
        if digest != SHA256[filename] or path.stat().st_size != size:
            raise ValueError(f"Pinned kernel identity mismatch: {filename}")
        rows.append({"filename": filename, "sha256": digest, "bytes": size, "url": url, "citation": citation})
    return rows


def _retarded_budget(arithmetic, *, geometric_min, geometric_max, relative_speed, target_speed,
                     target_acceleration, radius, frame_speed, guard, position_jump, velocity_jump):
    """Allow for smooth motion and an actual primitive-record seam during LT."""
    r = arithmetic
    shift = r.add(r.mul(target_speed, guard), position_jump)
    lower = r.sub(r.sub(r.sub(geometric_min, radius), shift), r.scalar(IMPLEMENTATION_POSITION_ALLOWANCE_KM))
    upper = r.add(r.add(r.add(geometric_max, radius), shift), r.scalar(IMPLEMENTATION_POSITION_ALLOWANCE_KM))
    delta = r.add(r.add(relative_speed, r.mul(target_acceleration, guard)), r.mul(frame_speed, radius))
    delta = r.add(delta, velocity_jump)
    light_speed = r.scalar(299792.458)
    speed = r.div(r.mul(delta, light_speed), r.sub(light_speed, target_speed))
    return lower, upper, r.add(speed, r.scalar(IMPLEMENTATION_SPEED_ALLOWANCE_KM_S))


def _disc_budget(arithmetic, minimum_range, range_rate, range_jump):
    """Bound asin(R_earth/range)' and its finite jump on the range domain."""
    r = arithmetic
    radius = r.scalar(EARTH_RADIUS_MAX_KM)
    root = r.sqrt(r.sub(r.mul(minimum_range, minimum_range), r.mul(radius, radius)))
    sensitivity = r.div(radius, r.mul(minimum_range, root))
    degrees = r.div(r.scalar(180), r.pi)
    return (r.mul(r.mul(sensitivity, range_rate), degrees),
            r.mul(r.mul(sensitivity, range_jump), degrees))


def validate_motion_envelope(raw, start, end, *, observer_radius_km=1740.0, step_seconds=3600,
                             precision=50, generator_commit=None, progress=None):
    """Enclose the entire requested interval in the pinned Newtonian kernel model.

    CN light time is bounded by contraction. The stellar-aberration derivative
    follows the NAIF rotation formula, not a sampled estimate. Record seams and
    an explicitly declared implementation allowance are charged to the existing
    angular padding; no formal bound on all CSPICE machine instructions is claimed.
    """
    if not all(math.isfinite(value) for value in (start, end, observer_radius_km, step_seconds)) or end <= start or observer_radius_km <= 0 or step_seconds <= 0:
        raise ValueError("Positive finite domain, observer radius and subdivision are required")
    arithmetic = _Rounded(precision)
    raw = Path(raw)
    sources = _source_files(raw)
    r = arithmetic
    scalar, add, sub, mul, div = r.scalar, r.add, r.sub, r.mul, r.div
    one = r.one
    extrema, series_cache = {}, {}

    def series(record):
        key = record["kind"], record["target"], record["index"]
        if key not in series_cache:
            base = [[scalar(value) for value in axis] for axis in record["coefficients"]]
            first = [_differentiate(axis, r) for axis in base]
            series_cache[key] = (base, first, [_differentiate(axis, r) for axis in first])
        return series_cache[key]

    def bounds(record, left, right, *, coefficients=None, orders=(0, 1, 2)):
        if left < record["midpoint"] - record["radius"] or right > record["midpoint"] + record["radius"]:
            raise ValueError("A subdivision crossed a record boundary")
        x = div(sub((scalar(left)[0], scalar(right)[1]), scalar(record["midpoint"])), scalar(record["radius"]))
        base = series(record) if coefficients is None else coefficients
        result = {}
        for order in orders:
            vector = [_clenshaw(axis, x, r) for axis in base[order]]
            for _ in range(order):
                vector = [div(component, scalar(record["radius"])) for component in vector]
            result[order] = vector
        return result

    def vector_sum(a, b):
        return [add(x, y) for x, y in zip(a, b, strict=True)]

    def vector_sub(a, b):
        return [sub(x, y) for x, y in zip(a, b, strict=True)]

    def maximum(key, value):
        extrema[key] = max(extrema.get(key, value), value)

    def minimum(key, value):
        extrema[key] = min(extrema.get(key, value), value)

    def sum_upper(values):
        total = Decimal(0)
        for value in values:
            total = r.up.add(total, value)
        return total

    with Ephemeris(raw) as ephemeris:
        coverage = ephemeris.assert_coverage(start, end)
        start_et, end_et = spice.str2et([_utc(t).strftime("%Y-%m-%d %H:%M:%S.%f UTC") for t in (start, end)])
        frame = spice.namfrm(FRAME)
        center, frame_class, class_id = spice.frinfo(frame)
        _, relative = spice.tkfram(class_id)
        if (center, frame_class, relative) != (301, 4, 31008):
            raise ValueError("The selected ME frame is not the pinned constant rotation from PCK31008")
        k, eb = (scalar(float(spice.gdpool(name, 0, 1)[0])) for name in ("DELTET/K", "DELTET/EB"))
        m_rate = scalar(float(spice.gdpool("DELTET/M", 0, 2)[1]))
        clock_denominator = sub(one, mul(mul(k, m_rate), add(one, eb)))
        clock_factor = div(one, clock_denominator)
        with _Type2Model(raw, start_et - 600, end_et) as model:
            partitions = model.partitions(step_seconds)
            # Include the exact right endpoint: its reader may select the next
            # record even though the preceding closed interval used the former.
            cells = [*pairwise(partitions), (model.end, model.end)]
            for index, (left, right) in enumerate(cells):
                midpoint = (left + right) / 2
                records = {body: model.record("spk", body, midpoint) for body in (3, 10, 301, 399)}
                pck = model.record("pck", 31008, midpoint)
                actual = {body: bounds(record, left, right) for body, record in records.items()}
                orientation = bounds(pck, left, right, orders=(1, 2))
                earth, moon = records[399], records[301]
                if earth["midpoint"] != moon["midpoint"] or earth["radius"] != moon["radius"]:
                    raise ValueError("Earth and Moon relative polynomials have different domains")
                relative_series = tuple([vector_sub(a, b) for a, b in zip(series(earth)[order], series(moon)[order], strict=True)] for order in range(3))
                relative_bounds = bounds(earth, left, right, coefficients=relative_series, orders=(0, 1))
                earth_geometry = r.norm(relative_bounds[0])
                minimum("earth_geometric_range_min_km", earth_geometry[0])
                maximum("earth_geometric_range_max_km", earth_geometry[1])
                maximum("earth_moon_relative_speed_km_s", r.norm(relative_bounds[1])[1])
                for body, label in ((399, "earth"), (301, "moon")):
                    maximum(label + "_barycentric_speed_km_s", r.norm(vector_sum(actual[3][1], actual[body][1]))[1])
                    maximum(label + "_barycentric_acceleration_km_s2", r.norm(vector_sum(actual[3][2], actual[body][2]))[1])
                maximum("sun_barycentric_speed_km_s", r.norm(actual[10][1])[1])
                maximum("sun_barycentric_acceleration_km_s2", r.norm(actual[10][2])[1])
                sun_geometry = r.norm(vector_sub(actual[10][0], vector_sum(actual[3][0], actual[301][0])))
                minimum("sun_geometric_range_min_km", sun_geometry[0])
                maximum("sun_geometric_range_max_km", sun_geometry[1])
                maximum("sun_moon_relative_speed_km_s", r.norm(vector_sub(actual[10][1], vector_sum(actual[3][1], actual[301][1])))[1])
                maximum("frame_angular_speed_rad_s", sum_upper(r.absolute_upper(value) for value in orientation[1]))
                maximum("euler_second_derivative_sum_rad_s2", sum_upper(r.absolute_upper(value) for value in orientation[2]))
                if progress and index % 500 == 0:
                    progress({"completed_intervals": index + 1, "interval_count": len(partitions) - 1})

            # Check every used piecewise-record seam. There can be at most one
            # seam per primitive along each <=256 s solver-midpoint-to-end path.
            seams = {key: {"position": Decimal(0), "velocity": Decimal(0)} for key in model.segments}
            seams_checked = 0
            for (kind, target, record_index), record in list(model.records.items()):
                previous = model.records.get((kind, target, record_index - 1))
                if previous is None:
                    continue
                point = record["midpoint"] - record["radius"]
                former, latest = bounds(previous, point, point, orders=(0, 1)), bounds(record, point, point, orders=(0, 1))
                difference = vector_sub(latest[0], former[0])
                if kind == "pck":
                    adjusted = []
                    for angle in difference:
                        turns = round(float(arithmetic.down.add(angle[0], angle[1])) / (4 * math.pi))
                        adjusted.append(sub(angle, mul(scalar(2 * turns), r.pi)))
                    position_jump = sum_upper(r.absolute_upper(angle) for angle in adjusted)
                    velocity_jump = sum_upper(r.absolute_upper(value) for value in vector_sub(latest[1], former[1]))
                else:
                    position_jump, velocity_jump = r.norm(difference)[1], r.norm(vector_sub(latest[1], former[1]))[1]
                seams[(kind, target)]["position"] = max(seams[(kind, target)]["position"], position_jump)
                seams[(kind, target)]["velocity"] = max(seams[(kind, target)]["velocity"], velocity_jump)
                seams_checked += 1

            def point_bound(key):
                value = extrema[key]
                return value, value

            def seam(kind, target, field):
                value = seams[(kind, target)][field]
                return value, value

            radius, light_speed = scalar(observer_radius_km), scalar(299792.458)
            omega = point_bound("frame_angular_speed_rad_s")
            observer_speed = add(point_bound("moon_barycentric_speed_km_s"), mul(omega, radius))
            observer_acceleration = add(point_bound("moon_barycentric_acceleration_km_s2"), mul(radius, add(point_bound("euler_second_derivative_sum_rad_s2"), mul(scalar(2), mul(omega, omega)))))
            beta, beta_dot = div(observer_speed, light_speed), div(observer_acceleration, light_speed)
            root = r.sqrt(sub(one, mul(beta, beta)))
            direction_factor = add(add(one, mul(scalar(2), beta)), div(mul(beta, beta), root))
            acceleration_factor = add(scalar(2), div(mul(scalar(2), beta), root))
            aberration_acceleration = mul(acceleration_factor, beta_dot)
            degrees_per_minute = div(scalar(10800), r.pi)
            final_bounds = {}
            for label, guard in (("earth", 2), ("sun", 600)):
                speed = point_bound(label + "_barycentric_speed_km_s")
                geometric_velocity = point_bound("earth_moon_relative_speed_km_s" if label == "earth" else "sun_moon_relative_speed_km_s")
                target_position_jump = add(seam("spk", 3, "position"), seam("spk", 399, "position")) if label == "earth" else seam("spk", 10, "position")
                target_velocity_jump = add(seam("spk", 3, "velocity"), seam("spk", 399, "velocity")) if label == "earth" else seam("spk", 10, "velocity")
                lower, upper, velocity = _retarded_budget(r, geometric_min=point_bound(label + "_geometric_range_min_km"),
                    geometric_max=point_bound(label + "_geometric_range_max_km"), relative_speed=geometric_velocity,
                    target_speed=speed, target_acceleration=point_bound(label + "_barycentric_acceleration_km_s2"),
                    radius=radius, frame_speed=omega, guard=scalar(guard),
                    position_jump=target_position_jump, velocity_jump=target_velocity_jump)
                angular = mul(add(add(omega, mul(direction_factor, div(velocity, lower))), aberration_acceleration), clock_factor)
                final_bounds[label + "_range_min_km"] = _float_endpoint(lower[0], upper=False)
                final_bounds[label + "_range_max_km"] = _float_endpoint(upper[1], upper=True)
                final_bounds[label + "_abs_range_rate_km_s"] = _float_endpoint(mul(velocity, clock_factor)[1], upper=True)
                final_bounds[label + "_angular_rate_deg_min"] = _float_endpoint(mul(angular, degrees_per_minute)[1], upper=True)
                final_bounds[label + "_light_time_max_s"] = _float_endpoint(div(upper, light_speed)[1], upper=True)

            rotation_jump = seam("pck", 31008, "position")
            rotation_speed_jump = add(seam("pck", 31008, "velocity"), mul(mul(scalar(2), omega), rotation_jump))
            observer_position_jump = add(add(seam("spk", 3, "position"), seam("spk", 301, "position")), mul(radius, rotation_jump))
            observer_velocity_jump = add(add(seam("spk", 3, "velocity"), seam("spk", 301, "velocity")), mul(radius, add(rotation_speed_jump, mul(omega, rotation_jump))))
            angular_jumps = {}
            implementation_angle = scalar(2 * IMPLEMENTATION_ANGULAR_POINT_ALLOWANCE_DEG)
            earth_range_jump = zero_range_jump = r.zero
            for label in ("earth", "sun"):
                target_position_jump = add(seam("spk", 3, "position"), seam("spk", 399, "position")) if label == "earth" else seam("spk", 10, "position")
                q_jump = add(observer_position_jump, target_position_jump)
                q_jump = add(q_jump, scalar(2 * IMPLEMENTATION_POSITION_ALLOWANCE_KM))
                # A position seam also changes converged light time. The
                # target-motion feedback amplifies the direct jump by c/(c-B).
                q_jump = div(mul(q_jump, light_speed), sub(light_speed, point_bound(label + "_barycentric_speed_km_s")))
                if label == "earth":
                    earth_range_jump = q_jump
                # For the tiny verified ratio, angle <=2*position_jump/range.
                direction_jump = div(mul(scalar(2), q_jump), scalar(final_bounds[label + "_range_min_km"]))
                stellar_jump = add(mul(direction_factor, direction_jump), mul(acceleration_factor, div(observer_velocity_jump, light_speed)))
                angular_jump = add(rotation_jump, stellar_jump)
                angular_jumps[label] = add(mul(angular_jump, div(scalar(180), r.pi)), implementation_angle)
            if earth_range_jump == zero_range_jump:
                raise ValueError("The Earth range-jump budget was not evaluated")
            radius_rate, radius_jump = _disc_budget(r, scalar(final_bounds["earth_range_min_km"]),
                                                   scalar(final_bounds["earth_abs_range_rate_km_s"]), earth_range_jump)
            eclipse_jump = add(add(angular_jumps["sun"], angular_jumps["earth"]), radius_jump)
            final_bounds["earth_disc_angular_radius_rate_deg_s"] = _float_endpoint(radius_rate[1], upper=True)
            final_bounds["earth_disc_radius_seam_allowance_deg"] = _float_endpoint(radius_jump[1], upper=True)
            final_bounds["eclipse_seam_and_implementation_allowance_deg"] = _float_endpoint(eclipse_jump[1], upper=True)
            final_bounds["angular_seam_and_implementation_allowance_deg"] = _float_endpoint(max(value[1] for value in angular_jumps.values()), upper=True)
            final_bounds["frame_angular_speed_rad_s"] = _float_endpoint(omega[1], upper=True)
            final_bounds["utc_to_tdb_rate_factor_max"] = _float_endpoint(clock_factor[1], upper=True)
            minimum_record_span = min(segment["span"] for segment in model.segments.values())
            checks = {
                "earth_angular_envelope": final_bounds["earth_angular_rate_deg_min"] < RATE_DEG_PER_S * 60,
                "sun_angular_envelope": final_bounds["sun_angular_rate_deg_min"] < RATE_DEG_PER_S * 60,
                "earth_minimum_range": final_bounds["earth_range_min_km"] > 350_000,
                "earth_radius_range_rate_assumption": final_bounds["earth_abs_range_rate_km_s"] < 2,
                "earth_retarded_guard": final_bounds["earth_light_time_max_s"] < 2,
                "sun_retarded_guard": final_bounds["sun_light_time_max_s"] < 600,
                "angular_padding_covers_seams_and_declared_implementation_allowance": final_bounds["angular_seam_and_implementation_allowance_deg"] < ANGULAR_PADDING_DEG,
                "earth_disc_radius_rate": final_bounds["earth_disc_angular_radius_rate_deg_s"] < 0.000006,
                "eclipse_padding_covers_centers_disc_radius_and_implementation_allowances": final_bounds["eclipse_seam_and_implementation_allowance_deg"] < 2 * ANGULAR_PADDING_DEG,
                "primitive_record_spans_exceed_solver_time_footprint": minimum_record_span > MAX_SOLVER_INTERVAL_SECONDS * 2,
                "primitive_record_spans_exceed_retarded_window": minimum_record_span > 600,
                "newtonian_convergence_document_assumptions": max(_float_endpoint(observer_speed[1], upper=True), _float_endpoint(point_bound("earth_barycentric_speed_km_s")[1], upper=True)) < 60 and final_bounds["sun_range_max_km"] < 50 * 149_597_870.7,
            }
            record_sources = [{key: record[key] for key in ("kind", "target", "index", "filename", "sha256")} for record in model.records.values()]

    with Path(__file__).open("rb") as stream:
        code_hash = file_digest(stream, "sha256").hexdigest()
    return {
        "version": "1.0.0", "status": "PASS" if all(checks.values()) else "FAIL", "checks": checks,
        "scope": "Conservative pinned-kernel piecewise-polynomial Newtonian CN+S enclosure, conditional on the explicit implementation allowances.",
        "polynomial_interval_enclosure": True, "formal_verification": False, "physical_model_error_bounded": False,
        "start_utc": _utc(start).isoformat().replace("+00:00", "Z"), "end_utc": _utc(end).isoformat().replace("+00:00", "Z"),
        "coverage": coverage, "observer_radius_upper_km": observer_radius_km, "subdivision_max_seconds": step_seconds,
        "interval_count": len(partitions) - 1, "endpoint_checks": 1, "seams_checked": seams_checked,
        "minimum_primitive_record_span_seconds": minimum_record_span,
        "bounds": final_bounds,
        "primitive_bounds": {key: _float_endpoint(value, upper=not key.endswith("min_km")) for key, value in extrema.items()},
        "rounding": {"precision_decimal_digits": precision, "method": "Binary64 coefficients converted exactly, Decimal FLOOR/CEILING interval Clenshaw and differentiated coefficients; sqrt enclosed by neighboring Decimals; float endpoints rounded outward.",
                     "pi_interval": [str(value) for value in r.pi]},
        "implementation_allowances": {"position_km": IMPLEMENTATION_POSITION_ALLOWANCE_KM,
                                       "speed_km_s": IMPLEMENTATION_SPEED_ALLOWANCE_KM_S,
                                       "angular_point_deg": IMPLEMENTATION_ANGULAR_POINT_ALLOWANCE_DEG,
                                       "qualification": "Declared conservative numerical allowances exercised by reconstruction tests, not a formal verification of every CSPICE instruction."},
        "formulae": ["omega <= sum |Euler angle derivatives|; observer v <= Moon barycentric v + omega*r.",
                     "Observer a <= Moon barycentric a + r*(sum |Euler angle second derivatives| + 2*omega^2).",
                     "For target speed B, acceleration A and retarded guard T: D = geometric relative speed + A*T + omega*r + target velocity-seam jump; |q'| <= D*c/(c-B) away from seams.",
                     "Retarded range >= geometric center range - observer radius - B*T - target position-seam jump. The upper range bounds every light-time iterate; smooth-piece contraction and seam allowances control the converged Newtonian result.",
                     "For b >= |observer v|/c, a >= |observer acceleration|/c, w >= uncorrected angular rate: stellar rate <= (1+2*b+b^2/sqrt(1-b^2))*w + (2+2*b/sqrt(1-b^2))*a.",
                     "Add the frame angular speed and scale by the pinned LSK UTC/TDB derivative bound.",
                     "Record boundary jumps and two pointwise implementation angular allowances must fit the existing angular padding.",
                     "The Earth disc-radius sensitivity is R_earth/[range*sqrt(range^2-R_earth^2)]; multiply by the range-rate or range-jump enclosure.",
                     "Sun-center jump + Earth-center jump + Earth disc-radius jump must fit 2*ANGULAR_PADDING_DEG; radius-rate must remain below 0.000006 deg/s."],
        "sources": SOURCES, "kernels": sources, "source_records": record_sources,
        "generator_commit": generator_commit, "code_sha256": code_hash,
        "limitations": ["No observational or physical accuracy is established; kernel fitting, lunar frame alignment and DEM uncertainty remain separate.",
                        "No terrain calculation is changed or validated by this motion enclosure.",
                        "General-relativistic deflection and gravitational light-time delay are outside the existing Newtonian CN+S model.",
                        "The pinned leap-second table defines future UTC conversion; future official leap-second decisions can change that convention.",
                        "The interval arithmetic is tested software, not machine-checked formal verification; implementation allowances are explicit assumptions."],
    }


def main():
    from science.domain_validation import _parse_epoch

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=Path("data/raw"))
    parser.add_argument("--start", type=_parse_epoch, required=True)
    parser.add_argument("--end", type=_parse_epoch, required=True)
    parser.add_argument("--observer-radius-km", type=float, default=1740)
    parser.add_argument("--step-seconds", type=float, default=3600)
    parser.add_argument("--precision", type=int, default=50)
    parser.add_argument("--generator-commit")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = validate_motion_envelope(args.raw, args.start, args.end, observer_radius_km=args.observer_radius_km,
                                     step_seconds=args.step_seconds, precision=args.precision, generator_commit=args.generator_commit)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(f"Pinned-kernel polynomial enclosure {report['status']}; formal verification and physical accuracy are not claimed.")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
