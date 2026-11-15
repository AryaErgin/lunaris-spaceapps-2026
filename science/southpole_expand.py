"""Append source-verified south-pole sites without recomputing frozen results.

Three nested native polar DEM rings feed the existing curved-cell scanner and
visibility solver unchanged. Drafts are staged outside web/data until validated.
"""
from __future__ import annotations

import argparse
import json
from concurrent.futures import ProcessPoolExecutor
from copy import deepcopy
from hashlib import sha256
from math import cos, radians, sqrt
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.windows import Window

from science.build import _bounds_report, _canonical, _site, _write_bundle
from science.ephemerides import Ephemeris
from science.extended import (
    _json_atomic,
    _signature,
    _skyline_fingerprint,
    calendar_periods,
    runtime_versions,
    stitch_geometry,
    stitch_intervals,
)
from science.sources import REGIONAL
from science.terrain import (
    CAP_RADIUS_M,
    RADIUS_M,
    Skyline,
    _coverage_radius,
    _elevation,
    _raster_description,
    _scan,
    project,
)

BASELINE_FILE_SHA256='21a59be9b936ad4780d7ad3ea58a2d8ffaae4fff7f3cbea4a965398b370f8f67'


def projection_window_bound(lat, radius_m, pixel_m):
    """Bound projected distance along the disc plus its native cell cap.

    Stereographic local scale is sec²(colatitude/2). The maximum along a
    shortest spherical path is bounded by observer colatitude + arc length.
    The common scanner includes two extra projected pixels in its read window.
    """
    theta=radians(90+lat)+(radius_m+pixel_m/sqrt(2))/RADIUS_M
    required=(radius_m+pixel_m/sqrt(2))/(cos(theta/2)**2)
    if required>1.015*radius_m+2*pixel_m:
        raise ValueError('Existing polar projection window does not enclose this observer/domain')
    return required


def build_skyline(raw, row, *, count=3600, radius_m=240000):
    from science.southpole_sites import OUTER_REGIONAL, scan_rings
    raw=Path(raw);lat,lon=row[3:5];x,y=project(lat,lon)
    with rasterio.open(raw/f'{row[5]}_final_adj_5mpp_surf.tif') as local, \
         rasterio.open(raw/REGIONAL) as regional, rasterio.open(raw/OUTER_REGIONAL) as outer:
        descriptions=[_raster_description(dataset) for dataset in (local,regional,outer)]
        rings=scan_rings(_coverage_radius(local,x,y),_coverage_radius(regional,x,y),radius_m,
                         local.res[0],regional.res[0],outer.res[0])
        if _coverage_radius(outer,x,y)<1.015*radius_m+2*outer.res[0]:
            raise ValueError('Outer regional terrain does not enclose the entire search domain')
        native_row,native_col=local.index(x,y)
        cell=local.read(1,window=Window(native_col,native_row,1,1),masked=True)[0,0]
        if np.ma.is_masked(cell) or not np.isfinite(cell):
            raise ValueError('Native observer ground is missing; no height or horizon can be inferred')
        ground=float(cell);observer=RADIUS_M+ground+2.
        forward=Transformer.from_crs(local.crs.geodetic_crs,local.crs,always_xy=True)
        oracle_x,oracle_y=forward.transform(lon,lat)
        coordinate_error=float(np.hypot(oracle_x-x,oracle_y-y)/local.res[0])
        if coordinate_error>=.1:raise ValueError('Independent native coordinate check failed')
        arrays=[np.full(count,-np.inf) for _ in range(4)]
        blockers=np.full((count,4),np.nan);state=(*arrays,blockers)
        scans=[]
        for dataset,description,(inner,final) in zip((local,regional,outer)[:len(rings)],descriptions[:len(rings)],rings,strict=True):
            projection_window_bound(lat,final,dataset.res[0])
            scans.append(description|_scan(dataset,lat,lon,observer,inner,final,count,state)|
                         {'activeInnerM':inner,'activeOuterM':final})
        if len(scans)==2:
            scans.append(descriptions[2]|{'activeInnerM':radius_m,'activeOuterM':radius_m,'sampledValidCells':0,'sampledMaskedCells':0,'active':False})
        upper,lower,gaps,nominal=arrays
        empty=~np.isfinite(upper)
        upper[empty]=90.;lower[~np.isfinite(lower)]=-90.;gaps[~np.isfinite(gaps)]=-90.
        gaps[empty]=90.;nominal[empty]=np.nan
        far_cap=float(_elevation(CAP_RADIUS_M,observer,radius_m/RADIUS_M))
        info={'groundM':ground,'observerRadiusM':observer,'radialCapM':CAP_RADIUS_M,
              'searchRadiusM':radius_m,'azimuthBinDeg':360/count,'localOuterM':rings[0][1],
              'regionalInnerM':rings[1][0],'regionalOuterM':rings[1][1],
              'outerRegionalInnerM':rings[2][0] if len(rings)>2 else radius_m,
              'outerUnmodeledElevationCapDeg':far_cap,
              'nativeRasterRoundTripErrorPixels':coordinate_error,
              'local':scans[0],'regional':scans[1],'outerRegional':scans[2],
              'scanRings':[{'filename':scan['filename'],'innerM':scan['activeInnerM'],'outerM':scan['activeOuterM']} for scan in scans if scan['activeOuterM']>scan['activeInnerM']],
              'gapBins':int((gaps>upper).sum()),'farBoundBins':int((far_cap>upper).sum()),
              'model':'Nested native 5 m local, 80 m regional and 240 m outer regional cell-constant radial terrain'}
        return Skyline(lower,upper,nominal,gaps,far_cap,blockers,info)


def numerical_hashes():
    names=['southpole_expand.py','southpole_sites.py','terrain.py','build.py','visibility.py','ephemerides.py','extended.py']
    return {name:sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in names}


def cached_skylines(raw,row,cache,sources):
    identity={'row':row,'heightM':2.,'sources':sources,'code':numerical_hashes(),
              'settings':[[1800,200000],[3600,240000]],'versions':runtime_versions()}
    signature=_signature(identity);cache=Path(cache);cache.mkdir(parents=True,exist_ok=True)
    path=cache/f'sky-{row[0]}-{signature[:20]}.npz'
    if path.exists():
        with np.load(path,allow_pickle=False) as saved:
            if str(saved['signature'].item())!=signature:raise ValueError('Skyline cache identity differs')
            skies=[]
            for label,count in [('coarse',1800),('fine',3600)]:
                arrays={key:saved[f'{label}_{key}'].copy() for key in ['lower','upper','nominal','gap','blockers']}
                if any(arrays[key].shape!=(count,) for key in ['lower','upper','nominal','gap']) or arrays['blockers'].shape!=(count,4):
                    raise ValueError('Skyline cache dimensions differ')
                skies.append(Skyline(**arrays,far_cap=float(saved[f'{label}_far_cap']),info=json.loads(str(saved[f'{label}_info'].item()))))
            if str(saved['fingerprint'].item())!=_skyline_fingerprint(skies,identity):raise ValueError('Skyline cache payload differs')
        return tuple(skies),signature
    skies=tuple(build_skyline(raw,row,count=count,radius_m=radius) for count,radius in [(1800,200000),(3600,240000)])
    saved={'signature':signature,'fingerprint':_skyline_fingerprint(skies,identity)}
    for label,sky in zip(['coarse','fine'],skies,strict=True):
        saved.update({f'{label}_{key}':getattr(sky,key) for key in ['lower','upper','nominal','gap','blockers','far_cap']})
        saved[f'{label}_info']=_canonical(sky.info).decode()
    temp=path.with_suffix('.npz.tmp')
    with temp.open('wb') as stream:np.savez_compressed(stream,**saved)
    temp.replace(path)
    return skies,signature


def calculate_site(job):
    from science.southpole_sites import SITE_METADATA
    raw,row,cache,sources,start,end=job
    skies,sky_signature=cached_skylines(raw,row,cache,sources)
    parts=[]
    with Ephemeris(raw) as ephemeris:
        ephemeris.assert_coverage(start,end)
        for left,right in calendar_periods(start,end):
            signature=_signature({'sky':sky_signature,'period':[left,right],'code':numerical_hashes()})
            path=Path(cache)/f'period-{row[0]}-{left}-{signature[:20]}.json'
            if path.exists():
                saved=json.loads(path.read_bytes());part=saved['site']
                if saved['signature']!=signature or saved['fingerprint']!=_signature(part):raise ValueError('Monthly cache payload differs')
            else:
                part=_site(Path(raw),ephemeris,row,start=left,end=right,skylines=skies)
                _json_atomic(path,{'site':part,'signature':signature,'fingerprint':_signature(part)})
            for channel in ['sun','earth']:
                stitch_intervals([part[channel]],left,right)
                for level in ['coarse','fine']:stitch_intervals([part['refinementIntervals'][channel][level]],left,right)
            stitch_geometry([part['geometry']],left,right);parts.append(part)
    site=deepcopy(parts[0]);site.update(SITE_METADATA[row[0]])
    site['monthlyRefinement']=[{'coverage':[left,right],'channels':part['refinement'],
                              'maxSampledAngularRateDegMin':part['maxSampledAngularRateDegMin']}
                             for (left,right),part in zip(calendar_periods(start,end),parts,strict=True)]
    site['terrain']['warnings']=sorted({warning for part in parts for warning in part['terrain']['warnings']})
    site['terrain']['resolutionNote']='5 m nominal local grid with interpolation; 80 m regional grid within its complete native domain; 240 m outer regional grid. Pixel spacing is not effective resolution or a terrain-error bound.'
    for channel in ['sun','earth']:
        site[channel]=stitch_intervals([part[channel] for part in parts],start,end)
        for level in ['coarse','fine']:
            site['refinementIntervals'][channel][level]=stitch_intervals([part['refinementIntervals'][channel][level] for part in parts],start,end)
        site['refinement'][channel]=_bounds_report(site['refinementIntervals'][channel]['coarse'],site['refinementIntervals'][channel]['fine'],site[channel])
        site['refinement'][channel]['scope']='Whole-cache diagnostic; every mission retains both independently evaluated numerical models.'
        site['maxSampledAngularRateDegMin'][channel]=max(part['maxSampledAngularRateDegMin'][channel] for part in parts)
    site['geometry']=stitch_geometry([part['geometry'] for part in parts],start,end)
    _json_atomic(Path(cache)/f'site-{row[0]}.json',site)
    print(f'Completed draft {row[0]}: {len(site["geometry"])} cached samples',flush=True)
    return site


def append_sites(baseline,additions,sources,engine_commit):
    ids=[site['id'] for site in baseline['sites']+additions]
    if len(set(ids))!=len(ids):raise ValueError('Duplicate site identity cannot be appended')
    result=deepcopy(baseline);result['sites'].extend(deepcopy(additions))
    manifest=result['manifest'];manifest.pop('bundleSha256',None);manifest.pop('bundleHashConvention',None)
    manifest['engineCommit']=engine_commit
    existing={record['filename']:record for record in manifest['files']}
    for source in sources:
        record={**source,'local_file_acquired_utc':source['acquiredUtc'],
                'product_version':'NASA PGDA native GeoTIFF; pinned retrieval bytes',
                'use':'New south-pole local or outer-regional terrain; see per-site ring metadata'}
        if record['filename'] in existing and existing[record['filename']]['sha256']!=record['sha256']:
            raise ValueError('Conflicting terrain source identity')
        if record['filename'] not in existing:manifest['files'].append(record)
    manifest.setdefault('validation',{})['southpoleExpansion']={'status':'AWAITING_VALIDATION',
        'baselineFileSha256':BASELINE_FILE_SHA256,'preservedSiteIds':[site['id'] for site in baseline['sites']],
        'addedSiteIds':[site['id'] for site in additions],
        'preservedSiteFingerprints':{site['id']:_signature(site) for site in baseline['sites']},
        'numericalCodeSha256':numerical_hashes() if Path(__file__).with_name('southpole_sites.py').exists() else {}}
    return result


def write_release(bundle,baseline_dir,outdir):
    outdir=Path(outdir);outdir.mkdir(parents=True,exist_ok=True)
    _write_bundle(bundle,outdir/'bundle.json')
    for kind in ['height','position','terrain']:
        study=json.loads((Path(baseline_dir)/f'{kind}-study.json').read_bytes())
        original=_signature(study['scenarios'])
        study['manifest']['baselineBundleSha256']=bundle['manifest']['bundleSha256']
        _write_bundle(study,outdir/f'{kind}-study.json')
        if _signature(study['scenarios'])!=original:raise ValueError('Frozen scenario payload changed')


def main():
    from science.southpole_sites import SOUTHPOLE_SITES, source_manifest, verify_sites
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw',type=Path,default=Path('data/raw'))
    parser.add_argument('--baseline-dir',type=Path,default=Path('data/reference/southpole-baseline'))
    parser.add_argument('--cache',type=Path,default=Path('data/cache/southpole'))
    parser.add_argument('--outdir',type=Path,default=Path('data/cache/southpole/release'))
    parser.add_argument('--jobs',type=int,default=3)
    parser.add_argument('--engine-commit',required=True)
    args=parser.parse_args()
    base_bytes=(args.baseline_dir/'bundle.json').read_bytes()
    if sha256(base_bytes).hexdigest()!=BASELINE_FILE_SHA256:raise ValueError('Frozen four-site baseline bytes differ')
    baseline=json.loads(base_bytes);sources=source_manifest(args.raw);reports=verify_sites(args.raw)
    args.cache.mkdir(parents=True,exist_ok=True)
    _json_atomic(args.cache/'raw-coverage.json',reports)
    hashes={row['filename']:row['sha256'] for row in baseline['manifest']['files']+sources+baseline['manifest']['kernels']}
    jobs=[(str(args.raw),row,str(args.cache),hashes,*baseline['coverage']) for row in SOUTHPOLE_SITES]
    if not 1<=args.jobs<=6:raise ValueError('Use one to six bounded worker processes')
    with ProcessPoolExecutor(max_workers=args.jobs) as pool:sites=list(pool.map(calculate_site,jobs))
    bundle=append_sites(baseline,sites,sources,args.engine_commit)
    write_release(bundle,args.baseline_dir,args.outdir)
    print('Draft only: scientific validation and browser integration gates remain.',flush=True)


if __name__=='__main__':main()
