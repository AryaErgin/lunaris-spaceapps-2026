// Sun and Earth directions above the LEVEL horizon for any lunar coordinate.
// Presentation and education only: no terrain is modelled here, so nothing in this
// module states whether a body is visible. Terrain-aware visibility exists only for
// the three study points and comes from the scientific bundle.
import {bodyDirection,localToMoonDirection,moonPoint} from './scene-model.mjs';

const DEG=180/Math.PI;
const MOON_RADIUS_KM=1737.4;
// The bundle caches apparent directions, not ranges. Earth's parallax across the Moon
// (up to 0.26 degrees) is removed with a mean distance; the monthly distance swing
// leaves an error below about 0.05 degrees, which the interface states.
const MEAN_EARTH_DISTANCE_KM=384400;
export const EARTH_DIRECTION_TOLERANCE_DEG=0.05;

// Coordinates are planetocentric latitude north and longitude east, in degrees.
const NSSDCA='https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html';
export const NOTABLE_SITES=[
  {id:'apollo-11',group:'Apollo (NASA)',name:'Apollo 11 · Tranquility Base',year:1969,lat:0.67416,lon:23.47314,source:NSSDCA},
  {id:'apollo-12',group:'Apollo (NASA)',name:'Apollo 12 · Ocean of Storms',year:1969,lat:-3.0128,lon:-23.4219,source:NSSDCA},
  {id:'apollo-14',group:'Apollo (NASA)',name:'Apollo 14 · Fra Mauro',year:1971,lat:-3.64589,lon:-17.47194,source:NSSDCA},
  {id:'apollo-15',group:'Apollo (NASA)',name:'Apollo 15 · Hadley–Apennine',year:1971,lat:26.13239,lon:3.6333,source:NSSDCA},
  {id:'apollo-16',group:'Apollo (NASA)',name:'Apollo 16 · Descartes',year:1972,lat:-8.9734,lon:15.5011,source:NSSDCA},
  {id:'apollo-17',group:'Apollo (NASA)',name:'Apollo 17 · Taurus–Littrow',year:1972,lat:20.1911,lon:30.7723,source:NSSDCA},
  {id:'blue-ghost-1',group:'NASA CLPS',name:'Blue Ghost Mission 1 · Mare Crisium',year:2025,lat:18.562,lon:61.81,
    source:'https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=2025-010A'},
  {id:'chandrayaan-3',group:'Other national programs',name:'Chandrayaan-3 · India',year:2023,lat:-69.373,lon:32.319,
    source:'https://en.wikipedia.org/wiki/Chandrayaan-3'},
  {id:'change-4',group:'Other national programs',name:'Chang’e 4 · China · far side',year:2019,lat:-45.4446,lon:177.5991,
    source:'https://doi.org/10.1038/s41467-019-12278-3'},
];

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cache=new WeakMap();

/** Moon-fixed Sun direction and Earth-centre position for every cached sample. */
export function referenceDirections(bundle){
  if(cache.has(bundle))return cache.get(bundle);
  const site=bundle.sites.find(s=>s.geometry?.length);
  if(!site)throw new Error('No cached geometry is available.');
  const radius=((site.referenceRadiusM??MOON_RADIUS_KM*1000)+(site.groundM??0)+(site.heightM??0))/1000;
  const observer=moonPoint(site.lat,site.lon,radius);
  const rows=[];
  for(const sample of site.geometry){
    const sunLocal=bodyDirection(sample[1],sample[2]),earthLocal=bodyDirection(sample[4],sample[5]);
    if(!sunLocal||!earthLocal){rows.push({time:sample[0],sun:null,earth:null});continue;}
    const sun=localToMoonDirection(site,sunLocal),toEarth=localToMoonDirection(site,earthLocal);
    // Solve |observer + range * toEarth| = mean Earth distance for the range along the cached line of sight.
    const along=dot(observer,toEarth),range=-along+Math.sqrt(along*along-(dot(observer,observer)-MEAN_EARTH_DISTANCE_KM**2));
    rows.push({time:sample[0],sun,earth:observer.map((value,i)=>value+range*toEarth[i])});
  }
  const result={rows,referenceSite:site.id,cadenceSeconds:rows.length>1?rows[1].time-rows[0].time:null};
  cache.set(bundle,result);return result;
}

function localFrame(lat,lon){
  const site={lat,lon};
  return {position:moonPoint(lat,lon,MOON_RADIUS_KM),east:localToMoonDirection(site,[1,0,0]),
    up:localToMoonDirection(site,[0,1,0]),south:localToMoonDirection(site,[0,0,1])};
}
function angles(frame,vector){
  const length=Math.hypot(...vector),unit=vector.map(v=>v/length);
  const elevation=Math.asin(Math.max(-1,Math.min(1,dot(unit,frame.up))))*DEG;
  const azimuth=(Math.atan2(dot(unit,frame.east),-dot(unit,frame.south))*DEG+360)%360;
  return {azimuth,elevation};
}

export function validCoordinate(lat,lon){
  return Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&lon>=-180&&lon<=360;
}

/** Sun and Earth-centre azimuth and elevation above the level horizon at one cached sample. */
export function skyAt(row,lat,lon,frame=localFrame(lat,lon)){
  if(!row?.sun||!row.earth)return null;
  return {time:row.time,sun:angles(frame,row.sun),earth:angles(frame,row.earth.map((value,i)=>value-frame.position[i]))};
}

/** Elevation series for both bodies over all cached samples. */
export function elevationSeries(bundle,lat,lon){
  const frame=localFrame(lat,lon);
  return referenceDirections(bundle).rows.map(row=>skyAt(row,lat,lon,frame)).filter(Boolean)
    .map(sky=>({time:sky.time,sun:sky.sun.elevation,earth:sky.earth.elevation}));
}

/**
 * Next time the body's centre crosses the level horizon after `time`.
 * Linear interpolation between cached samples. Returns null when the body stays on one
 * side for the rest of the cached data.
 */
export function nextLevelCrossing(series,key,time){
  const start=series.findIndex(point=>point.time>=time);
  if(start<0)return null;
  for(let i=Math.max(1,start+1);i<series.length;i++){
    const a=series[i-1],b=series[i];
    if(b.time-a.time>2*3600||a[key]===b[key])continue;
    if((a[key]>0)!==(b[key]>0)){
      const fraction=a[key]/(a[key]-b[key]);
      return {kind:a[key]>0?'sets':'rises',time:a.time+fraction*(b.time-a.time)};
    }
  }
  return null;
}

/** Share of the cached period with the body's centre above the level horizon. */
export function levelSummary(series,key){
  const above=series.filter(point=>point[key]>0).length;
  return {aboveFraction:series.length?above/series.length:null,min:Math.min(...series.map(p=>p[key])),max:Math.max(...series.map(p=>p[key]))};
}
