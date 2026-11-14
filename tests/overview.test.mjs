import test from 'node:test';
import assert from 'node:assert/strict';
import * as overview from '../web/overview.mjs';
test('visibility totals retain uncertain and missing time rather than counting it as visible', () => {
  assert.equal(typeof overview.visibilitySummary, 'function');
  const r = overview.visibilitySummary([[0,10,'visible'],[10,20,'uncertain'],[20,30,'blocked']],0,40);
  assert.deepEqual(r.seconds,{visible:10,blocked:10,uncertain:10,unknown:10});
});
test('next visibility transitions expose uncertainty bounds and cache censoring', () => {
  assert.equal(typeof overview.nextVisibilityEvents, 'function');
  const r=overview.nextVisibilityEvents([[0,10,'visible'],[10,20,'uncertain'],[20,30,'blocked'],[30,40,'uncertain'],[40,50,'visible']],5,[0,50]);
  assert.deepEqual(r.loss,[10,20]); assert.deepEqual(r.reacquisition,[30,40]);
  assert.equal(overview.nextVisibilityEvents([[0,50,'visible']],5,[0,50]).loss,null);
});
import fs from 'node:fs';
import {runMission} from '../web/engine.mjs';
const bundle=JSON.parse(fs.readFileSync(new URL('../web/data/bundle.json',import.meta.url)));
test('comparison evaluates every site at identical mission inputs using certified refinement',()=>{
 assert.equal(typeof overview.compareSites,'function');
 const before=JSON.stringify(bundle.demo);
 const rows=overview.compareSites(bundle,bundle.demo);
 assert.equal(rows.length,3);
 for(const row of rows){
  const expected=runMission(bundle,{...bundle.demo,siteId:row.siteId,mode:'same-site'});
  assert.deepEqual(row.nominal,expected.nominal); assert.deepEqual(row.delayed,expected.delayed);
 }
 assert.equal(JSON.stringify(bundle.demo),before);
});
test('missing coverage interrupts event inference and exact boundaries stay half-open',()=>{
 assert.equal(overview.nextVisibilityEvents([[0,10,'visible'],[20,30,'blocked']],5,[0,30]).loss,null);
 const r=overview.nextVisibilityEvents([[0,10,'visible'],[10,20,'blocked'],[20,30,'visible']],10,[0,30]);
 assert.equal(r.loss,null); assert.deepEqual(r.reacquisition,[20,20]);
});
import {communicationDemo} from '../web/overview.mjs';
test('real communication demonstration imposes binding Earth and joint limits without relaxing recovery',()=>{
 const i=communicationDemo(bundle); const r=runMission(bundle,i);
 assert.equal(i.maxEarthHours,2); assert.equal(i.minJointHours,6); assert.equal(i.minContinuousJointHours,2);
 assert.deepEqual([r.nominal.status,r.delayed.status,r.recommended.status],['PASS','FAIL','PASS']);
 assert(r.recommended.constraints.every(c=>c.status==='PASS'));
 assert.equal(r.recommended.constraints.find(c=>c.id==='max_earth_block').threshold,2);
});

test('refined event brackets enclose all refinements and withhold missing correspondence',()=>{
 const site={sun:[[0,10,'visible'],[10,50,'blocked']],refinementIntervals:{sun:{coarse:[[0,8,'visible'],[8,50,'blocked']],fine:[[0,12,'visible'],[12,50,'blocked']]}}};
 assert.deepEqual(overview.refinedEvents(site,'sun',0,[0,50]).loss,[8,12]);
 site.refinementIntervals.sun.fine=[[0,50,'visible']];
 assert.equal(overview.refinedEvents(site,'sun',0,[0,50]).loss,null);
});
test('local sky preserves sampled angles, half-open states, and missing data',()=>{
 const site={terrain:{skyline:[[0,1,2,1.5,-90]]}};
 const mission={timeline:{sun:[[0,10,'visible']],earth:[[0,10,'uncertain']]}};
 const r=overview.skySnapshot(site,[0,0,3,1.5,180,1,2],mission);
 assert.equal(r.sun.azimuth,0);assert.equal(r.earth.elevation,1);assert.equal(r.earth.state,'uncertain');
 assert.equal(overview.skySnapshot(site,[10,0,3,1.5,180,1,2],mission).sun.state,'unknown');
 assert.equal(overview.skySnapshot(site,[0,null,null,null,180,1,2],mission).sun.azimuth,null);
});

test('all real sites retain sampled Sun/Earth geometry and refinement event enclosures',async()=>{
 const {readFile}=await import('node:fs/promises');const b=JSON.parse(await readFile(new URL('../web/data/bundle.json',import.meta.url),'utf8'));
 for(const site of b.sites) {
  const sample=site.geometry[0],m={timeline:{sun:site.sun,earth:site.earth}};
  const sky=overview.skySnapshot(site,sample,m);
  assert.equal(sky.sun.elevation,sample[2]);assert.equal(sky.earth.elevation,sample[5]);
  for(const channel of ['sun','earth']) {
   const e=overview.refinedEvents(site,channel,b.coverage[0],b.coverage);
   for(const key of ['loss','reacquisition'])if(e[key])for(const t of [site[channel],site.refinementIntervals[channel].coarse,site.refinementIntervals[channel].fine]) {
    const r=overview.nextVisibilityEvents(t,b.coverage[0],b.coverage)[key];
    assert(e[key][0]<=r[0]&&e[key][1]>=r[1]);
   }
  }
 }
});
