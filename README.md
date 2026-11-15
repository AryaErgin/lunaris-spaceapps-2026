# LUNARIS

**Integration preview:** ten modeled south-pole study points in the cinematic Mission / Compare / Advanced interface. This feature branch has not been merged into `main` or deployed; the live-app link below remains the separately managed public release.

Calculated terrain-aware coverage spans **426 days, from 1 November 2026 through 31 December 2027**, at ten NASA-sourced study points. The original November release remains preserved at `lunaris-stable-20261114` (`0d36904`); its 12-hour landing-delay example remains unchanged.

Explore sunlight and Earth visibility at ten NASA-sourced lunar south-pole study points. Compare arrivals, inspect bounded operating windows and find evaluated opportunities. Optional mission requirements and a landing-delay example explain what a changed schedule can cost.

[Open LUNARIS](https://aryaergin.github.io/lunaris-spaceapps-2026/) · [Watch the recorded demonstration](https://aryaergin.github.io/lunaris-spaceapps-2026/demo.html).

## Try it locally

For automatic updates while editing (Node.js 20.19+ or 22.12+):

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173/. On Windows PowerShell, use `npm.cmd` if script policy blocks `npm.ps1`.

For the offline app, Python 3.11+ is sufficient; no npm install or network is needed:

```sh
python serve.py
```

Open http://127.0.0.1:8000/. `serve.py` is a small standard-library launcher that pins the JavaScript module MIME type; plain `python -m http.server` serves `.mjs` as text on some Windows installations and the page then stays blank. All runtime code, images and data are local. A usable 2D analysis view remains available without WebGL.

## The landing-delay story

Choose **Try the landing-delay example** to load the 12-hour de Gerlache Rim 1 mission. Its illustrative requirements allow at most 7 hours without qualified Sun-center visibility and 2 hours with Earth hidden, and require 6 hours with both visible including one uninterrupted 2-hour window. These are not NASA or lander specifications.

1. **Original arrival: November 1, 2026, 06:00 UTC. PASS.** At least 7 h 53 min 52 s of confirmed joint visibility.
2. **Simulate 72-hour delay.** The surface scene and shared clock advance to November 4, 06:00 UTC. A 12-hour sunlight outage exceeds the 7-hour limit by 5 hours; joint visibility is zero. Earth visibility alone remains uncertain for that mission.
3. **Find next confirmed window.** November 17, 03:00 UTC passes with 12 hours of joint visibility, requiring a wait of 12 days 21 hours after the delayed arrival. This is the first confirmed start on the hourly search grid: 240 earlier starts fail and 69 remain uncertain. An earlier uncertain start is not proof that no earlier physical window exists.

Recovery also passes seven separately tested baseline/height/position/terrain cases. Those finite cases are not combined uncertainties, probabilities or a guarantee for other conditions. The older solar-only teaching example remains in Advanced.

## Explore, compare and inspect

- **Mission:** starts with environmental measurements and no mission verdict. Choose a study point, UTC arrival and view duration (12 hours if blank), then explore the Moon or LOLA surface. **Find landing opportunities** compares supported starts without requiring a delay. Environment searches show each site's largest confirmed joint-time lower bound on the selected grid; unresolved time can change the physical ranking. Open **Mission requirements & delay example** to enable or edit illustrative requirements; Advanced retains full controls. Explicit requirements produce PASS/FAIL/INDETERMINATE, signed margins and decision certificates. The delay story is optional. Scroll/pinch zooms over the scene; drag/arrow keys look; keyboard plus/minus zoom. Scroll outside the scene to move the page.
- **Show me how:** a first-visit offer (remembered locally) starts a skippable, replayable tour of the actual controls. It covers planning, the sky, playback, durations, optional requirements, comparison, searches and evidence. The real 72-hour delay example loads only after consent; **Restore my plan & exit** returns your saved inputs. Scientific charts remain available if 3D fails.
- **Orbital markers:** circles identify the ten terrain-aware study points; cyan diamonds identify curated Apollo, CLPS and international locations. Selecting a diamond opens that location's level-horizon explorer without changing the terrain-aware mission. Unknown local terrain is never replaced with another site's skyline.
- **Other landing sites:** below the Mission scene (open by default; also linked from the site selector and from Compare), pick an Apollo site, a NASA CLPS site, a Chandrayaan-3 or Chang’e 4 site, or type any lunar coordinate. LUNARIS shows approximate Sun and Earth elevation and bearing above the **level** horizon at the Mission clock and a chart across the cached dates. No terrain is included there, so it makes no visibility claim. The selected study point is drawn dashed in the same level-horizon model for contrast. **All cached dates** expands playback beyond the selected stay; UTC jumping selects a specific cached instant. **Try a 72-hour landing delay** starts the optional example.
- **Compare:** two independent sites/UTC arrivals share the same view duration, allowed schedule and any explicitly enabled requirements. Add an optional third option card. Environmental mode shows visibility bounds without mission badges; requirements mode explains each verdict. **View this option** synchronizes Mission. **Explore the month** shows a daily site calendar with previous/next month controls (or feasibility against enabled requirements). Automatic schedule bounds update when arrival/duration changes; bounds edited in Advanced remain fixed. Unsupported coverage, empty schedules, failed options and unresolved options are explained separately, with evaluated near misses when requirements apply.
- **Advanced:** edit limits and scheduling bounds; inspect timelines, horizon/angle plots, bounded metrics and provenance. Environmental records contain measurements with no mission verdict. With requirements enabled, sensitivity studies and version 2 decision certificates retain the inspected plan's identity separately from the original search and frozen generator. Unstamped local development exports leave the application release SHA null.

## Data and visual limits

Calculations cover these published region centers over **[2026-11-01 00:00, 2028-01-01 00:00) UTC**: 426 days. All observers stand 2 m above their own native DEM ground. Latitude is planetocentric, positive north; longitude is east-positive.

| Study point | Latitude | Longitude E | NASA local terrain |
|---|---:|---:|---|
| Connecting Ridge | −89.4632° | 222.5100° | PGDA Site 01 |
| Shackleton Rim | −89.7668° | 188.1300° | PGDA Site 04 |
| de Gerlache Rim 1 | −88.6834° | 292.0679° | PGDA Site 11 |
| Peak Near Shackleton | −88.8110° | 123.6901° | PGDA Site 07 |
| Nobile Rim 1 | -85.4381 | 37.36667 | PGDA Site 06 |
| Malapert Massif | -85.9948 | 359.76422 | PGDA Site 23 |
| Leibnitz Beta Plateau | -85.4266 | 31.74276 | PGDA Site 20 |
| de Gerlache-Kocher Massif | -85.8296 | 243.678 | PGDA Site 42 |
| Haworth | -86.7639 | 337.223 | PGDA Haworth |
| Nobile Rim 2 | -83.9540 | 58.82206 | PGDA DM2 |

The six additions retain native 5 m local and 80 m regional terrain within complete coverage, adding source-pinned 240 m outer-regional terrain to the 240 km horizon domain. Original four-site records, mesh bytes and finite-scenario arrays remain unchanged. Both numerical models and unresolved bounds are retained.

Mission limits are **user-supplied engineering inputs**, not values inferred from NASA data. The planner chooses evaluation duration, maximum Sun-center-unqualified run, maximum Earth-center blockage, minimum total joint visibility and minimum uninterrupted joint visibility. PASS means those selected geometric limits pass within the declared model; it does not establish electrical power, thermal survival, radio-link performance, landing safety or a complete spacecraft mission. The original illustrative 12-hour mission and 72-hour-delay example are unchanged.

See the [south-pole integration reference](science/SOUTHPOLE_INTEGRATION.md) for exact sources, scope, executed checks, sizes and frontend APIs, and the [release inventory](web/data/southpole-release.json) for artifact bindings. The nine historical/international locations remain secondary level-horizon education, without terrain-aware verdicts.

Coordinates come from the [NASA Lunar Surface Data Book](https://ntrs.nasa.gov/citations/20250002845); the additional point was checked against table A2.1-1, page 75. These are region centers, not approved landing pads. Shackleton's sampled native DEM gradient is about 31.5°; Peak Near Shackleton's is about 5.0°. Neither is a landing-safety determination. Every point has its own local/regional horizon and display mesh. Other coordinates have no terrain-aware decision. Missing coverage and unresolved crossings remain explicit.

The engine uses curved local/regional NASA LRO/LOLA terrain and SPICE `CN+S` in `MOON_ME_DE440_ME421`. East-positive longitude and clockwise-from-north azimuth are explicit. The combined 480 matched Horizons directions span 15 epochs at sixteen baseline/candidate/sensitivity observer cases; maximum separation remains below 0.000000518 degrees. Shared JPL lineage means this is an implementation check, not independent terrain or observational validation. Dense 60-second/interlaced 30-second checks and a separate kernel-polynomial motion enclosure support the unchanged solver assumptions. The enclosure is conditional on declared implementation allowances, not formal software verification or a physical-accuracy guarantee.

Monthly temporal grids are stitched without gaps or resets; November geometry and retained/coarse/fine intervals match the stable release exactly. All six finite variants cover the same extended dates. Large terrain/refinement uncertainty remains in some seasons: calculating a date does not establish convergence or a passing mission. Future UTC dates use frozen `naif0012.tls`; future leap-second decisions require updated kernels and revalidation. Automatic searches inspect a disclosed **30-day candidate window** without changing your allowed schedule or requirements; move arrival forward to inspect later dates. The optional delay example retains its original November schedule.

For Peak Near Shackleton, retained unresolved time is 23.53% for Sun and 10.61% for Earth across this period, with no missing-time intervals. Its monthly whole-period refinement diagnostic is not generally converged; per-mission decisions still require both numerical models to support each conclusion. The Site 07 SHA-256 is a locally computed retrieval pin, not a NASA-published checksum. Sparse independent native-point upper-envelope checks are model consistency evidence, not observational validation of the skyline.

The reduced display mesh extends 32 km with no vertical exaggeration. More distant terrain uses the nominal angular skyline projected at an artificial 200 km distance. These visuals never decide visibility. Cached sky positions are 30 minutes apart; in surface view bodies are hidden unless retained/coarse/fine intervals all confirm visibility. Fixed approximate Sun/Earth diameters are 0.53/1.9 degrees, in both the surface and orbital views; orbital distances are schematic. Earth's approximate lit phase follows the cached Sun direction, while its historical cloud-free composite and geographic face stay unregistered. Surface brightness uses a Lommel-Seeliger regolith approximation with restrained procedural display grain that adds no relief. Direct light is withheld when Sun-center visibility is blocked or unresolved at the observer; otherwise it shades slopes by their orientation. This display gate is not a full-disc illumination or terrain-cast-shadow calculation. A faint artificial fill preserves silhouettes; optional **Night assist** adds explicitly artificial light for terrain inspection. Neither models Earthshine or calibrated night brightness. Sun focus uses optical zoom without enlarging the disc. Sun glare is a camera-style illustration. No rocks or landing hazards are resolved.

**Geometric visibility is not electrical power, thermal survival, a working radio link, safe landing or trajectory reachability.** Center tests do not establish complete-disc illumination. PASS means only the declared model constraints pass. Finite sensitivity cases establish no universal robustness.

Level-horizon directions elsewhere rotate cached directions to the chosen coordinate, using a mean Earth–Moon distance for approximate parallax. Ninety Horizons reference angles at Apollo 11, Chang’e 4 and Blue Ghost 1 span the extended dates: measured maximum errors are 0.00110° for Sun and 0.02934° for Earth, below the unchanged 0.01°/0.05° test limits. This does not calculate local terrain. Apollo coordinates: [NSSDCA, Wagner et al. 2017](https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html). Blue Ghost Mission 1: [NSSDCA](https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=2025-010A). Chandrayaan-3: rounded coordinates supported by [JPL DSN analysis](https://ipnpr.jpl.nasa.gov/progress_report/42-240/42-240A.pdf), with the distinct LROC solution retained in the site catalog. Chang’e 4: [Liu et al. 2019](https://doi.org/10.1038/s41467-019-12278-3).

Sources and exact hashes: [offline scientific bundle](web/data/bundle.json), [Horizons comparison](web/data/horizons-validation.json), [terrain atlas](web/data/terrain-atlas.json), [display meshes](web/data/terrain-scenes.json), [rendering notes](web/data/rendering-notes.json), [visual assets](web/assets/visual-sources.json). NASA: [local LOLA](https://pgda.gsfc.nasa.gov/products/78), [regional LOLA](https://pgda.gsfc.nasa.gov/products/90), [Lunar Surface Data Book](https://ntrs.nasa.gov/citations/20250002845), [Horizons](https://ssd.jpl.nasa.gov/horizons/), [NAIF frame](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf). The entrant supplied the current [official challenge Resources](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/) text, which lists Horizons. LUNARIS uses that resource for reference-direction checks; the production ephemerides use SPICE. The official Resources tab could not be independently fetched by the development tools.

Moon imagery: NASA Goddard/SVS, Ernie Wright, LRO/LROC/LOLA teams, [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/) linked by [LRO Moon models](https://svs.gsfc.nasa.gov/14959/). Earth: [NASA Blue Marble](https://svs.gsfc.nasa.gov/2915/). The small preview loads first; desktop 4K detail loads automatically, with a smaller mobile texture. [Three.js r186](https://github.com/mrdoob/three.js/tree/r186) is bundled under its [MIT license](web/vendor/three-LICENSE.txt). NASA/third-party assets retain their publishers' terms; LUNARIS code uses MIT.

## Design system

All visual values come from [`web/tokens.css`](web/tokens.css), loaded before every other stylesheet. `styles.css`, `experience.css`, `judge.css` and `scene3d.css` contain no colour literals, font stacks or `:root` blocks of their own; change a token and the whole interface follows.

| Token group | Tokens | Purpose |
|---|---|---|
| Typefaces | `--font-display`, `--font-body`, `--font-mono` | Space Grotesk for headings and key results, Inter for body and controls, IBM Plex Mono for coordinates, timestamps and micro-labels |
| Type scale | `--text-xs` (13px) to `--text-5xl` (46px), `--weight-*`, `--leading-*`, `--tracking-*` | Nothing a visitor reads is below 13px; body copy is 15–16px |
| Structure | `--color-bg`, `--color-surface`, `--color-surface-elevated`, `--color-track`, `--color-border-subtle`, `--color-border`, `--color-border-strong` | Page, panels, raised cards, tracks and outlines |
| Text | `--color-text`, `--color-text-secondary`, `--color-text-muted`, `--color-on-accent` | All at or above WCAG AA on the surfaces they are used on |
| Meaning | `--color-sun`, `--color-earth`, `--color-pass`, `--color-fail`, `--color-indeterminate`, each with `-border` and `-surface` variants | Amber is always the Sun, cyan always Earth; statuses also carry an icon and a word |
| Roles | `--color-accent`, `--color-link`, `--color-focus` | Primary action, links and the keyboard focus ring |
| Shape and depth | `--space-1` to `--space-8`, `--radius-sm/md/lg/pill`, `--shadow-1/2` | Spacing scale, corner radii and elevation |
| Motion and focus | `--duration-fast/base/slow`, `--ease-standard`, `--focus-ring`, `--focus-offset` | Transitions and focus treatment; reduced motion is honoured |
| Layout | `--header-height`, `--rail-width`, `--content-max`, `--control-height`, `--scene-toolbar-height`, `--scene-height` | Sidebar, 3D viewport and touch-target sizing |

Fonts are self-hosted WOFF2 files in [`web/fonts`](web/fonts) (about 100 KB for the Latin sets) with `font-display: swap`; no font CDN is contacted. Inter, Space Grotesk and IBM Plex Mono are licensed under the SIL Open Font License 1.1; the notices are `web/fonts/LICENSE-*.txt`. Files come from the Fontsource 5.3.0 packages of each family.

Scientific colours drawn by scripts (the terrain atlas map and the month calendar shading) and the Three.js materials are not tokenised.

## Reproduce and verify

```sh
python -m pip install -r requirements-build.txt pytest
python -m pytest -q -rs
node --test tests/*.test.mjs
node tests/test_ui.mjs --require-recovery --height --position --terrain
node tests/test_ui.mjs --fixture
node tests/test_experience.mjs --require-extended --require-extended-site
node tests/test_onboarding.mjs
node tests/test_southpole_browser.mjs
node tests/test_site_browser.mjs
node tests/test_reconstruction.mjs
node tests/test_extended_planning_grid.mjs
```

Browser checks require Node.js 24 and Chrome/Chromium; set `LUNARIS_CHROME` for a nonstandard executable. The 3D test uses software ANGLE, not a real-device performance benchmark.

Historical four-site release checks: **117 Python tests and 137 Node tests passed, with zero skips**; the real-data/fixture analysis tests, comprehensive onboarding and required four-site annual 3D browser journey passed. An independent point-arithmetic audit checked 10 baseline/finite cases at 10,527 interior samples with zero contradictions; this is sampled model consistency, not continuous or observational proof. Monthly hourly-grid regression checked 118,524 explicit mission evaluations, including 72-hour delays and site ties. An exported Git artifact also ran with Internet requests blocked and no installed build dependencies.

Historical four-site local headless Chrome measurements at 1366×768 and 390×840: Intel integrated graphics loaded the textured scene in 1.03–1.11 s; fast full-cache playback measured 62–64 orbital and about 44 surface renderer-counted frames/s. SwiftShader software rendering measured 16–19 frames/s. These are fresh-document, cache-disabled local tests with uncontrolled OS file cache, not Internet-load or physical-phone results. That four-site primary JSON was 7,118,301 bytes (gzip estimate 2,178,787 bytes); packaged scientific data and all four display meshes total about 21.5 MB. Physical mobile performance and uncoached human comprehension remain unverified.

Ten-site cinematic integration checks: **155 Node tests passed; 175 Python tests passed and three native-source checks skipped because the six added raw rasters are absent in this checkout**. The real-data analysis, 17-step onboarding, complete 3D/fallback journey, registry browser and ten-site browser checks passed. The latter checked all ten own mesh hashes, actual globe selections and comparison results at 1366, 1920, 390 and 320 px, plus actual certificate downloads. These are executed browser tests, not uncoached human or physical-phone validation. The public release remains unchanged pending approval.

The ten-site primary JSON is **17,505,789 bytes**; ten lazy-loaded terrain meshes total **32,957,880 bytes**. Fresh local software-Chrome readiness measured 1.54?1.86 s across those four viewports; observed heaps after the ten-site workflows were approximately 143?162 MB. These local measurements are not Internet-load, hardware-GPU or physical-mobile guarantees.

Set `LUNARIS_REQUIRE_EXTENDED=1` for strict annual unit checks (PowerShell: `$env:LUNARIS_REQUIRE_EXTENDED='1'`). Actual annual tests must not silently pass against a November-only fallback. Raw assets are optional for runtime; raw-dependent Python checks report skips when absent.

To reproduce the extension, acquire the original NASA files with `python -m science.sources --clones`, then the pinned Site 07 with `python -m science.extended_sites --acquire` (480,670,183 bytes total for the eleven scientific inputs). Acquisition verifies existing/downloaded pins; `--verify` is a separate verification-only command. Preserve the four original reference files from the stable tag, without shell text conversion:

```sh
python -c "from pathlib import Path; import subprocess; p=Path('data/reference/stable'); p.mkdir(parents=True,exist_ok=True); [p.joinpath(n).write_bytes(subprocess.check_output(['git','show','lunaris-stable-20261114:web/data/'+n])) for n in ['bundle.json','height-study.json','position-study.json','terrain-study.json']]"
python -m science.extended --reference data/reference/stable/bundle.json --domain-validation web/data/domain-validation.json --horizons-validation web/data/horizons-validation.json --motion-enclosure web/data/motion-envelope.json --engine-commit "$(git rev-parse HEAD)" --additional-site
python -m science.scene_terrain
python -m science.rendering_notes
python -m science.validate_extension --bundle web/data/bundle.json --reference data/reference/stable/bundle.json --output data/cache/extended/point-validation.json
```

The builder verifies raw/kernel/code fingerprints, interval continuity and exact November parity before publishing. Intermediate source-checked caches live under ignored `data/cache/extended`; rebuilding all months takes substantial computation. [Dense domain checks](web/data/domain-validation.json), [kernel-model enclosure](web/data/motion-envelope.json) and [Horizons evidence](web/data/horizons-validation.json) record executed methods, versions, hashes and limitations. Rebuild visual assets with `python -m science.visual_assets` or `--images-only`. Runtime needs none of these build dependencies.

## AI use

Human teammates: Arya Ergin and Aras. Arya directed development with OpenAI Codex; Aras contributed through Anthropic Claude (Claude Code). AI assisted research, scientific implementation, rendering, tests, interface design and writing. Decisions are deterministic calculations from frozen data, with no runtime AI. NASA images are source-derived, not generative artwork. Frozen data notices describe their original generation; the current team and release disclosure are recorded in [attribution metadata](web/attribution.json). [NASA Space Apps AI guidance](https://github.com/nasa/spaceapps/discussions/1849).

For this ten-site branch, **178 Python and 151 Node tests passed with zero failures/skips**, together with the original T14 workflow and all-site desktop/mobile-width Chrome checks. The bundle is 17,505,789 bytes (gzip estimate 5,547,034); six added meshes total 19,774,728 bytes before compression. Current local SwiftShader fast-playback measurement is 16?19 renderer-counted frames/s; no new hardware-GPU or physical-phone performance result is claimed. Detailed bounds, provenance, measurement scope and integration instructions are in [the scientific handoff](science/SOUTHPOLE_INTEGRATION.md).
