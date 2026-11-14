import { skySnapshot } from './overview.mjs';

const mounted = new WeakMap();
const ns = 'http://www.w3.org/2000/svg';
const make = (tag, attributes = {}, text) => {
  const n = document.createElementNS(ns, tag);
  for (const [key,value] of Object.entries(attributes)) n.setAttribute(key,value);
  if (text !== undefined) n.textContent = text;
  return n;
};
const html = (tag, className, text) => {
  const n = document.createElement(tag); n.className = className; n.textContent = text; return n;
};
const angle = v => Number.isFinite(v) ? `${v.toFixed(2)}°` : 'unknown';
const utc = t => new Date(t * 1000).toISOString().replace('T',' ').replace('.000Z',' UTC');

function build(root, site, mission, samples) {
  root.replaceChildren();
  const heading = html('div','sky-heading','');
  heading.append(html('h3','','Local horizon / Sun + Earth'), html('span','sky-site-name',site.name));
  const timestamp = html('p','sky-timestamp','');
  const rows = site.terrain?.skyline ?? [];
  const values = [...rows.flatMap(r => r.slice(1,4)), ...samples.flatMap(r => [r[2],r[5]])]
    .filter(v => Number.isFinite(v) && v > -89 && v < 89);
  const low = Math.min(-3,...values) - .7, high = Math.max(5,...values) + .7;
  const x = a => 58 + a * 900 / 360;
  const y = e => 322 - (e-low) * 286 / (high-low);
  const svg = make('svg',{viewBox:'0 0 1000 370',class:'horizon-canvas',role:'img',
    'aria-label':'Sampled Sun and Earth centers and trajectories above the NASA LOLA terrain skyline; symbols are not body sizes'});
  for (const a of [0,45,90,135,180,225,270,315,360]) {
    svg.append(make('line',{x1:x(a),x2:x(a),y1:30,y2:322,class:'sky-grid'}));
    const label = {0:'N · 0°',90:'E · 90°',180:'S · 180°',270:'W · 270°',360:'N · 360°'}[a] ?? `${a}°`;
    svg.append(make('text',{x:x(a),y:346,'text-anchor':'middle',class:'sky-axis-label','data-minor':String(a%90!==0)},label));
  }
  const midpoint=(high+low)/2;
  const levels = [...new Set([Math.ceil(low),0,...(Math.abs(midpoint)>1?[midpoint]:[]),Math.floor(high)])].sort((a,b)=>a-b);
  for (const elevation of levels) {
    svg.append(make('line',{x1:58,x2:958,y1:y(elevation),y2:y(elevation),class:elevation===0?'sky-zero':'sky-grid'}));
    svg.append(make('text',{x:50,y:y(elevation)+4,'text-anchor':'end',class:'sky-axis-label'},`${elevation.toFixed(1)}°`));
  }
  svg.append(make('text',{x:58,y:16,class:'sky-axis-label'},'ELEVATION / DEG'));
  svg.append(make('text',{x:958,y:366,'text-anchor':'end',class:'sky-axis-label'},'AZIMUTH · CLOCKWISE FROM LUNAR NORTH'));
  let ground = '', envelope = '', trace = '', unknown = '';
  rows.forEach((r,i) => {
    const a=x(r[0]), b=x(rows[i+1]?.[0] ?? 360);
    if (Number.isFinite(r[3])) ground += `M${a},322V${y(r[3])}H${b}V322Z`;
    if (Number.isFinite(r[1]) && Number.isFinite(r[2])) {
      envelope += `M${a},${y(r[1])}V${y(r[2])}H${b}V${y(r[1])}Z`;
    }
    if (Number.isFinite(r[3])) trace += `M${a},${y(r[3])}H${b}`;
    // A missing potentially blocking cap is shown as unavailable, never flattened.
    if (!Number.isFinite(r[1]) || !Number.isFinite(r[2]) || (Number.isFinite(r[4]) && r[4] > r[1])) {
      unknown += `M${a},30H${b}V322H${a}Z`;
    }
  });
  svg.append(make('path',{d:ground,class:'sky-ground'}),make('path',{d:envelope,class:'sky-envelope'}),
    make('path',{d:trace,class:'sky-trace'}),make('path',{d:unknown,class:'sky-unknown'}));
  const body = {}, metrics = {};
  for (const [key,az,el,label] of [['sun',1,2,'Sun'],['earth',4,5,'Earth']]) {
    let trajectory = '', previous;
    for (const row of samples) {
      if (!Number.isFinite(row[az]) || !Number.isFinite(row[el])) {previous=undefined; continue;}
      const bearing=((row[az]%360)+360)%360;
      const fresh = previous === undefined || Math.abs(bearing-previous)>180;
      trajectory += `${fresh?'M':'L'}${x(bearing)},${y(row[el])}`;
      previous=bearing;
    }
    svg.append(make('path',{d:trajectory,class:`sky-trajectory ${key}`}));
    const group = make('g',{class:`sky-body ${key}`});
    group.append(make('circle',{r:22,class:'sky-halo'}),make('circle',{r:13,class:'sky-orbit-ring'}),make('circle',{r:7,class:'sky-symbol'}));
    if (key==='earth') group.append(make('path',{d:'M-5,-3Q1,-5 2,-1T5,3M-4,3Q0,1 0,6',class:'sky-earth-mark'}));
    const text = make('text',{y:key==='sun'?-29:40,'text-anchor':'middle',class:'sky-body-label'},`${label.toUpperCase()} CENTER`);
    group.append(text); svg.append(group); body[key]=group;
    metrics[key]=html('p','sky-metric',''); metrics[key].dataset.target=key;
  }
  const crosshair = make('line',{y1:30,y2:322,class:'sky-crosshair'}); svg.append(crosshair);
  const note = html('p','secondary sky-note','');
  root.append(heading,timestamp,svg,...Object.values(metrics),note);
  const state = {site,mission,svg,body,metrics,timestamp,note,x,y,crosshair}; mounted.set(root,state); return state;
}

export function renderHorizon(root, site, sample, mission, samples) {
  let view = mounted.get(root);
  if (!view || view.site!==site || view.mission!==mission || !root.contains(view.svg)) view=build(root,site,mission,samples);
  const inMission = sample[0]>=mission.start && sample[0]<mission.end;
  const snapshot=skySnapshot(site,sample,inMission?mission:{...mission,timeline:{sun:site.sun,earth:site.earth}});
  root.dataset.time=snapshot.time;
  view.timestamp.textContent=`${utc(sample[0])} · CACHED GEOMETRY · ${inMission?'SELECTED MISSION':'MONTH EXPLORATION'}`;
  for (const [key,label] of [['sun','Sun'],['earth','Earth']]) {
    const data=snapshot[key], group=view.body[key];
    const known=data.azimuth!==null && data.elevation!==null;
    group.style.display=known?'':'none';
    if (known) {
      group.setAttribute('transform',`translate(${view.x(data.azimuth)} ${view.y(data.elevation)})`);
      group.style.transform=`translate(${view.x(data.azimuth)}px, ${view.y(data.elevation)}px)`;
    }
    group.dataset.state=data.state;
    view.metrics[key].textContent=`${label}: bearing ${angle(data.azimuth)}, elevation ${angle(data.elevation)}, terrain center trace ${angle(data.horizon)}. Retained interval: ${data.state}.`;
    view.metrics[key].dataset.azimuth=data.azimuth??'';
    view.metrics[key].dataset.elevation=data.elevation??'';
  }
  const bearing=snapshot.sun.azimuth;
  view.crosshair.style.display=bearing===null?'none':'';
  if(bearing!==null) {view.crosshair.setAttribute('x1',view.x(bearing));view.crosshair.setAttribute('x2',view.x(bearing));}
  view.note.textContent=`A terrain-aware schematic, not a photograph. Symbols are body centers, not discs; lines and eased marker motion connect cached positions for orientation. Telemetry uses actual 30-minute samples. Terrain band encloses sampled bounds, with missing potentially blocking sectors shaded separately. Marker positions do not establish PASS. Mission refinement: ${snapshot.refinement}. No RF link or electrical power model.`;
  return snapshot;
}
