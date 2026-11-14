import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { makeCertificate, runMission } from '../web/engine.mjs';
import { communicationDemo } from '../web/overview.mjs';

const bundle=JSON.parse(readFileSync(new URL('../web/data/bundle.json',import.meta.url),'utf8'));
const inputs=communicationDemo(bundle);
const result=runMission(bundle,inputs);
const releaseSha='abcdef0123456789abcdef0123456789abcdef01';
const publicUrl='https://example.test/lunaris/';
const utc=seconds=>new Date(seconds*1000).toISOString();

function checkSelected(certificate,plan,role,index=null) {
  assert.equal(certificate.certificate_version,'2.0');
  assert.equal(certificate.selected_role,role);
  assert.equal(certificate.selected_alternative_index,index);
  assert.deepEqual(certificate.selected_plan,plan);
  assert.equal(certificate.site_id,plan.siteId);
  assert.equal(certificate.mission_start_utc,utc(plan.start));
  assert.equal(certificate.mission_end_utc,utc(plan.end));
  assert.equal(certificate.status,plan.status);
  assert.deepEqual(certificate.constraints,plan.constraints);
  assert.deepEqual(certificate.witness_intervals,plan.constraints.map(c=>({
    constraint_id:c.id,interval:c.witness,segments:c.witnessSegments??null,
  })));
}

test('certificate explicitly identifies every inspected decision while retaining the original search',async()=>{
  const certificates=[];
  for(const role of ['nominal','delayed','recommended']) {
    const certificate=await makeCertificate(bundle,inputs,result,{role,releaseSha,publicUrl});
    checkSelected(certificate,result[role],role);
    assert.deepEqual(certificate.nominal_result,result.nominal);
    assert.deepEqual(certificate.delayed_result,result.delayed);
    assert.deepEqual(certificate.recommended_result,result.recommended);
    assert.deepEqual(certificate.nondominated_alternatives,result.alternatives);
    assert.deepEqual(certificate.search,result.search);
    assert.deepEqual(certificate.candidate_counts,result.counts);
    assert.deepEqual(certificate.delay_tolerance,result.delayTolerance);
    assert.equal(certificate.delay_tolerance_scope.selected_role,'nominal');
    assert.equal(certificate.delay_tolerance_scope.site_id,result.nominal.siteId);
    assert.equal(certificate.delay_tolerance_scope.mission_start_utc,utc(result.nominal.start));
    certificates.push(certificate);
  }
  assert.equal(new Set(certificates.map(c=>c.search_input_hash)).size,1);
  assert.equal(new Set(certificates.map(c=>c.input_hash)).size,3);
  assert.notEqual(certificates[0].selected_plan_fingerprint,certificates[1].selected_plan_fingerprint);
  assert.match(certificates[0].input_hash_semantics,/selected.*role/i);
});

test('a computed cross-site alternative exports its actual point and evidence',async()=>{
  const searchInputs={...bundle.demo,mode:'prelaunch'};
  const searchResult=runMission(bundle,searchInputs);
  const index=searchResult.alternatives.findIndex(plan=>plan.siteId!==searchInputs.siteId);
  assert.notEqual(index,-1,'the actual prelaunch cache must contain a cross-site export case');
  const plan=searchResult.alternatives[index];
  const certificate=await makeCertificate(bundle,searchInputs,searchResult,{role:'alternative',alternativeIndex:index});
  checkSelected(certificate,plan,'alternative',index);
  const site=bundle.sites.find(site=>site.id===plan.siteId);
  assert.deepEqual(certificate.point_coordinates,{latitude_deg:site.lat,longitude_east_deg:site.lon});
  assert.equal(certificate.instrument_heights_m.solar,site.heightM);
  assert.equal(certificate.inputs.siteId,searchInputs.siteId);
  assert.equal(certificate.delay_tolerance_scope.site_id,searchResult.nominal.siteId);
});

test('application release identity stays distinct from the frozen data generator',async()=>{
  const certificate=await makeCertificate(bundle,inputs,result,{role:'nominal',releaseSha,publicUrl});
  assert.equal(certificate.application_release_sha,releaseSha);
  assert.equal(certificate.engine_commit,releaseSha);
  assert.equal(certificate.public_url,publicUrl);
  assert.equal(certificate.data_generator_commit,bundle.manifest.engineCommit);
  assert.equal(certificate.bundle_engine_commit,bundle.manifest.engineCommit);
  assert.notEqual(certificate.application_release_sha,certificate.data_generator_commit);
  const unknownRelease=await makeCertificate(bundle,inputs,result,{role:'nominal'});
  assert.equal(unknownRelease.application_release_sha,null);
  assert.equal(unknownRelease.engine_commit,null);
});

test('search hash and selected-plan fingerprint describe different identities',async()=>{
  const a=await makeCertificate(bundle,inputs,result,{role:'recommended'});
  const index=result.alternatives.findIndex(plan=>JSON.stringify(plan)===JSON.stringify(result.recommended));
  assert.notEqual(index,-1);
  const b=await makeCertificate(bundle,inputs,result,{role:'alternative',alternativeIndex:index});
  assert.equal(a.search_input_hash,b.search_input_hash);
  assert.equal(a.selected_plan_fingerprint,b.selected_plan_fingerprint);
  assert.notEqual(a.input_hash,b.input_hash,'the explicit inspected role is part of export input identity');
  const movedSearch={...inputs,gridMinutes:inputs.gridMinutes+1};
  const c=await makeCertificate(bundle,movedSearch,result,{role:'recommended'});
  assert.notEqual(a.search_input_hash,c.search_input_hash);
  assert.equal(a.selected_plan_fingerprint,c.selected_plan_fingerprint);
});

test('rapid selection and caller mutation cannot alter an in-flight or completed certificate',async()=>{
  const mutableBundle=structuredClone(bundle),mutableInputs=structuredClone(inputs),mutableResult=structuredClone(result);
  const original=structuredClone({inputs:mutableInputs,result:mutableResult});
  const options={role:'nominal',releaseSha,publicUrl};
  const first=makeCertificate(mutableBundle,mutableInputs,mutableResult,options);
  options.role='delayed';
  const second=makeCertificate(mutableBundle,mutableInputs,mutableResult,options);
  options.releaseSha='1111111111111111111111111111111111111111';
  mutableInputs.nominal+=3600;
  mutableResult.nominal.siteId='caller-mutated';
  mutableResult.delayed.constraints[0].witness[0]+=3600;
  mutableBundle.manifest.engineCommit='caller-mutated';
  const [a,b]=await Promise.all([first,second]);
  checkSelected(a,original.result.nominal,'nominal');
  checkSelected(b,original.result.delayed,'delayed');
  assert.equal(a.inputs.nominal,original.inputs.nominal);
  assert.equal(b.application_release_sha,releaseSha);
  assert.equal(b.bundle_engine_commit,bundle.manifest.engineCommit);
  const frozen=JSON.stringify(a);
  mutableResult.recommended.constraints[0].metric=123456;
  assert.equal(JSON.stringify(a),frozen);
  assert.deepEqual(a.scenario_ids,[]);
  assert.deepEqual(a.scenario_results,[]);
});

test('missing or invalid explicit selections fail instead of silently exporting another plan',async()=>{
  await assert.rejects(makeCertificate(bundle,inputs,result,{role:'alternative',alternativeIndex:-1}),/alternative/i);
  await assert.rejects(makeCertificate(bundle,inputs,result,{role:'alternative',alternativeIndex:0.5}),/alternative/i);
  await assert.rejects(makeCertificate(bundle,inputs,result,{role:'unrecognized'}),/role/i);
  await assert.rejects(makeCertificate(bundle,inputs,{...result,recommended:null},{role:'recommended'}),/recommended/i);
  const legacy=await makeCertificate(bundle,inputs,result);
  checkSelected(legacy,result.recommended,'recommended');
});

test('lower-bound connected tolerance metadata remains attached to the original nominal plan',async()=>{
  const recorded={...structuredClone(result),delayTolerance:{until:result.nominal.start,hours:0,kind:'lower-bound',stopReason:'fixture exercises serialization only'}};
  const certificate=await makeCertificate(bundle,inputs,recorded,{role:'recommended'});
  assert.deepEqual(certificate.delay_tolerance,recorded.delayTolerance);
  assert.equal(certificate.delay_tolerance_scope.selected_role,'nominal');
  assert.match(certificate.delay_tolerance_scope.meaning,/not.*recover/i);
});
