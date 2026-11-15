import importlib
from copy import deepcopy

import pytest


def module():return importlib.import_module('science.southpole_expand')


def test_append_preserves_original_site_payloads_and_rejects_collision():
    m=module();original={'coverage':[0,1800],'sites':[{'id':'frozen','lat':-89,'lon':0,'sun':[[0,1800,'visible']]}],'manifest':{'files':[]}}
    addition={'id':'new','lat':-85,'lon':40};before=deepcopy(original)
    merged=m.append_sites(original,[addition],[], 'test-sha')
    assert original==before
    assert merged['sites'][0]==original['sites'][0]
    assert merged['sites'][1]==addition
    with pytest.raises(ValueError,match='identity'):
        m.append_sites(original,[original['sites'][0]],[],'test-sha')


def test_projection_window_bound_encloses_complete_far_field_at_all_six_points():
    m=module()
    for lat in [-85.4381,-85.9948,-85.4266,-85.8296,-86.7639,-83.954]:
        assert m.projection_window_bound(lat,240000,240)<=1.015*240000+480
    with pytest.raises(ValueError,match='projection'):
        m.projection_window_bound(-70,240000,240)
