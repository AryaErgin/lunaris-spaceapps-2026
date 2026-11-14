import test from 'node:test';
import assert from 'node:assert/strict';
import * as frame from '../web/scene-model.mjs';
const close=(actual,expected)=>actual.forEach((v,i)=>assert(Math.abs(v-expected[i])<1e-12,`${actual} != ${expected}`));
test('Moon-fixed display rays preserve known east, up and north vectors',()=>{
  assert.equal(typeof frame.localToMoonDirection,'function','Verified orbital frame transform is missing');
  const f=frame.localToMoonDirection;
  close(f({lat:0,lon:0},[1,0,0]),[0,0,-1]);
  close(f({lat:0,lon:0},[0,1,0]),[1,0,0]);
  close(f({lat:0,lon:0},[0,0,-1]),[0,1,0]);
  close(f({lat:0,lon:90},[1,0,0]),[-1,0,0]);
  close(f({lat:-90,lon:0},[0,1,0]),[0,-1,0]);
  close(f({lat:-90,lon:0},[0,0,-1]),[1,0,0]);
  close(f({lat:30,lon:60},[0,1,0]),[Math.sqrt(3)/4,.5,-.75]);
});
test('orbital rays preserve angles and roundtrip against an independently constructed spherical basis',()=>{
  assert.equal(typeof frame.localToMoonDirection,'function');
  for(const lat of [-89.78,-88.6834,-30,0,65,90])for(const lon of [0,90,129.787,222.51,292.0679]){
    const p=lat*Math.PI/180,l=lon*Math.PI/180;
    // Conventional Moon XYZ east/north/radial-up, then renderer [X,Z,-Y].
    const rotate=([x,y,z])=>[x,z,-y];
    const east=rotate([-Math.sin(l),Math.cos(l),0]);
    const up=rotate([Math.cos(p)*Math.cos(l),Math.cos(p)*Math.sin(l),Math.sin(p)]);
    const minusNorth=rotate([Math.sin(p)*Math.cos(l),Math.sin(p)*Math.sin(l),-Math.cos(p)]);
    const local=frame.bodyDirection(123.4,-5.6),world=frame.localToMoonDirection({lat,lon},local);
    const dot=a=>a.reduce((sum,v,i)=>sum+v*world[i],0);
    close([dot(east),dot(up),dot(minusNorth)],local);assert(Math.abs(Math.hypot(...world)-1)<1e-12);
  }
});
test('invalid orbital directions cannot become plausible planetary positions',()=>{
  assert.equal(typeof frame.localToMoonDirection,'function');
  for(const [site,v]of [[null,[0,1,0]],[{lat:91,lon:0},[0,1,0]],[{lat:0,lon:0},[0,0,0]],[{lat:0,lon:0},[NaN,1,0]]])assert.equal(frame.localToMoonDirection(site,v),null);
});
