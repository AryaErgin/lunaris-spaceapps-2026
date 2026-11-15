# Site exploration API

`web/site-registry.mjs` and `web/site-analysis.mjs` provide the shared scientific interface for the redesigned frontend. They require no layout changes, external services or new scientific rasters. `web/data/site-catalog.json` is the canonical source record for the nine historical locations. Existing `anysite.mjs` exports remain compatible.

```js
import {createAnalysisContext} from './site-analysis.mjs';
const analysis = createAnalysisContext(bundle); // treat the loaded bundle as immutable
const sites = analysis.listSites();
const report = analysis.analyzeSite({
  siteId: 'apollo-11', time: utcSeconds,
  range: [startUtcSeconds, endUtcSeconds],
});
const comparison = analysis.compareSites({
  siteIds: sites.map(site => site.id), time: utcSeconds,
  range: [startUtcSeconds, endUtcSeconds],
});
```

Display every registry entry in site discovery and map/comparison selectors. Use `capability` and `capabilities`, never an ID list or fixed site count. `geometry-only` sites expose approximate Sun/Earth azimuth/elevation and level-horizon estimates; `terrain-aware` sites additionally expose authoritative terrain metrics. `terrainCoverage` is null for unsupported terrain. Preserve coordinate source, native control solution, east-longitude convention, historical year and limitations. Do not relabel these predictions as historical landing conditions.

`analyzeSite({coordinates:{lat,lon}, ...})` supports arbitrary lunar coordinate exploration. Only an exact cached point (after east-longitude normalization) inherits terrain support; nearby coordinates remain geometry-only. An unsupported coordinate never receives another site's horizon.

With original mission inputs, `analyzeSite({siteId, inputs})` delegates terrain decisions unchanged to `evaluateStart`. Its `decision` is null when requirements are absent or terrain is unsupported. Geometry-only rows return `supportStatus:'UNSUPPORTED'`, `reasonCodes:['TERRAIN_NOT_AVAILABLE']`, `terrainMetrics:null`, and `eligibleForTerrainComparison:false`. These are capability labels, not PASS/FAIL/INDETERMINATE mission verdicts. Keep their level-horizon estimates visually distinct from terrain visibility and never rank them as feasible recovery alternatives.

`compareSites({siteIds, time, range, inputs})` applies the same UTC window and supplied limits to all rows. A supplied range must exactly match the mission inputs. No requirements, duration or thresholds are silently changed. Mixed comparisons retain the different capability levels. Cross-site planning remains a prelaunch concept comparison; it establishes no trajectory or post-landing reachability.

`analysis.replan({inputs,searchEnd})` accepts terrain-backed sites only and delegates to `runMission`. Geometry-only searches are rejected. Existing four-site certificates continue through `engine.mjs` unchanged. Do not pass geometry-only rows to `makeCertificate`, or insert level-horizon signs into `bundle.sites` as visibility evidence.

`sky.time` / `sky.sampleTime` identify the actual preceding cached sample. `sky.requestedTime` and `sampleAgeSeconds` disclose its age; no sub-sample astronomical precision is claimed. Queries outside cached coverage return `sky:null`. `levelGeometry` integrates a piecewise-linear elevation approximation and identifies each crossing's sample bracket. These are estimates, not certified event enclosures; narrow unsampled events can be missed. Missing samples and out-of-cache duration remain `unknownSeconds`. These values are not solar energy, terrain-qualified sunlight hours or RF contact time.

The catalog identifies candidate local NAC DTMs (2–5 m native spacing) and regional SLDEM2015 (~59 m latitude spacing) or polar LOLA (60 m). Product availability, nominal resolution and RMS precision do not establish coverage, error enclosures or validated horizons. The nine additional locations remain geometry-only until coordinate registration, complete local/regional masks, curved cell footprints, numerical refinement and visibility validation are completed. Existing 5 m south-pole terrain is not replaced by these candidate products.

Primary coordinate sources include NASA NSSDCA for Apollo, post-landing LROC for Blue Ghost, JPL/ISRO research for Chandrayaan-3, and the original CE2TMap2015 localization paper/CNSA for Chang'e-4. The catalog preserves Chandrayaan-3's distinct LROC solution and Chang'e-4's documented ~415 m LRO control discrepancy. Neither is silently treated as identical terrain registration.

Verification:

```sh
node --test tests/site-registry.test.mjs tests/anysite.test.mjs tests/release-demo.test.mjs
node tests/test_site_browser.mjs
```

AI assistance was used for source research, implementation, tests and documentation; no NASA endorsement or flight qualification is implied. This interface does not change the existing layout, app controller, scene renderer or onboarding. The redesign owner must connect its selectors and comparisons to this API before claiming primary-UI integration.
