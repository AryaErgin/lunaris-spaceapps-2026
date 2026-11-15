import importlib
from copy import deepcopy

import pytest

from science.build import _write_bundle
from science.southpole_sites import SOUTHPOLE_SITES


def module():return importlib.import_module('science.southpole_release')


def report_fixture(tmp_path):
    bundle={'sites':[{'id':row[0]} for row in SOUTHPOLE_SITES],'manifest':{}}
    _write_bundle(bundle,tmp_path/'draft.json')
    ids=[row[0] for row in SOUTHPOLE_SITES]
    report={'status':'PASS','siteIds':ids,'structure':{'status':'PASS','expandedPayloadSha256':bundle['manifest']['bundleSha256']},
            'horizons':{'status':'PASS','comparison_count':180},'domain':{'status':'PASS'},'motion':{'status':'PASS'},
            'pointAudits':[{'siteId':i,'status':'PASS','sampledPoints':3} for i in ids],
            'nativeHorizonAudits':[{'siteId':i,'status':'PASS','sampleCount':72} for i in ids]}
    return bundle,report


def test_finalizer_requires_complete_evidence_bound_to_exact_draft(tmp_path):
    bundle,report=report_fixture(tmp_path)
    module().check_validation_binding(bundle,report)
    for changed in ['draft','missing_points','missing_native','zero_points','unchecked','horizons']:
        data=deepcopy(bundle);evidence=deepcopy(report)
        if changed=='draft':data['sites'][0]['lat']=-80
        if changed=='missing_points':evidence['pointAudits']=[]
        if changed=='missing_native':evidence['nativeHorizonAudits']=[]
        if changed=='zero_points':evidence['pointAudits'][0]['sampledPoints']=0
        if changed=='unchecked':evidence['status']='INDETERMINATE'
        if changed=='horizons':evidence['horizons']['comparison_count']=0
        with pytest.raises(ValueError):module().check_validation_binding(data,evidence)
