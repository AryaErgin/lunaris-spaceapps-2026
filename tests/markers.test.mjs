import test from 'node:test';
import assert from 'node:assert/strict';
import * as scene from '../web/scene3d.mjs';
import {NOTABLE_SITES} from '../web/anysite.mjs';

const study=[{id:'connecting-ridge',lat:-89.4632,lon:222.51},{id:'shackleton-rim',lat:-89.7668,lon:188.13},{id:'de-gerlache-rim',lat:-88.6834,lon:292.0679}];

test('orbital location catalog separates contextual history from terrain-aware study markers',()=>{
  assert.equal(typeof scene.orbitalMarkerRecords,'function');
  const markers=scene.orbitalMarkerRecords(study);
  assert.equal(markers.length,study.length+NOTABLE_SITES.length);
  assert.equal(new Set(markers.map(marker=>marker.point.id)).size,markers.length);
  const terrain=markers.filter(marker=>marker.kind==='terrain'),context=markers.filter(marker=>marker.kind==='context');
  assert.deepEqual(terrain.map(marker=>marker.point.id),study.map(point=>point.id));
  assert.deepEqual(context.map(marker=>marker.point.id),NOTABLE_SITES.map(point=>point.id));
  assert(context.some(marker=>marker.point.group==='NASA CLPS'));
  assert(context.some(marker=>marker.point.group==='Other national programs'));
  for(const marker of context){
    assert.equal(marker.symbol,'\u25c7');
    assert.notEqual(marker.color,terrain[0].color);
    assert.equal(marker.terrainAware,false);
    assert.deepEqual(marker.position,scene.moonFixedPosition(marker.point.lat,marker.point.lon,1.008));
    assert(marker.point.source);
  }
  assert(terrain.every(marker=>marker.terrainAware===true));
});
