# LUNARIS

Explore sunlight and Earth visibility at three NASA-sourced lunar south-pole study points. Compare arrivals, inspect bounded operating windows and find evaluated opportunities. Optional mission requirements and a landing-delay example explain what a changed schedule can cost.

[Open the application](https://aryaergin.github.io/lunaris-spaceapps-2026/) · [Watch the actual 29-second demonstration](https://aryaergin.github.io/lunaris-spaceapps-2026/demo.html).

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

- **Mission:** starts with environmental measurements and no mission verdict. Choose a study point, UTC arrival and view duration (12 hours if blank), then explore the Moon or LOLA surface. **Find landing opportunities** compares supported starts without requiring a delay. Environment searches show each site's largest confirmed joint-time lower bound on the selected grid; unresolved time can change the physical ranking. Enable illustrative requirements or evaluate your own limits in Advanced to obtain PASS/FAIL/INDETERMINATE, signed margins and decision certificates. The delay story is optional. Scroll/pinch zooms over the scene; drag/arrow keys look; keyboard plus/minus zoom. Scroll outside the scene to move the page.
- **Compare:** two independent sites/UTC arrivals share the same view duration, allowed schedule and any explicitly enabled requirements. Add an optional third. Environmental mode shows visibility bounds without mission badges; requirements mode explains each verdict. **View this option** synchronizes Mission. **Explore the month** shows a daily, three-site visibility calendar (or feasibility against enabled requirements). Automatic schedule bounds update when arrival/duration changes; bounds edited in Advanced remain fixed. Unsupported coverage, empty schedules, failed options and unresolved options are explained separately, with evaluated near misses when requirements apply.
- **Advanced:** edit limits and scheduling bounds; inspect timelines, horizon/angle plots, bounded metrics and provenance. Environmental records contain measurements with no mission verdict. With requirements enabled, sensitivity studies and version 2 decision certificates retain the inspected plan's identity separately from the original search and frozen generator. Unstamped local development exports leave the application release SHA null.

## Data and visual limits

Calculations cover only the published Connecting Ridge, Shackleton Rim and de Gerlache Rim 1 region centers, with 2 m observers, from November 1 to December 1, 2026 UTC (exclusive end). These are study coordinates, not approved landing pads. Shackleton's sampled local DEM gradient is about 31.5 degrees. Other coordinates can be located in the atlas but have no supported terrain-aware decision. Missions outside cached coverage remain indeterminate.

The engine uses curved local/regional NASA LRO/LOLA terrain and SPICE `CN+S` in `MOON_ME_DE440_ME421`. East-positive longitude and clockwise-from-north azimuth are explicit. Its 24-direction airless topocentric Horizons comparison has a maximum separation of 0.000000482 degrees; shared JPL lineage means that comparison does not independently validate terrain. Numerical/model intervals retain gaps and refinement disagreements.

The reduced display mesh extends 32 km with no vertical exaggeration. More distant terrain uses the nominal angular skyline projected at an artificial 200 km distance. These visuals never decide visibility. Cached sky positions are 30 minutes apart; in surface view bodies are hidden unless retained/coarse/fine intervals all confirm visibility. Fixed approximate Sun/Earth diameters are 0.53/1.9 degrees, in both the surface and orbital views; orbital distances are schematic. Earth's approximate lit phase follows the cached Sun direction, while its historical cloud-free composite and geographic face stay unregistered. Surface brightness uses a Lommel-Seeliger regolith approximation with restrained procedural display grain that adds no relief; cast shadows are not rendered, so only slopes turned from the Sun darken. Sun focus uses optical zoom without enlarging the disc. Sun glare is a camera-style illustration. No rocks or landing hazards are resolved.

**Geometric visibility is not electrical power, thermal survival, a working radio link, safe landing or trajectory reachability.** Center tests do not establish complete-disc illumination. PASS means only the declared model constraints pass. Finite sensitivity cases establish no universal robustness.

Sources and exact hashes: [offline scientific bundle](web/data/bundle.json), [Horizons comparison](web/data/horizons-validation.json), [terrain atlas](web/data/terrain-atlas.json), [display meshes](web/data/terrain-scenes.json), [rendering notes](web/data/rendering-notes.json), [visual assets](web/assets/visual-sources.json). NASA: [local LOLA](https://pgda.gsfc.nasa.gov/products/78), [regional LOLA](https://pgda.gsfc.nasa.gov/products/90), [Lunar Surface Data Book](https://ntrs.nasa.gov/citations/20250002845), [Horizons](https://ssd.jpl.nasa.gov/horizons/), [NAIF frame](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf). The entrant supplied the current [official challenge Resources](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/) text, which lists Horizons. LUNARIS uses that resource for reference-direction checks; the production ephemerides use SPICE. The official Resources tab could not be independently fetched by the development tools.

Moon imagery: NASA Goddard/SVS, Ernie Wright, LRO/LROC/LOLA teams, [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/) linked by [LRO Moon models](https://svs.gsfc.nasa.gov/14959/). Earth: [NASA Blue Marble](https://svs.gsfc.nasa.gov/2915/). The small preview loads first; desktop 4K detail loads automatically, with a smaller mobile texture. [Three.js r186](https://github.com/mrdoob/three.js/tree/r186) is bundled under its [MIT license](web/vendor/three-LICENSE.txt). NASA/third-party assets retain their publishers' terms; LUNARIS code uses MIT.

## Reproduce and verify

```sh
python -m pip install -r requirements-build.txt pytest
python -m pytest -q -rs
node --test tests/*.test.mjs
node tests/test_ui.mjs --require-recovery --height --position --terrain
node tests/test_ui.mjs --fixture
node tests/test_experience.mjs
```

Browser checks require Node.js 24 and Chrome/Chromium; set `LUNARIS_CHROME` for a nonstandard executable. The 3D test uses software ANGLE, not a real-device performance benchmark.

Rebuilding science additionally requires about 439 MB of NASA source files: `python -m science.sources --clones`, then `python -m science.build`, `science.atlas`, `science.scene_terrain`, `science.rendering_notes`, `science.height_study`, `science.position_study` and `science.terrain_study`. Rebuild images with `python -m science.visual_assets` (pinned npm renderer build) or `--images-only`. Runtime needs none of these build dependencies.

## AI use

Human teammates: Arya Ergin and Aras. Arya directed development with OpenAI Codex; Aras contributed through Anthropic Claude (Claude Code). AI assisted research, scientific implementation, rendering, tests, interface design and writing. Decisions are deterministic calculations from frozen data, with no runtime AI. NASA images are source-derived, not generative artwork. Frozen data notices describe their original generation; the current team and release disclosure are recorded in [attribution metadata](web/attribution.json). [NASA Space Apps AI guidance](https://github.com/nasa/spaceapps/discussions/1849).
