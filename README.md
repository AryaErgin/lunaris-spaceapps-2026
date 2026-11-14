# LUNARIS

LUNARIS compares terrain-aware Sun-center visibility and Earth-center line of sight at three lunar south-pole study points. It evaluates a fixed-duration mission before and after a delay, then searches alternative starts under the same limits.

## Run the offline demo

From the repository root, start a local server with Python 3.11 or newer.

```sh
python -m http.server --bind 127.0.0.1 --directory web 8000
```

Open [LUNARIS](http://127.0.0.1:8000/) in a browser. The bundled data cover November 1 through November 30, 2026 UTC. No cookies, account, data download or external service are required to run the demo.

**de Gerlache Rim 1, November 2026.** A 12-hour mission starting Nov 1 at 06:00 UTC passes a 7-hour cap on continuous Sun-center unavailability. Moving the start 72 hours later produces a 12-hour unqualified interval from Nov 4 06:00 to 18:00 UTC. The first passing same-site start on the hourly search grid is Nov 6 at 12:00 UTC. Its conservative longest unqualified duration is 6 h 19 min. This demo isolates the solar constraint by allowing Earth-center blockage for the full 12-hour mission. The interface supports stricter Earth and joint-window limits.

Select a decision to see its timeline, hard-constraint margins and witness intervals. **Decision certificate** exports the inputs, results, search bounds, validation evidence, frame and source hashes. The default search stays at the selected study point. The prelaunch option allows comparison with the other sampled points.

## Reproduce and verify

```sh
python -m pip install -r requirements-build.txt pytest
python -m science.sources
python -m science.build
python -m pytest -q
node --test tests/engine.test.mjs
node tests/test_ui.mjs
```

The source download is about 358 MB. The browser test uses Node.js 24 and a local Chrome or Chromium installation. Set `LUNARIS_CHROME` to its executable if it is installed in a nonstandard location. [Bundled Horizons comparison](web/data/horizons-validation.json) records the exact reference queries, observer heights and numerical results. Run `python -m science.ephemerides --help` to repeat the reference comparison online. Build and raw-data dependencies are independent of the offline app.

## Model and limits

- Study points are the published Connecting Ridge, Shackleton Rim and de Gerlache Rim 1 region centers, with a 2 m observer height above the sampled ground. In the DE421 mean Earth/polar axis system, longitude is east-positive and azimuth increases clockwise from north. [NASA Lunar Surface Data Book, Table A2.1-1](https://ntrs.nasa.gov/citations/20250002845)
- The curved skyline uses nested 5 m and 80 m NASA LRO/LOLA grids. Nominal pixel spacing exceeds the effective detail in some areas because the grids include interpolated pixels. The model retains angular, range and time refinement differences and propagates coverage gaps. The exported metrics describe the DEM model at the declared scale. [Local LOLA grids](https://pgda.gsfc.nasa.gov/products/78) · [Regional LOLA grids](https://pgda.gsfc.nasa.gov/products/90) · [Barker et al.](https://doi.org/10.1016/j.pss.2020.105119)
- Apparent Sun and Earth directions use NAIF SPICE `CN+S` in `MOON_ME_DE440_ME421` and a 1,737.4 km reference sphere. An airless topocentric JPL Horizons cross-check at all three points returned a maximum angular difference of 0.000000482° over 24 comparisons. This compares implementations with shared JPL ephemeris lineage. [NAIF lunar frame](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf) · [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/)
- Numerical bounds overlap some visibility transitions and the modeled durations are reported with their bounds. Coarse/fine shifts above the two-minute target are flagged. A mission outside cached dates is indeterminate. PASS describes the declared surface-geometry limits. Solar-array output, complete solar-disc shadow, communications link closure, landing safety and trajectory reachability require separate analyses.

NASA data and terms remain with their respective publishers. The MIT license covers LUNARIS code. Source URLs, raster metadata, validation and SHA-256 hashes are embedded in the [offline evidence bundle](web/data/bundle.json). The [challenge organizer mirror](https://hackathlone.com/challenges/lunar-landing-site-navigator) lists JPL Horizons among the challenge resources. The [official challenge Resources tab](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/) was unavailable during verification.

## AI use

Arya Ergin directed the project as the sole human entrant. OpenAI Codex assisted with research, scientific implementation, tests, interface design and documentation. The offline app computes decisions deterministically from frozen NASA data products and uses no runtime AI. [NASA Space Apps AI guidance](https://github.com/nasa/spaceapps/discussions/1849)
