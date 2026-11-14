import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {referenceDirections,skyAt,EARTH_DIRECTION_TOLERANCE_DEG} from '../web/anysite.mjs';

const bundle=JSON.parse(await readFile(new URL('../web/data/bundle.json',import.meta.url),'utf8'));
const fixture=JSON.parse(await readFile(new URL('./fixtures/level-horizons-extended.json',import.meta.url),'utf8'));
const annual=bundle.coverage[1]>=Date.parse('2028-01-01T00:00Z')/1000;
const required=process.env.LUNARIS_REQUIRE_EXTENDED==='1';
const direction=(az,el)=>{
  const a=az*Math.PI/180,e=el*Math.PI/180;
  return [Math.cos(e)*Math.sin(a),Math.cos(e)*Math.cos(a),Math.sin(e)];
};
const separation=(actual,az,el)=>{
  const a=direction(actual.azimuth,actual.elevation),b=direction(az,el);
  const cross=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  return Math.atan2(Math.hypot(...cross),a.reduce((sum,x,i)=>sum+x*b[i],0))*180/Math.PI;
};

test('global level-horizon approximation agrees with 90 annual NASA reference angles',{
  skip:!annual&&!required?'Annual experimental data are not installed; no annual validation claimed.':false,
},()=>{
  assert(annual,'LUNARIS_REQUIRE_EXTENDED requires the actual extended bundle');
  const byTime=new Map(referenceDirections(bundle).rows.map(row=>[row.time,row]));
  let count=0,worstSun=0,worstEarth=0;
  for(const reference of fixture.references){
    assert.match(reference.url,/^https:\/\/ssd\.jpl\.nasa\.gov\/api\/horizons\.api\?/);
    assert.match(reference.source_sha256,/^[a-f0-9]{64}$/);
    for(const [utc,az,el] of reference.samples){
      const row=byTime.get(Date.parse(utc)/1000);assert(row,`Actual cached epoch ${utc}`);
      const sky=skyAt(row,reference.latitude_deg,reference.longitude_deg_east);
      const angle=separation(sky[reference.target],az,el);
      if(reference.target==='sun')worstSun=Math.max(worstSun,angle);
      else worstEarth=Math.max(worstEarth,angle);
      count++;
    }
  }
  assert.equal(count,90);
  assert(worstSun<.01,`Sun approximation error ${worstSun} degrees`);
  assert(worstEarth<EARTH_DIRECTION_TOLERANCE_DEG,`Earth approximation error ${worstEarth} degrees`);
  console.log(JSON.stringify({levelHorizonReferenceCount:count,worstSunDeg:worstSun,worstEarthDeg:worstEarth,
    scope:'Sampled approximate directions only; not terrain visibility or physical accuracy.'}));
});
