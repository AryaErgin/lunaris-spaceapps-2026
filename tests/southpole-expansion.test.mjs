import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {evaluateStart,runMission} from '../web/engine.mjs';
import {communicationDemo} from '../web/overview.mjs';
import {createAnalysisContext} from '../web/site-analysis.mjs';
import {orbitalMarkerRecords} from '../web/scene3d.mjs';
import {projectToMap} from '../web/atlas.mjs';
const read=name=>JSON.parse(readFileSync(new URL('../web/data/'+name,import.meta.url)));
const bundle=read('bundle.json'),scenes=read('terrain-scenes.json'),atlas=read('terrain-atlas.json');
const frozen=JSON.parse(readFileSync(new URL('./fixtures/southpole-baseline.json',import.meta.url)));
const additions=[['nobile-rim-1',-85.4381,37.36667],['malapert-massif',-85.9948,359.76422],
 ['leibnitz-beta-plateau',-85.4266,31.74276],['de-gerlache-kocher',-85.8296,243.678],
 ['haworth',-86.7639,337.223],['nobile-rim-2',-83.954,58.82206]];
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');

test('ten modeled south-pole sites preserve complete original records, scenario payloads and recovery',()=>{
 assert.equal(bundle.sites.length,10);
 for(const[id,hash]of Object.entries(frozen.sites))assert.equal(digest(bundle.sites.find(s=>s.id===id)),hash,id);
 for(const[name,hash]of Object.entries(frozen.scenarios))assert.equal(digest(read(name+'-study.json').scenarios),hash,name);
 const result=runMission(bundle,communicationDemo(bundle));
 assert.deepEqual([result.nominal.status,result.delayed.status,result.recommended.status],['PASS','FAIL','PASS']);
 assert.equal(result.recommended.start,Date.parse('2026-11-17T03:00:00Z')/1000);
 assert.deepEqual(bundle.coverage,[Date.parse('2026-11-01T00:00Z')/1000,Date.parse('2028-01-01T00:00Z')/1000]);
});

test('each new observer has its own native terrain, full annual data, mesh and map/orbital marker',()=>{
 assert.equal(scenes.bundleSha256,createHash('sha256').update(readFileSync(new URL('../web/data/bundle.json',import.meta.url))).digest('hex'));
 const markers=orbitalMarkerRecords(bundle.sites);
 for(const[id,lat,lon]of additions){
  const site=bundle.sites.find(s=>s.id===id);assert(site,id);assert.equal(site.lat,lat);assert.equal(site.lon,lon);
  assert.equal(site.isApprovedLandingPad,false);assert.equal(site.geometry.length,20449);assert.equal(site.monthlyRefinement.length,14);
  for(const level of ['coarse','fine']){
   const model=site.terrain[level];assert.equal(model.local.spacingM,5);assert.equal(model.regional.spacingM,80);assert.equal(model.outerRegional.spacingM,240);
   assert.equal(model.local.sampledMaskedCells,0);assert.equal(model.regional.sampledMaskedCells,0);assert.equal(model.outerRegional.sampledMaskedCells,0);
  }
  for(const channel of ['sun','earth'])for(const rows of [site[channel],...Object.values(site.refinementIntervals[channel])]){
   let cursor=bundle.coverage[0];for(const[a,b,state]of rows){assert.equal(a,cursor);assert(b>a);assert(['visible','blocked','uncertain','unknown'].includes(state));cursor=b;}
   assert.equal(cursor,bundle.coverage[1]);
  }
  const mesh=scenes.sites.find(s=>s.siteId===id);assert(mesh);assert(mesh.vertexCount>50000);assert.equal(mesh.missingCellCount,0);
  assert.equal(mesh.sha256,createHash('sha256').update(readFileSync(new URL('../web/data/'+mesh.positionFile,import.meta.url))).digest('hex'));
  assert(markers.some(m=>m.point.id===id));const point=projectToMap(lat,lon,atlas);
  assert(point.x>=0&&point.x<=atlas.display.width&&point.y>=0&&point.y<=atlas.display.height,id+' inside authentic atlas');
 }
 for(const[id,hash]of Object.entries(frozen.meshes))assert.equal(scenes.sites.find(s=>s.siteId===id).sha256,hash);
 assert.equal(atlas.display.spacingM[0],500);
});

test('all ten use authoritative mission engine and nine context locations stay geometry-only',()=>{
 const context=createAnalysisContext(bundle),inputs=communicationDemo(bundle);
 assert.equal(context.listSites().filter(s=>s.capability==='terrain-aware').length,10);
 assert.equal(context.listSites().filter(s=>s.capability==='geometry-only').length,9);
 const comparison=context.compareSites({inputs});assert.equal(comparison.rows.length,19);
 for(const site of bundle.sites){
  const row=comparison.rows.find(r=>r.site.id===site.id);assert.deepEqual(row.decision,evaluateStart(bundle,inputs,site.id));
  assert(row.terrainMetrics);assert.equal(row.eligibleForTerrainComparison,true);
  const outside=context.analyzeSite({siteId:site.id,inputs:{...inputs,nominal:bundle.coverage[1]-3600,latest:bundle.coverage[1]}});
  assert.equal(outside.coverageStatus,'INCOMPLETE');assert.notEqual(outside.decision.status,'PASS');
 }
 assert.equal(bundle.manifest.validation.southpoleExpansion.status,'PASS');
 assert.equal(bundle.manifest.validation.horizons.comparison_count,480);
 assert.equal(bundle.manifest.validation.motionDomain.sites.length,16);
});
