// Real artifact integration gate. November-only checkouts explicitly SKIP these
// checks; LUNARIS_REQUIRE_EXTENDED=1 turns missing annual evidence into a failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {evaluateStart,runMission,makeCertificate} from '../web/engine.mjs';
import {communicationDemo} from '../web/overview.mjs';
import {missionMetrics,feasibilityMatrix} from '../web/operations.mjs';
import {automaticSearchOptions} from '../web/search-scope.mjs';
import {referenceDirections,skyAt,EARTH_DIRECTION_TOLERANCE_DEG} from '../web/anysite.mjs';

const HOUR=3600,DAY=24*HOUR,utc=text=>Date.parse(text)/1000;
const START=utc('2026-11-01T00:00:00Z'),NOV_END=utc('2026-12-01T00:00:00Z'),END=utc('2028-01-01T00:00:00Z');
const raw=readFileSync(new URL('../web/data/bundle.json',import.meta.url),'utf8'),bundle=JSON.parse(raw);
const required=process.env.LUNARIS_REQUIRE_EXTENDED==='1',expanded=bundle.coverage[1]>NOV_END;
const missing='Actual 426-day bundle not installed; annual scientific assertions were NOT executed.';
const onlyExtended={skip:expanded?false:missing};
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']'
  :value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}'
  :JSON.stringify(value);
const baselinePayload='18c23c3de7cc3a61cb9fb4901c868c283cb13b789a868f074156fbabe85469a4';
const baselineProjections={
  'connecting-ridge':'9f60be062f1ec418d4bb3d8880c5e13a641c1614a669ee6803a479d60970fea8',
  'shackleton-rim':'4ba7e4ca311408377cc63cd7d16ca2c8f529ab5d1479e03c8545f59df5820770',
  'de-gerlache-rim':'eb9469aa896bc652d2f2c0f77e97267bd0f20a15730912e0ad9e1f3bd04f851c',
};
const states=new Set(['visible','blocked','uncertain','unknown']);
const close=(actual,expected,label)=>assert(Math.abs(actual-expected)<=1e-6,`${label}: ${actual} versus ${expected} seconds`);
const closeRange=(actual,expected,label)=>{assert.equal(actual.length,2);for(let i=0;i<2;i++)close(actual[i],expected[i],label+' '+i);};
const clip=(timeline,from,to)=>timeline.flatMap(([a,b,state])=>Math.max(a,from)<Math.min(b,to)?[[Math.max(a,from),Math.min(b,to),state]]:[]);

function verifyCanonicalArtifact(text,artifact){
  // Preserve Python's exact serialized numeric spelling (.0, exponents, etc.).
  // Re-serializing parsed numbers in JS would not reproduce the generator bytes.
  let unsigned=text.trimEnd();
  for(const key of ['bundleHashConvention','bundleSha256']){
    const fragment=JSON.stringify(key)+':'+JSON.stringify(artifact.manifest[key])+',';
    assert.equal(unsigned.split(fragment).length-1,1,`${key} must occur exactly once in canonical manifest`);
    unsigned=unsigned.replace(fragment,'');
  }
  assert.match(artifact.manifest.bundleSha256,/^[a-f0-9]{64}$/);
  assert.equal(sha(unsigned),artifact.manifest.bundleSha256,'Artifact contents must match the exact declared payload fingerprint.');
}

function assertTimeline(timeline,coverage,label){
  assert(Array.isArray(timeline)&&timeline.length,label);
  let cursor=coverage[0];
  for(const [a,b,state]of timeline){
    assert(Number.isFinite(a)&&Number.isFinite(b)&&a<b,label+' positive finite interval');
    assert.equal(a,cursor,label+' must explicitly partition the whole cache without gaps/overlap');
    assert(states.has(state),label+' valid state');cursor=b;
  }
  assert.equal(cursor,coverage[1],label+' exclusive end');
}

// Independent event partition: lookup at midpoint of every source boundary span.
// This deliberately does not call the production clip/intersection/summary code.
function oracle(sun,earth,start,end){
  const boundaries=[...new Set([start,end,...[sun,earth].flatMap(t=>t.flatMap(([a,b])=>[a,b]).filter(t=>t>start&&t<end))])].sort((a,b)=>a-b);
  const output={sun:[],earth:[],joint:[]};
  const stateAt=(source,time)=>source.find(([a,b])=>a<=time&&time<b)?.[2]??'unknown';
  for(let i=1;i<boundaries.length;i++){
    const a=boundaries[i-1],b=boundaries[i],s=stateAt(sun,(a+b)/2),e=stateAt(earth,(a+b)/2);
    const j=[s,e].includes('blocked')?'blocked':[s,e].includes('unknown')?'unknown':[s,e].includes('uncertain')?'uncertain':'visible';
    for(const [key,state]of [['sun',s],['earth',e],['joint',j]])output[key].push([a,b,state]);
  }
  const measure=timeline=>{
    const totals={visible:0,blocked:0,uncertain:0,unknown:0};
    for(const[a,b,state]of timeline)totals[state]+=b-a;
    const longest=predicate=>{
      let first=null,last=null,max=0;
      for(const[a,b,state]of timeline){
        if(!predicate(state)){first=null;last=null;continue;}
        if(first===null||last!==a)first=a;
        last=b;max=Math.max(max,last-first);
      }
      return max;
    };
    return {...totals,visibleRangeSeconds:[totals.visible,totals.visible+totals.uncertain+totals.unknown],
      blockedRangeSeconds:[totals.blocked,totals.blocked+totals.uncertain+totals.unknown],
      longestBlockedRangeSeconds:[longest(s=>s==='blocked'),longest(s=>s!=='visible')],
      longestVisibleRangeSeconds:[longest(s=>s==='visible'),longest(s=>s!=='blocked')]};
  };
  return Object.fromEntries(Object.entries(output).map(([key,timeline])=>[key,measure(timeline)]));
}

function assertMissionEvidence(site,inputs,start){
  const mission=evaluateStart(bundle,inputs,site.id,start),end=start+inputs.durationHours*HOUR;
  assert.equal(mission.start,start);assert.equal(mission.end,end);assert.equal(mission.siteId,site.id);
  const levels=[oracle(site.sun,site.earth,start,end),...['coarse','fine'].map(level=>oracle(site.refinementIntervals.sun[level],site.refinementIntervals.earth[level],start,end))];
  const metrics=missionMetrics(mission,site);
  for(const channel of ['sun','earth','joint']){
    close(Object.values(levels[0][channel]).filter(Number.isFinite).reduce((a,b)=>a+b,0),end-start,channel+' state partition duration');
    for(const state of states)close(metrics[channel][state+'Seconds'],levels[0][channel][state],channel+' retained '+state);
    for(const field of ['visibleRangeSeconds','blockedRangeSeconds','longestBlockedRangeSeconds','longestVisibleRangeSeconds']){
      closeRange(metrics[channel][field],[Math.min(...levels.map(row=>row[channel][field][0])),Math.max(...levels.map(row=>row[channel][field][1]))],channel+' '+field);
    }
  }
  const fields={max_sun_block:['sun','longestBlockedRangeSeconds','max'],max_earth_block:['earth','longestBlockedRangeSeconds','max'],
    min_joint_total:['joint','visibleRangeSeconds','min'],min_joint_continuous:['joint','longestVisibleRangeSeconds','min']};
  for(const rule of mission.constraints){
    const [channel,field,direction]=fields[rule.id],retained=levels[0][channel][field];
    closeRange(rule.range.map(value=>value*HOUR),retained,rule.id+' retained range');
    const threshold=rule.threshold*HOUR;
    if(rule.status==='PASS')for(const row of levels)assert(direction==='max'?row[channel][field][1]<=threshold+1e-6:row[channel][field][0]>=threshold-1e-6,rule.id+' PASS needs all refinement bounds');
    if(rule.status==='FAIL')for(const row of levels)assert(direction==='max'?row[channel][field][0]>threshold+1e-6:row[channel][field][1]<threshold-1e-6,rule.id+' FAIL needs all refinement bounds');
    if(rule.witness)assert(rule.witness[0]>=start&&rule.witness[1]<=end,rule.id+' witness lies inside the full requested mission');
  }
  if(mission.status==='PASS'){
    assert(mission.constraints.every(c=>c.status==='PASS'));assert.equal(mission.refinement.status,'CONVERGED');
    assert(start>=bundle.coverage[0]&&end<=bundle.coverage[1]&&start>=inputs.earliest&&start<=inputs.latest);
  }
  return mission;
}

test('extended real-data gate requires exactly 426 contiguous days when requested',
  {skip:!expanded&&!required?missing:false},()=>{
    assert(expanded,'LUNARIS_REQUIRE_EXTENDED=1 requires generated annual data, not the preserved November release.');
    assert.deepEqual(bundle.coverage,[START,END]);assert.equal((END-START)/DAY,426);
    assert.deepEqual(bundle.demonstrationCoverage,[START,NOV_END]);assert(bundle.sites.length>=3);
  });

test('annual payload, finite configurations and original November evidence retain exact fingerprints',onlyExtended,()=>{
  verifyCanonicalArtifact(raw,bundle);
  const validation=bundle.manifest.validation.extendedCoverage;
  assert.deepEqual(validation.coverage,[START,END]);assert.equal(validation.partitions.length,14);
  assert.equal(validation.novemberParity.status,'PASS');assert.equal(validation.novemberParity.referenceBundleSha256,baselinePayload);
  let cursor=START;for(const [a,b]of validation.partitions){assert.equal(a,cursor);assert(a<b);cursor=b;}assert.equal(cursor,END);
  for(const[id,digest]of Object.entries(baselineProjections)){
    const site=bundle.sites.find(s=>s.id===id);assert(site);
    const projection={id:site.id,lat:site.lat,lon:site.lon,groundM:site.groundM,heightM:site.heightM,skyline:site.terrain.skyline,
      sun:clip(site.sun,START,NOV_END),earth:clip(site.earth,START,NOV_END),
      refinementIntervals:Object.fromEntries(['sun','earth'].map(channel=>[channel,Object.fromEntries(['coarse','fine'].map(level=>[level,clip(site.refinementIntervals[channel][level],START,NOV_END)]))])),
      geometry:site.geometry.filter(row=>row[0]>=START&&row[0]<=NOV_END)};
    assert.equal(sha(canonical(projection)),digest,id+' exact independent stable-release projection');
  }
  for(const name of ['height','position','terrain']){
    const text=readFileSync(new URL(`../web/data/${name}-study.json`,import.meta.url),'utf8'),study=JSON.parse(text);
    verifyCanonicalArtifact(text,study);assert.deepEqual(study.coverage,[START,END]);
    assert.equal(study.manifest.baselineBundleSha256,bundle.manifest.bundleSha256);
    for(const scenario of study.scenarios.filter(s=>!s.baseline)){
      for(const channel of ['sun','earth']){
        assertTimeline(scenario[channel],bundle.coverage,name+'/'+scenario.id+'/'+channel);
        for(const level of ['coarse','fine'])assertTimeline(scenario.refinementIntervals[channel][level],bundle.coverage,name+'/'+scenario.id+'/'+channel+'/'+level);
      }
    }
  }
});

test('annual positions and interval partitions are complete at every actual study observer',onlyExtended,()=>{
  for(const site of bundle.sites){
    assert.equal(site.geometry.length,426*48+1,site.id+' actual half-hour samples, including end boundary');
    for(const[index,row]of site.geometry.entries()){
      assert.equal(row[0],START+index*1800);assert.equal(row.length,7);
      for(const column of [1,2,4,5])assert(Number.isFinite(row[column]),site.id+' finite body direction');
      for(const column of [1,4])assert(row[column]>=0&&row[column]<360);
      for(const column of [2,5])assert(Math.abs(row[column])<=90);
    }
    assert.equal(site.monthlyRefinement.length,14);
    assert.deepEqual(site.monthlyRefinement.map(row=>row.coverage),bundle.manifest.validation.extendedCoverage.partitions);
    for(const channel of ['sun','earth']){
      assertTimeline(site[channel],bundle.coverage,site.id+'/'+channel);
      for(const level of ['coarse','fine'])assertTimeline(site.refinementIntervals[channel][level],bundle.coverage,site.id+'/'+channel+'/'+level);
    }
  }
});

test('new epoch directions are bound to matched Horizons and explicitly qualified motion checks',onlyExtended,()=>{
  const {horizons,motionDomain,motionEnvelope}=bundle.manifest.validation;
  assert.equal(horizons.status,'PASS');assert.equal(horizons.angular_tolerance_deg,.01);
  assert.equal(horizons.comparison_count,300);assert(horizons.max_angular_separation_deg<.01);
  assert.equal(motionDomain.status,'PASS');assert.equal(motionDomain.sampled_only,true);
  assert.equal(motionDomain.between_sample_bound_proven,false,'A dense sampled audit is not a continuous enclosure.');
  assert.equal(motionDomain.frame,'MOON_ME_DE440_ME421');assert.equal(motionDomain.correction,'CN+S');
  assert.equal(motionEnvelope.status,'PASS');assert.equal(motionEnvelope.polynomial_interval_enclosure,true);
  assert.equal(motionEnvelope.formal_verification,false);assert.equal(motionEnvelope.physical_model_error_bounded,false);
  assert(utc(motionEnvelope.start_utc)<=START&&utc(motionEnvelope.end_utc)>=END);
  assert(Object.values(motionEnvelope.checks).every(value=>value===true));
  for(const site of bundle.sites){
    const observer=motionDomain.sites.find(row=>row.site_id===site.id);assert(observer);
    const radius=(site.referenceRadiusM??1737400)+site.groundM+site.heightM;
    close(observer.observer_radius_m,radius,site.id+' validation observer radius');
    assert.equal(observer.latitude_deg,site.lat);assert.equal(observer.longitude_deg_east,site.lon);
    assert(radius/1000<=motionEnvelope.observer_radius_upper_km);
    for(const target of ['sun','earth']){
      const reference=horizons.references.find(row=>row.site_id===site.id&&row.target===target);assert(reference);
      assert.equal(reference.samples.length,15);assert.match(reference.source_sha256,/^[a-f0-9]{64}$/);
      for(const point of reference.samples){
        const time=utc(point.utc),row=site.geometry[(time-START)/1800];assert(row&&row[0]===time);
        const az=target==='sun'?1:4,el=target==='sun'?2:5;
        const azDifference=Math.abs(((row[az]-point.spice_azimuth_deg+540)%360)-180);
        assert(azDifference<=.00000501,'Azimuth differs beyond five-decimal serialization, not physical-model tolerance.');
        assert(Math.abs(row[el]-point.spice_elevation_deg)<=.00000501,'Elevation differs beyond five-decimal serialization.');
        assert(point.separation_deg<.01);
      }
    }
  }
});

test('annual level-horizon reconstruction retains the unchanged .01-degree cross-site tolerance',onlyExtended,()=>{
  const {rows,referenceSite}=referenceDirections(bundle),rad=Math.PI/180;
  const vector=(az,el)=>[Math.cos(el*rad)*Math.sin(az*rad),Math.cos(el*rad)*Math.cos(az*rad),Math.sin(el*rad)];
  let worst=0,count=0;
  for(const site of bundle.sites.filter(s=>s.id!==referenceSite))for(const[index,sample]of site.geometry.entries()){
    const sky=skyAt(rows[index],site.lat,site.lon);
    for(const[target,az,el]of [['sun',1,2],['earth',4,5]]){
      const p=vector(sky[target].azimuth,sky[target].elevation),q=vector(sample[az],sample[el]);
      const difference=Math.acos(Math.max(-1,Math.min(1,p.reduce((sum,v,i)=>sum+v*q[i],0))))/rad;
      worst=Math.max(worst,difference);count++;
    }
  }
  assert.equal(EARTH_DIRECTION_TOLERANCE_DEG,.05,'The disclosed global reconstruction tolerance must not be relaxed.');
  assert(count>=426*48*4);assert(worst<.01,`Annual cross-site maximum ${worst} degrees`);
});

test('cross-year, mid-2027 and cache-edge mission measurements agree with a separate event-partition oracle',onlyExtended,()=>{
  const demo=communicationDemo(bundle);
  for(const site of bundle.sites)for(const[start,durationHours]of [
    [utc('2026-12-31T18:00:00Z'),12],[utc('2027-07-01T06:00:00Z'),12],
    [utc('2027-12-31T06:00:00Z'),12],[utc('2027-01-31T18:00:00Z'),48],
  ]){
    const inputs={...demo,siteId:site.id,nominal:start,durationHours,earliest:START,latest:END-durationHours*HOUR};
    assertMissionEvidence(site,inputs,start);
    const excluded=evaluateStart(bundle,{...inputs,earliest:start+HOUR,latest:start+2*HOUR},site.id,start);
    assert.equal(excluded.startAllowed,false);assert.equal(excluded.status,'FAIL');
    assert(excluded.scheduleWarnings.length,'Schedule exclusion must remain separate from environmental evidence.');
  }
  const site=bundle.sites[0],start=END-6*HOUR,inputs={...demo,siteId:site.id,nominal:start,earliest:START,latest:END};
  const censored=assertMissionEvidence(site,inputs,start);
  assert.equal(censored.status,'INDETERMINATE');assert(censored.coverageWarnings.some(text=>text.includes('outside')));
  assert.equal(censored.end,END+6*HOUR,'Missing coverage never silently shortens the selected duration.');
  const january=feasibilityMatrix(bundle,{...demo,nominal:utc('2027-01-01T18:00:00Z'),durationHours:48,earliest:START,latest:END-48*HOUR},
    {range:[utc('2027-01-01T00:00:00Z'),utc('2027-02-01T00:00:00Z')]});
  assert.equal(january.starts.length,31);assert.equal(january.rows[0].cells.at(-1).end,utc('2027-02-02T18:00:00Z'));
});

test('2027 bounded searches preserve hard schedules and certify the actual inspected decision',onlyExtended,async()=>{
  for(const[index,start]of [utc('2026-12-31T18:00:00Z'),utc('2027-07-01T06:00:00Z'),utc('2027-12-31T06:00:00Z')].entries()){
    const site=bundle.sites[index%bundle.sites.length],inputs={...communicationDemo(bundle),siteId:site.id,nominal:start,earliest:START,latest:END-12*HOUR};
    const before=structuredClone(inputs),scope=automaticSearchOptions(bundle,inputs),result=runMission(bundle,inputs,scope);
    assert.deepEqual(inputs,before);assert.deepEqual(result.nominal,evaluateStart(bundle,inputs));
    assert.equal(result.search.to,Math.min(inputs.latest,Math.max(start+72*HOUR,inputs.earliest)+30*DAY));
    if(result.search.to<inputs.latest){assert.equal(result.search.windowLimited,true);assert.equal(result.search.requestedTo,inputs.latest);}
    assert(result.search.candidateCount<=721);assert.equal(result.search.sites.length,1);
    const record=await makeCertificate(bundle,inputs,result,{role:'nominal',releaseSha:'test-actual-annual-data'});
    assert.equal(record.selected_role,'nominal');assert.deepEqual(record.selected_plan,result.nominal);
    assert.equal(record.site_id,site.id);assert.equal(record.mission_start_utc,new Date(start*1000).toISOString());
    assert.equal(record.data_bundle_hash,bundle.manifest.bundleSha256);assert.deepEqual(record.inputs,inputs);
    assert.deepEqual(record.constraints,result.nominal.constraints);assert.deepEqual(record.search,result.search);
    assert.equal(record.validation.extendedCoverage.novemberParity.referenceBundleSha256,baselinePayload);
    if(result.search.candidateCount>1){
      const shorter=runMission(bundle,inputs,{searchEnd:result.search.to-HOUR});
      const shorterRecord=await makeCertificate(bundle,inputs,shorter,{role:'nominal'});
      assert.notEqual(record.search_input_hash,shorterRecord.search_input_hash);
      assert.equal(record.selected_plan_fingerprint,shorterRecord.selected_plan_fingerprint);
    }
  }
});

test('expanded cache keeps the exact fixed nominal, 72-hour failure and earliest hourly recovery',onlyExtended,()=>{
  const inputs=communicationDemo(bundle),result=runMission(bundle,inputs);
  assert.equal(inputs.latest,utc('2026-11-30T12:00:00Z'));
  assert.deepEqual([result.nominal.status,result.delayed.status,result.recommended.status],['PASS','FAIL','PASS']);
  assert.equal(result.nominal.start,utc('2026-11-01T06:00:00Z'));
  assert.equal(result.recommended.start,utc('2026-11-17T03:00:00Z'));
  assert.equal(result.recommended.start-result.delayed.start,309*HOUR);
  const solar=result.delayed.constraints.find(rule=>rule.id==='max_sun_block');
  assert.deepEqual([solar.metric,solar.threshold,solar.margin,solar.status],[12,7,-5,'FAIL']);
  const earlier={FAIL:0,INDETERMINATE:0,PASS:0};
  for(let start=result.delayed.start;start<result.recommended.start;start+=HOUR)earlier[evaluateStart(bundle,inputs,inputs.siteId,start).status]++;
  assert.deepEqual(earlier,{FAIL:240,INDETERMINATE:69,PASS:0});
});
