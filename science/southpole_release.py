"""Finalize validated ten-site scientific artifacts; never merge or deploy."""
from __future__ import annotations

import argparse
import json
import shutil
from copy import deepcopy
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

from science.atlas import build_atlas
from science.build import _canonical
from science.extended import horizons_source_records
from science.rendering_notes import build_notes
from science.southpole_expand import BASELINE_FILE_SHA256, write_release
from science.southpole_products import append_products
from science.southpole_sites import SOUTHPOLE_SITES
from science.validate_extension import verify_payload_fingerprint


def check_validation_binding(bundle, report):
    actual=verify_payload_fingerprint(bundle)
    wanted={row[0] for row in SOUTHPOLE_SITES}
    if (report.get('status')!='PASS' or report.get('structure',{}).get('status')!='PASS'
        or report['structure'].get('expandedPayloadSha256')!=actual
        or len(report.get('siteIds',[]))!=6 or set(report['siteIds'])!=wanted):
        raise ValueError('Validation is incomplete or does not bind this exact draft payload')
    for field,count_key in [('pointAudits','sampledPoints'),('nativeHorizonAudits','sampleCount')]:
        rows=report.get(field,[])
        if (len(rows)!=6 or {r.get('siteId') for r in rows}!=wanted
            or any(r.get('status')!='PASS' or not isinstance(r.get(count_key),(int,float)) or r[count_key]<=0 for r in rows)):
            raise ValueError('A complete positive six-observer audit is required')
    if (report.get('horizons',{}).get('status')!='PASS' or report['horizons'].get('comparison_count')!=180
        or report.get('domain',{}).get('status')!='PASS' or report.get('motion',{}).get('status')!='PASS'):
        raise ValueError('Required direction, dense-domain and motion checks must pass')
    return actual


def merge_references(original,addition):
    result=deepcopy(original)
    keys=lambda r:(r['site_id'],r['target'])
    records=[*original['references'],*addition['references']]
    if len({keys(r) for r in records})!=len(records):raise ValueError('Duplicate reference observer/target')
    result['references']=records
    result['comparison_count']=sum(len(row['samples']) for row in records)
    result['max_angular_separation_deg']=max(row['separation_deg'] for record in records for row in record['samples'])
    result['status']='PASS' if result['max_angular_separation_deg']<.01 else 'FAIL'
    result['response_acquisitions']=[*original.get('response_acquisitions',[]),*addition.get('response_acquisitions',[])]
    # Different acquisition runs retain their own timestamps; assembly is not reacquisition.
    result['sourceGroups']=[{'scope':'Frozen four-site/finite-case reference run','comparison_count':original['comparison_count'],
                             'retrieved_utc':original.get('retrieved_utc')},
                            {'scope':'Six new south-pole study points','comparison_count':addition['comparison_count'],
                             'retrieved_utc':addition.get('retrieved_utc')}]
    result['acquisitionTimeScope']='Source groups retain original invocation times; no new acquisition is claimed for frozen references.'
    # Keep the original acquisition list only when it covers every merged source.
    if not addition.get('response_acquisitions'):result.pop('response_acquisitions',None)
    return result


def merge_domains(original,addition):
    result=deepcopy(original);rows=[*original['sites'],*addition['sites']]
    if len({row['site_id'] for row in rows})!=len(rows):raise ValueError('Duplicate dense-domain observer')
    for key in ['frame','correction','start_utc','end_utc','cadence_seconds','interlaced_cadence_seconds','code_sha256','kernels']:
        if _canonical(original.get(key))!=_canonical(addition.get(key)):raise ValueError('Domain provenance differs between source groups: '+key)
    result['sites']=rows
    result['status']='PASS' if all(row['status']=='PASS' for row in rows) else 'FAIL'
    result['interlaced_check']['maximum_angular_rate_change_deg_min']=max(
        original['interlaced_check']['maximum_angular_rate_change_deg_min'],addition['interlaced_check']['maximum_angular_rate_change_deg_min'])
    result['executionGroups']=[{'scope':'Frozen original study points and finite cases','generator_commit':original.get('generator_commit'),
                                'execution_seconds':original.get('execution_seconds'),'siteIds':[r['site_id'] for r in original['sites']]},
                               {'scope':'Six added south-pole study points','execution':addition.get('execution'),
                                'execution_seconds':addition.get('execution_seconds'),'siteIds':[r['site_id'] for r in addition['sites']]}]
    result.pop('execution_seconds',None)
    return result


def finalize(raw,baseline_dir,draft_dir,validation_dir,outdir,engine_commit):
    raw,baseline_dir,draft_dir,validation_dir,outdir=map(Path,(raw,baseline_dir,draft_dir,validation_dir,outdir))
    base_bytes=(baseline_dir/'bundle.json').read_bytes()
    if sha256(base_bytes).hexdigest()!=BASELINE_FILE_SHA256:raise ValueError('Frozen baseline bytes differ')
    baseline=json.loads(base_bytes);bundle=json.loads((draft_dir/'bundle.json').read_bytes())
    report=json.loads((validation_dir/'southpole-validation.json').read_bytes())
    checked_draft=check_validation_binding(bundle,report)
    original={s['id']:s for s in baseline['sites']};current={s['id']:s for s in bundle['sites']}
    if len(current)!=10 or any(_canonical(current.get(k))!=_canonical(v) for k,v in original.items()):raise ValueError('Original records changed or ten complete sites missing')
    references=json.loads((validation_dir/'horizons-validation.json').read_bytes())
    domain=json.loads((validation_dir/'domain-validation.json').read_bytes())
    motion=json.loads((validation_dir/'motion-envelope.json').read_bytes())
    for name in ['domain','motion']:
        file=validation_dir/('domain-validation.json' if name=='domain' else 'motion-envelope.json')
        if sha256(file.read_bytes()).hexdigest()!=report[name]['sha256']:raise ValueError('Executed validation artifact hash differs')
    manifest=bundle['manifest'];validation=manifest['validation']
    validation['horizons']=merge_references(validation['horizons'],references)
    validation['motionDomain']=merge_domains(validation['motionDomain'],domain)
    validation['motionEnvelope']=motion
    previous=validation['southpoleExpansion']
    validation['southpoleExpansion']={**previous,'status':'PASS','scope':'Executed numerical-model acceptance, not flight qualification or a mission feasibility verdict.',
        'validatedDraftPayloadSha256':checked_draft,'reportFile':'southpole-validation.json',
        'reportSha256':sha256((validation_dir/'southpole-validation.json').read_bytes()).hexdigest(),
        'newPointAudits':report['pointAudits'],'newNativeHorizonAudits':report['nativeHorizonAudits'],
        'directionComparisons':report['horizons'],'denseDomain':report['domain'],'motion':report['motion']}
    existing={r['filename'] for r in manifest['files']}
    for record in horizons_source_records(references):
        if record['filename'] in existing:raise ValueError('Reference source filename collision')
        manifest['files'].append(record);existing.add(record['filename'])
    manifest['engineCommit']=engine_commit;manifest['version']='1.2.0'
    manifest['southpoleAssembly']={'baselineCommit':'d1dd61e40cb00e0e4dea369217247eb69cacbe95',
        'baselineFileSha256':BASELINE_FILE_SHA256,'assembledUtc':datetime.now(UTC).isoformat(),
        'algorithmCommit':engine_commit,'preservation':'Original four complete scientific records and all finite-scenario arrays unchanged.'}
    write_release(bundle,baseline_dir,outdir)
    # Source generation remains frozen for the old scenarios; only their baseline binding changes.
    for name in ['southpole-validation.json','horizons-validation.json','domain-validation.json']:
        public={'horizons-validation.json':'horizons-southpole.json','domain-validation.json':'domain-southpole.json'}.get(name,name)
        shutil.copyfile(validation_dir/name,outdir/public)
    shutil.copyfile(validation_dir/'motion-envelope.json',outdir/'motion-envelope.json')
    append_products(raw,baseline_dir,outdir/'bundle.json',outdir)
    build_notes(raw,outdir/'bundle.json',outdir/'rendering-notes.json')
    atlas=build_atlas(raw,outdir,size=896,bounds=(-224000,-224000,224000,224000))
    atlas['limits']=[text.replace('200 m display','500 m display') for text in atlas['limits']]
    atlas['reproduce']='python -m science.southpole_release --raw data/raw --baseline-dir data/reference/southpole-baseline --draft-dir data/cache/southpole/release --validation-dir data/cache/southpole/validation --output data/cache/southpole/validated --engine-commit <verified-source-commit>'
    (outdir/'terrain-atlas.json').write_text(json.dumps(atlas,indent=2,sort_keys=True)+'\n',encoding='utf-8',newline='\n')
    print(json.dumps({'terrainSiteCount':len(bundle['sites']),'payloadSha256':bundle['manifest']['bundleSha256'],
                      'newSiteIds':[r[0] for r in SOUTHPOLE_SITES],'output':str(outdir)},indent=2))
    return bundle


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw',type=Path,default=Path('data/raw'))
    parser.add_argument('--baseline-dir',type=Path,default=Path('data/reference/southpole-baseline'))
    parser.add_argument('--draft-dir',type=Path,default=Path('data/cache/southpole/release'))
    parser.add_argument('--validation-dir',type=Path,default=Path('data/cache/southpole/validation'))
    parser.add_argument('--output',type=Path,default=Path('data/cache/southpole/validated'))
    parser.add_argument('--engine-commit',required=True)
    args=parser.parse_args();finalize(args.raw,args.baseline_dir,args.draft_dir,args.validation_dir,args.output,args.engine_commit)


if __name__=='__main__':main()
