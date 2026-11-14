import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyDirection, moonPoint, sceneFrame, missionStory } from '../web/scene-model.mjs';

const close=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<1e-12);
test('surface directions follow east/up/minus-north and preserve angular elevation',()=>{
  assert(close(bodyDirection(0,0),[0,0,-1]));
  assert(close(bodyDirection(90,0),[1,0,0]));
  assert(close(bodyDirection(180,0),[0,0,1]));
  assert(close(bodyDirection(0,90),[0,1,0]));
  assert(close(bodyDirection(450,-30),[Math.sqrt(3)/2,-.5,0]));
  assert.equal(bodyDirection(null,3),null);
});
test('globe points use Moon-fixed axis mapping with correct polar and east-longitude orientation',()=>{
  assert(close(moonPoint(0,0,2),[2,0,0]));assert(close(moonPoint(0,90,2),[0,0,-2]));
  assert(close(moonPoint(-90,180,2),[0,-2,0]));
  assert(close(moonPoint(0,-90),moonPoint(0,270)));
  assert.equal(moonPoint(-91,0),null);
});
const timeline=(state)=>[[0,100,state]];
function site(){return {id:'a',sun:timeline('visible'),earth:timeline('visible'),refinementIntervals:{
  sun:{coarse:timeline('visible'),fine:timeline('visible')},earth:{coarse:timeline('visible'),fine:timeline('visible')},
}};}
const sample=[20,10,3,2,40,2,1];
test('body rendering is allowed only when all retained and refinement states agree visible',()=>{
  const s=site();assert.deepEqual(sceneFrame(s,sample,[0,100]).states,{sun:'visible',earth:'visible'});
  s.sun=timeline('blocked');s.refinementIntervals.sun.coarse=timeline('blocked');s.refinementIntervals.sun.fine=timeline('blocked');
  assert.equal(sceneFrame(s,sample,[0,100]).states.sun,'blocked');
  s.refinementIntervals.earth.fine=timeline('blocked');assert.equal(sceneFrame(s,sample,[0,100]).states.earth,'uncertain');
  s.refinementIntervals.earth.fine=[];assert.equal(sceneFrame(s,sample,[0,100]).states.earth,'unknown');
});
test('cache edge, missing direction and visibility gaps can never keep a body on screen',()=>{
  const s=site();assert.deepEqual(sceneFrame(s,[100,...sample.slice(1)],[0,100]).states,{sun:'unknown',earth:'unknown'});
  assert.equal(sceneFrame(s,[20,10,null,2,40,2,1],[0,100]).states.sun,'unknown');
  s.sun=[[0,10,'visible'],[30,100,'visible']];assert.equal(sceneFrame(s,sample,[0,100]).states.sun,'unknown');
});
test('guided story describes the actual failed constraint and preserves a missing recovery',()=>{
  const c={id:'max_sun_block',status:'FAIL',metric:12,threshold:7,margin:-5,witness:[10,20]};
  const result={nominal:{status:'PASS',start:0,end:10,constraints:[]},delayed:{status:'FAIL',start:10,end:20,constraints:[c]},recommended:null};
  const delayed=missionStory(result,'delayed');assert.equal(delayed.constraint,c);assert.equal(delayed.status,'FAIL');
  assert.deepEqual(delayed.witness,[10,20]);assert.match(delayed.message,/12.*7/);
  const recovery=missionStory(result,'recommended');assert.equal(recovery.status,'UNAVAILABLE');assert.match(recovery.message,/No.*passing/i);
});
test('a prelaunch alternative at another site is never narrated as a same-site recovery',()=>{
  const result={nominal:{siteId:'a'},recommended:{siteId:'b',status:'PASS',start:10,end:20,constraints:[]}};
  assert.match(missionStory(result,'recommended').message,/prelaunch/i);
  assert.doesNotMatch(missionStory(result,'recommended').message,/same-site/);
});
