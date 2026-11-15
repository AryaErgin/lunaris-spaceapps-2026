import test from 'node:test';
import assert from 'node:assert/strict';
import {surfaceUVs,surfacePhotoLevel,surfaceVisualRecord} from '../web/surface-visuals.mjs';

const pole={id:'pole',lat:-90,lon:0,groundM:0,heightM:2};
const bounds=[-1000,-1000,1000,1000];
test('registered UVs preserve east, north and physical metres without wrapping',()=>{
  const uv=surfaceUVs(pole,new Float32Array([0,0,0,100,0,0,0,0,-100,3000,0,0]),bounds);
  assert(Math.abs(uv[0]-.5)<1e-6&&Math.abs(uv[1]-.5)<1e-6);
  assert(Math.abs(uv[2]-.55)<1e-5&&Math.abs(uv[3]-.5)<1e-6,'east must move right');
  assert(Math.abs(uv[4]-.5)<1e-6&&Math.abs(uv[5]-.55)<1e-5,'north must move toward image row zero');
  assert(uv[6]>1,'outside imagery stays outside; it must never repeat or clamp into another location');
});
test('Nobile exact observer projects into its independent native stereo grid',()=>{
  const site={id:'nobile-rim-2',lat:-83.954,lon:58.82206,groundM:1009.5821533203125,heightM:2};
  const b=[155999.99991753,94000.99994675,157999.99991753,96000.99994675];
  const uv=surfaceUVs(site,new Float32Array([0,0,0]),b);
  // Independently measured by GDAL/pyproj against the actual NASA GeoTIFF.
  assert(Math.abs(uv[0]-(157000.45196514757-b[0])/2000)<1e-6);
  assert(Math.abs(uv[1]-(95000.25340115099-b[1])/2000)<1e-6);
  const registered=surfaceUVs(site,new Float32Array([0,0,0]),b.map((x,i)=>x+(i%2?-7:-2)));
  assert(Math.abs(registered[0]-uv[0]-.001)<1e-6);
  assert(Math.abs(registered[1]-uv[1]-.0035)<1e-6,'derived photo registration moves imagery, never observer coordinates');
});
test('invalid registration inputs never create a usable texture mapping',()=>{
  assert.throws(()=>surfaceUVs(pole,new Float32Array([NaN,0,0]),bounds),/finite/i);
  assert.throws(()=>surfaceUVs(pole,new Float32Array([0,0,0]),[1,0,0,1]),/bounds/i);
  assert.throws(()=>surfaceUVs({...pole,lat:NaN},new Float32Array([0,0,0]),bounds),/observer/i);
});
test('historical imagery is never relit twice or presented as direct sunlight in unknown/blocked states',()=>{
  assert(surfacePhotoLevel('visible',true,false)>0);
  for(const state of ['blocked','uncertain','unknown',undefined]){
    assert.equal(surfacePhotoLevel(state,true,false),0);
    assert(surfacePhotoLevel(state,true,true)>0,'explicit artificial Night Assist may reveal the historical image');
  }
  assert.equal(surfacePhotoLevel('visible',false,false),0);
  assert(surfacePhotoLevel('visible',true,true)>=surfacePhotoLevel('unknown',true,true));
});
test('display assets require their exact scientific bundle, frame and observer identity',()=>{
  const site={id:'nobile',lat:-84,lon:59,groundM:1000,heightM:2};
  const record={site,imagery:{bounds},terrain:{}};
  const manifest={schemaVersion:1,analysisBundleSha256:'a'.repeat(64),frame:'MOON_ME_DE440_ME421',sites:[record]};
  const binding={bundleFileSha256:'a'.repeat(64),frame:manifest.frame};
  assert.equal(surfaceVisualRecord(manifest,site,binding),record);
  assert.equal(surfaceVisualRecord(manifest,{...site,id:'other'},binding),null);
  assert.throws(()=>surfaceVisualRecord(manifest,site,{...binding,bundleFileSha256:'b'.repeat(64)}),/bundle/i);
  assert.throws(()=>surfaceVisualRecord(manifest,{...site,lon:60},binding),/observer/i);
  assert.throws(()=>surfaceVisualRecord(manifest,site,{...binding,frame:'IAU_MOON'}),/frame/i);
});
