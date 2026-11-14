import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {referenceDirections,skyAt,elevationSeries,nextLevelCrossing,levelSummary,validCoordinate,NOTABLE_SITES,EARTH_DIRECTION_TOLERANCE_DEG} from '../web/anysite.mjs';

const bundle=JSON.parse(await readFile(new URL('../web/data/bundle.json',import.meta.url),'utf8'));
const RAD=Math.PI/180;
const separation=(a,b)=>{
  const v=({azimuth,elevation})=>[Math.cos(elevation*RAD)*Math.sin(azimuth*RAD),Math.cos(elevation*RAD)*Math.cos(azimuth*RAD),Math.sin(elevation*RAD)];
  const [p,q]=[v(a),v(b)];return Math.acos(Math.min(1,p[0]*q[0]+p[1]*q[1]+p[2]*q[2]))/RAD;
};
const unix=text=>Date.parse(text)/1000;

test('reconstructed directions reproduce the other study points cached geometry',()=>{
  const {rows,referenceSite}=referenceDirections(bundle);
  let worst=0,count=0;
  for(const site of bundle.sites.filter(s=>s.id!==referenceSite)){
    site.geometry.forEach((sample,index)=>{
      const sky=skyAt(rows[index],site.lat,site.lon);
      assert.equal(sky.time,sample[0]);
      worst=Math.max(worst,separation(sky.sun,{azimuth:sample[1],elevation:sample[2]}),separation(sky.earth,{azimuth:sample[4],elevation:sample[5]}));count++;
    });
  }
  assert(count>2000);
  assert(worst<0.01,`worst cross-site separation ${worst} degrees`);
});

// JPL Horizons API, retrieved 2026-11-14: CENTER coord@301, COORD_TYPE GEODETIC, zero altitude,
// QUANTITIES 4 (apparent azimuth and elevation), APPARENT AIRLESS. Targets 10 (Sun) and 399 (Earth).
const horizons=[
  {name:'Apollo 11',lat:0.67416,lon:23.47314,rows:[
    ['2026-11-03T00:00Z',268.677383,-32.697771,267.468458,71.710476],
    ['2026-11-09T00:00Z',93.251443,-74.115372,287.050245,69.871633],
    ['2026-11-15T00:00Z',91.54587,-0.97674,276.127538,63.683491],
    ['2026-11-21T00:00Z',97.037495,71.888295,259.83216,58.899446],
    ['2026-11-27T00:00Z',267.689349,35.134785,255.632625,67.910265]]},
  {name:'Chang’e 4',lat:-45.4446,lon:177.5991,rows:[
    ['2026-11-03T00:00Z',86.168866,5.832021,190.696927,-44.091695],
    ['2026-11-09T00:00Z',14.280081,45.217809,190.389687,-50.696575],
    ['2026-11-15T00:00Z',288.730628,19.62859,179.673898,-48.026844],
    ['2026-11-21T00:00Z',232.44005,-29.117945,173.951062,-39.954149],
    ['2026-11-27T00:00Z',142.978738,-36.515738,185.877021,-39.901687]]},
];

test('level-horizon directions at distant sites agree with JPL Horizons',()=>{
  const {rows}=referenceDirections(bundle);
  let worstSun=0,worstEarth=0;
  for(const site of horizons)for(const [time,sunAz,sunEl,earthAz,earthEl] of site.rows){
    const row=rows.find(r=>r.time===unix(time));assert(row,`cached sample for ${time}`);
    const sky=skyAt(row,site.lat,site.lon);
    worstSun=Math.max(worstSun,separation(sky.sun,{azimuth:sunAz,elevation:sunEl}));
    worstEarth=Math.max(worstEarth,separation(sky.earth,{azimuth:earthAz,elevation:earthEl}));
  }
  assert(worstSun<0.01,`Sun separation ${worstSun} degrees`);
  assert(worstEarth<EARTH_DIRECTION_TOLERANCE_DEG,`Earth separation ${worstEarth} degrees exceeds the stated tolerance`);
});

test('level-horizon crossings and summaries describe known lunar behaviour',()=>{
  const apollo=elevationSeries(bundle,0.67416,23.47314);
  // Horizons: Sun centre at -0.98 degrees on 15 Nov 00:00 and rising toward +72 degrees by 21 Nov.
  const rise=nextLevelCrossing(apollo,'sun',unix('2026-11-14T00:00Z'));
  assert.equal(rise.kind,'rises');
  assert(rise.time>unix('2026-11-15T00:00Z')&&rise.time<unix('2026-11-15T06:00Z'));
  assert.equal(nextLevelCrossing(apollo,'earth',bundle.coverage[0]),null,'Earth never crosses the level horizon at Apollo 11.');
  assert.equal(levelSummary(apollo,'earth').aboveFraction,1);
  const farSide=elevationSeries(bundle,-45.4446,177.5991);
  assert.equal(levelSummary(farSide,'earth').aboveFraction,0,'Earth stays below the level horizon on the far side.');
  const pole=levelSummary(elevationSeries(bundle,-89.4632,222.51),'sun');
  assert(pole.max<3&&pole.min>-3,'The polar Sun stays within a few degrees of the level horizon.');
});

test('curated sites carry valid coordinates and a source',()=>{
  assert(NOTABLE_SITES.length>=9);
  assert(new Set(NOTABLE_SITES.map(s=>s.group)).size>=3);
  for(const site of NOTABLE_SITES){assert(validCoordinate(site.lat,site.lon),site.id);assert.match(site.source,/^https:\/\//);}
  assert.equal(validCoordinate(91,0),false);assert.equal(validCoordinate(0,Number.NaN),false);
});
