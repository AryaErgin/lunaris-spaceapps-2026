# Ten-site south-pole scientific integration

This feature branch contains ten terrain-aware study points over **[2026-11-01 00:00, 2028-01-01 00:00) UTC**, 426 days. Each has 20,449 actual half-hour geometry samples, fourteen monthly partitions, its own curved terrain horizon, retained/coarse/fine intervals and a native-data 3D mesh. The final timestamp closes coverage; it does not permit missions beyond the cache.

The original Connecting Ridge, Shackleton Rim, de Gerlache Rim 1 and Peak Near Shackleton records remain identical to `d1dd61e`. Original mesh binaries and finite height/position/terrain scenario arrays are unchanged. Container hashes were rebound to the expanded bundle. The original 12-hour PASS → 72-hour delay → FAIL → November 17 03:00 UTC recovery is unchanged.

## Added inventory

Coordinates are planetocentric degrees north and east-positive longitude normalized to 0–360. All observers are 2 m above their own native DEM cell ground.

| ID | Study point | Latitude | Longitude E | Native PGDA tile |
|---|---|---:|---:|---|
| `nobile-rim-1` | Nobile Rim 1 | -85.4381 | 37.36667 | Site06 |
| `malapert-massif` | Malapert Massif | -85.9948 | 359.76422 | Site23 |
| `leibnitz-beta-plateau` | Leibnitz Beta Plateau | -85.4266 | 31.74276 | Site20 |
| `de-gerlache-kocher` | de Gerlache-Kocher Massif | -85.8296 | 243.678 | Site42 |
| `haworth` | Haworth | -86.7639 | 337.223 | Haworth |
| `nobile-rim-2` | Nobile Rim 2 | -83.9540 | 58.82206 | DM2 |

Exact published point source: [NASA Lunar Surface Data Book M2M-30044, table A2.1-1, p.75](https://ntrs.nasa.gov/citations/20250002845). These are original PGDA polygon centers with stated approximately 5–10 m positional accuracy, not surveyed or approved landing pads. Malapert's published -0.23578° E equals 359.76422° E; the other wrapped longitudes are retained explicitly in source metadata.

Nobile Rim 1/2, Malapert and Haworth names appear in NASA's [October 2024 candidate-region set](https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/). de Gerlache-Kocher is an older 2022 region absent from that nine-region list. The Leibnitz Beta feature is now named Mons Mouton; identical old/new candidate polygons are not established. A retained region name does not prove this exact older study point lies within a refined candidate polygon. Metadata uses dated source identities, not a current Artemis III landing claim.

## Terrain, geometry and uncertainty

- Local: [NASA PGDA78](https://pgda.gsfc.nasa.gov/products/78), nominal 5 m/pixel, DE421 `MOON_ME`, south-polar stereographic, radial metres above the 1,737,400 m sphere. Surface interpolation and unresolved small terrain remain limitations; pixel spacing is not effective resolution.
- Regional: existing 80 m PGDA90 terrain is scanned only within a complete source domain. The wider [60°S/240 m product](https://pgda.gsfc.nasa.gov/products/90) supplies the outer annulus to 240 km, with a 480 m overlap. The old raster's boundary is never extrapolated or replaced by a flat horizon. Seven new exact raw inputs total **664,729,233 bytes**; byte counts, URLs, retrieval SHA-256 pins and provenance are in `science/southpole-sources.json`. These are locally computed retrieval pins, not publisher checksums.
- Both independent settings remain: 1,800 bins/200 km and 3,600 bins/240 km, curved cell enclosures, explicit gaps/far cap, conservative temporal subdivision. Original `terrain.py`, `visibility.py`, `ephemerides.py`, `build.py`, `extended.py` and `web/engine.mjs` scientific semantics are unchanged.
- SPICE uses `MOON_ME_DE440_ME421`, `CN+S`, Earth target 399. The stronger executed kernel-polynomial motion enclosure covers observer radii through 1,743.802 km. Future dates retain the pinned leap-second convention.

Unresolved whole-cache time is not a confidence probability or an automatic failed mission:

| Added point | Sun unresolved | Earth unresolved |
|---|---:|---:|
| Nobile Rim 1 | 4.13% | 7.29% |
| Malapert Massif | 14.99% | 1.27% |
| Leibnitz Beta Plateau | 19.76% | 1.32% |
| de Gerlache-Kocher | 43.15% | 26.17% |
| Haworth | 4.68% | 1.34% |
| Nobile Rim 2 | 1.75% | 0.47% |

Whole-month convergence is not generally established. Every mission still checks both clipped numerical evaluations, retaining INDETERMINATE when required bounds or classifications are unresolved. No tolerance was widened. The six additions have no new probabilistic DEM or landing-position guarantee; existing finite sensitivity scenarios remain limited to their original study point. Shared JPL lineage and same-DEM checks do not establish independent observational terrain accuracy.

## User-defined requirements

Mission duration is the user's selected period at a fixed observer. The four adjustable limits are supplied by the planner: maximum Sun-center-unqualified run, maximum Earth-center blocked run, minimum total joint visibility and minimum uninterrupted joint visibility. NASA datasets supply terrain and geometry; they do not supply these engineering tolerances.

PASS applies only to those selected geometric limits and declared model bounds. Solar-center visibility does not establish panel energy or thermal survival. Earth-center LOS does not establish an antenna, ground-station path, RF budget, DSN availability or a working link. No spacecraft-specific presets or automatic hardware limits are introduced. The original illustrative mission requirements remain editable and clearly separate from vehicle certification.

## Frontend contract

Load the matching `web/data/bundle.json`, `terrain-scenes.json`, meshes, atlas and rendering notes together. No HTML, CSS, `app.mjs`, `scene3d.mjs` or onboarding source was changed in this branch.

```js
import {createAnalysisContext} from './site-analysis.mjs';
const analysis = createAnalysisContext(bundle);
const primary = analysis.listSites().filter(s => s.capability === 'terrain-aware'); // ten
const secondary = analysis.listSites().filter(s => s.capability === 'geometry-only'); // nine
const report = analysis.analyzeSite({siteId, inputs});
const compared = analysis.compareSites({siteIds: primary.map(s => s.id), inputs});
const recovery = analysis.replan({inputs, searchEnd});
```

All supplied mission inputs, duration, limits and schedule bounds are retained. Existing `evaluateStart`, `runMission`, opportunity searches, calendar and certificates also accept all ten directly from `bundle.sites`. Existing main selectors, orbital marker creation and per-site mesh loading derive from that array. Use capability metadata rather than hardcoded counts. Geometry-only rows have no terrain metrics/verdict and are excluded from recovery.

Existing rendering data URLs are unchanged. `terrain-scenes.json.bundleSha256` binds exact serialized bundle bytes; rendering notes bind the payload hash. The atlas is expanded to +/-224 km, 896 pixels, **500 m display spacing**; it is a display derivative only. The six new meshes each contain 91,897 vertices and 548,256 indices, with no missing display cells. Original four mesh hashes are retained.

The separate redesign owner should integrate this scientific branch's files, retain its own layout, and replace stale count labels using the registry. The public deployment remains unchanged until a separately approved integration/deployment. Avoid mixing old scene/overlay manifests with the new bundle.

## Executed acceptance

- Python: **178 passed, zero failures/skips**, including actual NASA-source mesh generation.
- Node: **151 passed, zero failures/skips**; original full site records, finite scenario arrays and demo are independently fingerprinted.
- New direct-SPICE/Horizons comparisons: **180**, maximum separation **5.16989e-7 degrees**, unchanged 0.01-degree limit. Combined original/new reference inventory: **480 at sixteen observer cases**, including original finite cases.
- Dense domain: **1,226,881 epochs per body per new observer**, using 60 s and interlaced 30 s checks. New-site interval audit: **7,104** direct-SPICE interior checks; sparse independent Cartesian horizon check: **2,520** native cell/model comparisons, zero contradictions.
- Actual-data Chrome: all ten selectors/atlas/own meshes/horizons/clocks and engine/metric comparisons at 1440x1000 and 390x840; ten real desktop canvas marker picks from different starting sites; rapid-load ordering; unchanged delay/recovery; no external requests, missing assets, exceptions or sideways overflow. Mobile is a desktop-browser viewport, not a physical-phone test.
- Original T14 browser workflow: PASS/FAIL/PASS, all **300 November calendar cells**, sensitivity/export parity and reduced motion passed.

Commands: `node --test tests/*.test.mjs`; `python -m pytest tests -q -p no:cacheprovider`; `node tests/test_southpole_browser.mjs`; `node tests/test_ui.mjs --require-recovery --height --position --terrain --screenshots`. Set `LUNARIS_SOUTHPOLE_RAW=data/raw` and `LUNARIS_SOUTHPOLE_PINS=science/southpole-sources.json` for the actual native-mesh test; absent raw inputs are explicitly skipped. Source/model hashes and executed scientific evidence are in `web/data/southpole-validation.json` and `southpole-release.json`. Private logs/screenshots stay ignored.

The main bundle grows from **7,118,301 to 17,505,789 bytes**; estimated gzip grows from 2,178,787 to 5,547,034 bytes. Six new meshes add **19,774,728 bytes** before compression and load by selected site. Fresh-document, cache-disabled local Chrome/SwiftShader readiness measured about **1.91 s desktop / 1.69 s mobile viewport**; observed JS heaps after all-site workflows were approximately **159 / 145 MB**. Fast full-cache playback measured 16?19 renderer-counted frames/s in SwiftShader over four five-second orbital/surface runs. These are local measurements, not network, hardware-GPU or physical-mobile performance guarantees. Raw NASA inputs are not in Git or required for offline viewing.

## Reproduce and run

`python serve.py --port 8137` runs the packaged offline app with only the standard library. For science rebuilds, install `requirements-build.txt`; acquire original pinned sources/clone inputs using existing scripts, Site07 using `science.extended_sites`, and the seven additions with `science.southpole_sites.acquire(Path('data/raw'))`.

Preserve `bundle.json`, three `*-study.json` files, `terrain-scenes.json` and its four mesh files byte-for-byte from `d1dd61e` under ignored `data/reference/southpole-baseline` (the build checks SHA-256). Do not use PowerShell text redirection for extraction. Then:

```sh
python -m science.southpole_expand --jobs 3 --engine-commit <verified-source-sha>
python -m science.southpole_validation --baseline data/reference/southpole-baseline/bundle.json --bundle data/cache/southpole/release/bundle.json --cache data/cache/southpole --archive data/raw/southpole-horizons --outdir data/cache/southpole/validation --generator-commit <verified-source-sha>
python -m science.southpole_release --engine-commit <verified-source-sha>
```

Drafts remain under ignored cache storage; only a complete passing acceptance report permits release assembly. Rebuild scientific dependencies before updating hashes; never stamp missing tests as passed. AI assisted research, implementation, tests and documentation under human oversight; calculations are deterministic and use no runtime AI. No NASA endorsement, landing approval or flight certification is asserted.
