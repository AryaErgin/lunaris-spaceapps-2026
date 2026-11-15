import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

async function sceneModule() {
  assert(existsSync(new URL('../web/scene3d.mjs',import.meta.url)), 'immersive scene renderer is missing');
  return import('../web/scene3d.mjs');
}

test('surface illumination follows confirmed Sun-center visibility and enhanced fill cannot create sunlight',async()=>{
  const {surfaceLightState}=await sceneModule();
  const day=surfaceLightState('visible',true,false),blocked=surfaceLightState('blocked',true,false);
  assert(day.direct>0);assert.equal(blocked.direct,0);assert(blocked.ambient<day.ambient/20);assert.equal(blocked.fill,0);
  for(const state of ['blocked','uncertain','unknown']){
    assert.equal(surfaceLightState(state,true,true).direct,0);
    assert.equal(surfaceLightState(state,true,false).direct,0);
  }
  const assist=surfaceLightState('blocked',true,true);assert(assist.ambient>blocked.ambient);assert(assist.fill>blocked.fill);assert.equal(assist.enhanced,true);
  assert.equal(surfaceLightState('visible',false,true).direct,0,'Missing direction cannot create a sunlight direction.');
});

test('body visibility is withheld for every unresolved state and invalid geometry', async () => {
  const { renderedBodies } = await sceneModule();
  const sample = [100,350,3,2,72,2.9,1.8];
  assert.deepEqual(renderedBodies(sample,{sun:'visible',earth:'visible'}),{sun:true,earth:true});
  for (const state of ['blocked','uncertain','unknown',undefined]) {
    assert.deepEqual(renderedBodies(sample,{sun:state,earth:state}),{sun:false,earth:false});
  }
  assert.deepEqual(renderedBodies(null,{sun:'visible',earth:'visible'}),{sun:false,earth:false});
  assert.deepEqual(renderedBodies([100,NaN,3,2,72,null,1.8],{sun:'visible',earth:'visible'}),{sun:false,earth:false});
  // A curved terrain skyline can be negative: radial elevation zero is not a visibility boundary.
  assert.deepEqual(renderedBodies([100,350,-.1,-.2,72,-.1,-.2],{sun:'visible',earth:'visible'}),{sun:true,earth:true});
});

test('Moon markers keep east-positive right-handed body-fixed coordinates', async () => {
  const { moonFixedPosition } = await sceneModule();
  const close=(actual,expected)=>actual.forEach((v,i)=>assert(Math.abs(v-expected[i])<1e-12));
  close(moonFixedPosition(0,0),[1,0,0]);
  close(moonFixedPosition(90,0),[0,1,0]);
  close(moonFixedPosition(0,90),[0,0,-1]);
  close(moonFixedPosition(-90,42),[0,-1,0]);
});

test('mobile overview fits a complete Moon silhouette inside seventy percent canvas width', async () => {
  const { orbitalOverviewDistance } = await sceneModule();
  for(const [width,height] of [[390,680],[375,570],[768,680],[390,360]]) {
    const distance=orbitalOverviewDistance(width,height);
    const moonHalfAngle=Math.asin(1/distance);
    const horizontalHalfFov=Math.atan(Math.tan(39*Math.PI/360)*width/height);
    assert(moonHalfAngle<horizontalHalfFov*.7);
  }
  assert.equal(orbitalOverviewDistance(1440,755),3.3);
});

test('overview reset keeps a recognizable near side and exposes the modeled south-pole points', async () => {
  const { orbitalOverviewPosition,orbitalOverviewDistance } = await sceneModule();
  assert.equal(typeof orbitalOverviewPosition,'function','overview reset pose is missing');
  for(const [width,height] of [[1440,755],[390,680]]) {
    const [x,y,z]=orbitalOverviewPosition(width,height),radius=Math.hypot(x,y,z);
    assert(Math.abs(radius-orbitalOverviewDistance(width,height))<1e-12);
    const longitude=-Math.atan2(z,x)*180/Math.PI,latitude=Math.asin(y/radius)*180/Math.PI;
    assert(longitude>5&&longitude<10);assert(latitude>-35&&latitude<-25);
  }
});

test('terrain camera selects the greatest nominal skyline, not an uncertainty bound', async () => {
  const { terrainFocusBearing } = await sceneModule();
  assert.equal(typeof terrainFocusBearing,'function','terrain focus bearing selector is missing');
  const site={terrain:{skyline:[[15,2,40,3,-90],[120,10,11,10,-90],[300,4,99,4,-90]]}};
  assert.equal(terrainFocusBearing(site),120);
  assert.equal(terrainFocusBearing({terrain:{skyline:[[20,0,40,null,-90],[190,0,2,1,-90]]}}),190);
  assert.equal(terrainFocusBearing({terrain:{skyline:[]}}),0);
});

test('terrain binary views reject truncated or mismatched mesh data', async () => {
  const { terrainBufferViews } = await sceneModule();
  const metadata={vertexCount:3,indexCount:3,positionsByteOffset:0,indicesByteOffset:36,byteLength:48};
  const binary=new ArrayBuffer(48);
  new Float32Array(binary,0,9).set([0,0,0,1,0,0,0,0,-1]);
  new Uint32Array(binary,36,3).set([0,1,2]);
  const result=terrainBufferViews(binary,metadata);
  assert.equal(result.positions.length,9);assert.deepEqual([...result.indices],[0,1,2]);
  assert.throws(()=>terrainBufferViews(new ArrayBuffer(44),metadata),/length/i);
  new Uint32Array(binary,36,3).set([0,1,3]);
  assert.throws(()=>terrainBufferViews(binary,metadata),/index/i);
});

test('projected skyline uses retained nominal angles in ENU and leaves unknown sectors empty', async () => {
  const { farHorizonData } = await sceneModule();
  assert.equal(typeof farHorizonData,'function','projected skyline builder is missing');
  const site={heightM:2,terrain:{fine:{azimuthBinDeg:90},skyline:[
    [0,-1,1,0,-90,[0,0,142000,0]],
    [90,44,46,45,-90,[0,0,86000,0]],
    [180,-1,1,0,2,null],
    [270,null,null,null,-90,null],
  ]}};
  const result=farHorizonData(site);
  assert.equal(result.sectorCount,2);assert.equal(result.skippedSectors,2);
  assert.equal(result.positions.length,24);assert.equal(result.indices.length,12);
  assert.deepEqual([...result.positions.slice(0,3)],[0,2,-200000]);
  assert(Math.abs(result.positions[13]-200002)<.1);
  assert.equal(result.maxSourceBlockerDistanceM,142000);
  assert.equal(farHorizonData({heightM:2,terrain:{skyline:site.terrain.skyline}}).sectorCount,0);
});

test('body framing reports centered, offscreen and behind-camera directions without changing visibility', async () => {
  const { bodyFraming } = await sceneModule();
  assert.equal(typeof bodyFraming,'function','body framing diagnostic is missing');
  const centered=bodyFraming([0,0,-1],60,1);
  assert.equal(centered.inFrustum,true);assert.deepEqual(centered.projectedPosition,[.5,.5]);
  const right=bodyFraming([1,0,-1],60,1);
  assert.equal(right.inFrustum,false);assert.equal(right.projectedBearingDeg,90);assert.equal(right.behindCamera,false);
  assert.equal(bodyFraming([0,0,1],60,1).behindCamera,true);
  assert.equal(bodyFraming([0,0,1],60,1).inFrustum,false);
  assert.equal(bodyFraming(null,60,1).projectedPosition,null);
  const sample=[100,350,3,2,72,2.9,1.8];
  assert.deepEqual((await sceneModule()).renderedBodies(sample,{sun:'blocked',earth:'uncertain'}),{sun:false,earth:false});
});
