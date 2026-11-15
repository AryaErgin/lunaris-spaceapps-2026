import catalog from './data/site-catalog.json' with {type:'json'};

// This catalog describes coordinates and candidate DEMs, never computed terrain.
function deepFreeze(value){
  if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}
  return value;
}
export const NOTABLE_SITES=deepFreeze(catalog.sites);
export const SITE_CATALOG_VERSION=catalog.schemaVersion;
export const normalizeLongitudeEast=longitude=>((longitude%360)+360)%360;
const validCoordinate=(lat,lon)=>Number.isFinite(lat)&&Math.abs(lat)<=90&&Number.isFinite(lon)&&lon>=-180&&lon<=360;
function coverageOf(bundle){
  if(!Array.isArray(bundle?.coverage)||bundle.coverage.length!==2||!bundle.coverage.every(Number.isFinite)||bundle.coverage[1]<=bundle.coverage[0])
    throw Error('A finite increasing cached coverage interval is required.');
  return [...bundle.coverage];
}
function sameCoordinate(a,b){return a.lat===b.lat&&normalizeLongitudeEast(a.lon)===normalizeLongitudeEast(b.lon);}
function terrainAvailable(site,bundle){
  const model=site.terrain;
  const frame=bundle?.manifest?.frame?.working;
  if(!model||!frame||site.workingFrame!==frame||site.referenceRadiusM!==1737400||
    !Number.isFinite(site.groundM)||!Number.isFinite(site.heightM)||site.heightM<0||!site.source)return false;
  const pins=new Set((bundle.manifest.files??[]).filter(file=>/^[a-f0-9]{64}$/.test(file.sha256)).map(file=>file.filename));
  for(const level of ['coarse','fine']){
    const geometry=model[level];
    if(!geometry||geometry.groundM!==site.groundM||!Number.isFinite(geometry.observerRadiusM)||
      Math.abs(geometry.observerRadiusM-(site.referenceRadiusM+site.groundM+site.heightM))>1e-6)return false;
    const hasOuter=Boolean(model.coarse?.outerRegional||model.fine?.outerRegional);
    if(hasOuter&&(!geometry.outerRegional||!Number.isFinite(geometry.outerRegional.activeInnerM)||
      !Number.isFinite(geometry.outerRegional.activeOuterM)||geometry.outerRegional.activeOuterM<geometry.outerRegional.activeInnerM))return false;
    for(const role of (hasOuter?['local','regional','outerRegional']:['local','regional'])){
      const raster=geometry[role];
      if(!raster?.filename||!pins.has(raster.filename)||!Number.isFinite(raster.spacingM)||raster.spacingM<=0||!raster.wkt)return false;
    }
  }
  return Boolean(Array.isArray(site.sun)&&site.sun.length&&Array.isArray(site.earth)&&site.earth.length&&
    site.refinementIntervals?.sun?.coarse&&site.refinementIntervals?.sun?.fine&&
    site.refinementIntervals?.earth?.coarse&&site.refinementIntervals?.earth?.fine);
}
function descriptor(record,coverage,evidence=null,bundle=null){
  if(!validCoordinate(record.lat,record.lon))throw Error('Invalid lunar coordinate in site registry.');
  const terrain=terrainAvailable(evidence??{},bundle),capability=terrain?'terrain-aware':'geometry-only';
  return {...structuredClone(record),longitudeEast360:normalizeLongitudeEast(record.lon),
    capability,capabilities:{geometry:true,terrainVisibility:terrain,missionEvaluation:terrain,recoverySearch:terrain},
    geometryCoverage:[...coverage],terrainCoverage:terrain?[...coverage]:null,evidenceSiteId:terrain?record.id:null,
    predictionPeriodIsHistoricalReconstruction:false,
    coordinateStatus:record.coordinateStatus??'Published study point',
    sourceFrame:record.sourceFrame??'Not established',
    coordinateEvidence:structuredClone(record.coordinateEvidence??[{url:record.source,scope:record.coordinateReference??'Source recorded in frozen scientific bundle.'}]),
    limitations:[...(record.limitations??[]),...(!terrain&&evidence?['Terrain evidence is incomplete; this point is limited to approximate level-horizon geometry.']:[])]};
}
/** All selectable locations. bundle.sites remains exclusively scientific evidence. */
export function createSiteRegistry(bundle){
  const coverage=coverageOf(bundle),result=[],seen=new Set();
  for(const site of bundle.sites??[]){
    if(!site.id||seen.has(site.id))throw Error('Duplicate or missing terrain site identity.');
    seen.add(site.id);
    const historical=NOTABLE_SITES.find(item=>item.id===site.id);
    if(historical&&(!sameCoordinate(site,historical)||!terrainAvailable(site,bundle)))throw Error('Site ID collision with a curated historical coordinate.');
    // Never copy the large scientific timelines into the lightweight registry.
    const {geometry,sun,earth,refinementIntervals,terrain,...metadata}=site;
    result.push(descriptor({...historical,...metadata,group:historical?.group??'NASA south-pole study points'},coverage,site,bundle));
  }
  for(const site of NOTABLE_SITES)if(!seen.has(site.id))result.push(descriptor(site,coverage));
  return result;
}
/** An exact cached coordinate may use terrain; a nearby coordinate never inherits it. */
export function resolveLocation(bundle,selection){
  const registry=createSiteRegistry(bundle);
  if(typeof selection==='string'){
    const site=registry.find(item=>item.id===selection);
    if(!site)throw Error('Unknown site identity.');
    return site;
  }
  if(!selection||!validCoordinate(selection.lat,selection.lon))throw Error('Invalid lunar coordinate.');
  const exact=registry.find(site=>sameCoordinate(site,selection));
  if(exact)return exact;
  return descriptor({id:'custom',name:'Custom lunar coordinate',lat:selection.lat,lon:selection.lon,
    group:'Custom coordinate',source:null,sourceFrame:'User-supplied coordinate interpreted in the working ME frame',
    coordinateStatus:'User-supplied point; no terrain-aware calculation',coordinateEvidence:[],
    limitations:['Unsupported local terrain. No landing-safety, terrain visibility or mission-feasibility verdict is available.']},coverageOf(bundle));
}
