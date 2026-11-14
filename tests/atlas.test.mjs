import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';

async function atlasModule() {
  assert(existsSync(new URL('../web/atlas.mjs',import.meta.url)), 'coordinate atlas is missing');
  return import('../web/atlas.mjs');
}
const metadata={projection:{radiusM:1737400},display:{boundsM:[-64000,-64000,64000,64000],width:640,height:640,noDataRuns:[]}};
const bundle={sites:[{id:'point',name:'Known point',lat:-89.4632,lon:222.51}]};

test('south polar map puts 0E up, 90E right, 180E down and 270E left',async()=>{
  const {projectToMap,mapToCoordinate}=await atlasModule();
  assert.deepEqual(projectToMap(-90,0,metadata),{x:320,y:320});
  const [up,right,down,left]=[0,90,180,270].map(lon=>projectToMap(-89,lon,metadata));
  assert(up.y<320);assert.equal(up.x,320);
  assert(right.x>320);assert(Math.abs(right.y-320)<1e-10);
  assert(down.y>320);assert(left.x<320);
  const point=projectToMap(-88.6834,292.0679,metadata);
  const roundtrip=mapToCoordinate(point.x,point.y,metadata);
  assert(Math.abs(roundtrip.lat+88.6834)<1e-10);assert(Math.abs(roundtrip.lon-292.0679)<1e-10);
});

test('only an exact cached point enables selection and wrapped west longitude matches',async()=>{
  const {inspectCoordinate}=await atlasModule();
  const exact=inspectCoordinate(bundle,metadata,-89.4632,-137.49);
  assert.equal(exact.siteId,'point');assert.equal(exact.calculationSupported,true);
  const nearby=inspectCoordinate(bundle,metadata,-89.4631,222.51);
  assert.equal(nearby.calculationSupported,false);assert.equal(nearby.siteId,null);
  assert.match(nearby.message,/unsupported terrain-aware calculation/i);
  assert.equal(nearby.coverage,'display-valid');
});

test('coverage preserves DEM gaps and off-map coordinates without treating either as a result',async()=>{
  const {inspectCoordinate}=await atlasModule();
  const gaps={...metadata,display:{...metadata.display,noDataRuns:[[205120,1]]}};
  assert.equal(inspectCoordinate(bundle,gaps,-90,0).coverage,'display-no-data');
  const outside=inspectCoordinate(bundle,metadata,0,0);
  assert.equal(outside.coverage,'outside-display');assert.equal(outside.calculationSupported,false);
  assert.equal(inspectCoordinate(bundle,metadata,'',0).valid,false);
  assert.equal(inspectCoordinate(bundle,metadata,NaN,0).valid,false);
  assert.equal(inspectCoordinate(bundle,metadata,-91,0).valid,false);
  assert.equal(inspectCoordinate(bundle,metadata,-89,361).valid,false);
});
