import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {orbitalOverviewPosition,orbitalMarkerRecords,terrainMarkerLayout,moonFixedPosition} from '../web/scene3d.mjs';

const bundle=JSON.parse(await readFile(new URL('../web/data/bundle.json',import.meta.url),'utf8'));
const terrain=orbitalMarkerRecords(bundle.sites).filter(marker=>marker.terrainAware);

test('the default orbital camera can actually see all four terrain-aware south-pole points',()=>{
  assert.equal(terrain.length,4);
  for(const viewport of [[1366,572],[1920,800],[390,320],[320,320]]){
    const camera=orbitalOverviewPosition(...viewport);
    for(const marker of terrain){
      // A surface point is on the visible side when its outward radial normal
      // points toward the camera. This failed for all four former overview pins.
      const p=marker.position,toCamera=p.map((v,i)=>camera[i]-v);
      assert(p.reduce((sum,v,i)=>sum+v*toCamera[i],0)>0,
        `${marker.point.id} must be in front of the lunar limb at ${viewport}`);
      assert.deepEqual(p,moonFixedPosition(marker.point.lat,marker.point.lon,1.008),
        'Making a marker selectable must never change its geographical position.');
    }
  }
});

test('overlapping polar targets combine without moving their actual projections',()=>{
  const views=terrain.map((marker,i)=>({id:marker.point.id,visible:true,projectedPosition:[.65+i*.002,.93]}));
  const before=structuredClone(views),layout=terrainMarkerLayout(views,1366,572);
  assert.equal(layout.grouped,true);
  assert.deepEqual(layout.ids,bundle.sites.map(site=>site.id));
  assert(Math.abs(layout.anchor[0]-.653)<1e-12);
  assert.equal(layout.anchor[1],.93);
  assert.deepEqual(views,before,'Label layout must not offset geographical pin projections.');
});

test('separated targets stay individual and occluded points never acquire visible controls',()=>{
  const views=[
    {id:'a',visible:true,projectedPosition:[.1,.5]},
    {id:'b',visible:true,projectedPosition:[.9,.5]},
    {id:'behind-the-Moon',visible:false,projectedPosition:[.11,.5]},
    {id:'missing-projection',visible:true,projectedPosition:[NaN,.5]},
  ];
  const layout=terrainMarkerLayout(views,320,320);
  assert.equal(layout.grouped,false);
  assert.deepEqual(layout.ids,['a','b']);
  assert.deepEqual(layout.anchor,[.5,.5]);
  assert.deepEqual(terrainMarkerLayout([],320,320),{grouped:false,ids:[],anchor:null});
});
