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

def test_native_rasterio_crs_converts_to_independent_pyproj_frame(monkeypatch):
    from pathlib import Path

    import numpy as np

    from science.southpole_sites import OUTER_REGIONAL, SOUTHPOLE_SITES
    raw=Path('data/raw')
    if not (raw/OUTER_REGIONAL).is_file():pytest.skip('Native NASA inputs unavailable')
    m=module()
    def scan(dataset,lat,lon,observer,inner,outer,count,state):
        upper,lower,_gap,nominal,_blockers=state
        upper[:]=1.;lower[:]=0.;nominal[:]=.5
        return {'sampledValidCells':1,'sampledMaskedCells':0}
    monkeypatch.setattr(m,'_scan',scan)
    for identifier in ['nobile-rim-1','haworth']:
        row=next(row for row in SOUTHPOLE_SITES if row[0]==identifier)
        sky=m.build_skyline(raw,row,count=36,radius_m=200000)
        assert sky.info['nativeRasterRoundTripErrorPixels']<.1
        assert np.isfinite(sky.upper).all()
        assert len(sky.info['scanRings'])==(2 if identifier=='haworth' else 3)
