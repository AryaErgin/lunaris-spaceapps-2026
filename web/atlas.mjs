// Display-only NASA DEM atlas. The mission engine continues to use the frozen bundle.
const RAD=Math.PI/180;
export const POINT_MATCH_TOLERANCE_DEG=1e-6;

export function projectToMap(lat,lon,metadata) {
  const rho=2*metadata.projection.radiusM*Math.tan((90+lat)*RAD/2);
  const east=rho*Math.sin(lon*RAD),north=rho*Math.cos(lon*RAD);
  const [left,bottom,right,top]=metadata.display.boundsM;
  return {x:(east-left)/(right-left)*metadata.display.width,
    y:(top-north)/(top-bottom)*metadata.display.height};
}

export function mapToCoordinate(x,y,metadata) {
  const [left,bottom,right,top]=metadata.display.boundsM;
  const east=left+x/metadata.display.width*(right-left);
  const north=top-y/metadata.display.height*(top-bottom);
  return {lat:2*Math.atan2(Math.hypot(east,north),2*metadata.projection.radiusM)/RAD-90,
    lon:((Math.atan2(east,north)/RAD)%360+360)%360};
}

export function inspectCoordinate(bundle,metadata,latitude,longitude) {
  const absent=v=>v===null || v===undefined || (typeof v==='string' && !v.trim());
  const lat=Number(latitude),rawLon=Number(longitude);
  if(absent(latitude)||absent(longitude)||!Number.isFinite(lat)||!Number.isFinite(rawLon)
    ||lat< -90||lat>90||rawLon< -180||rawLon>360) {
    return {valid:false,calculationSupported:false,siteId:null,
      message:'Enter latitude from -90 to 90 degrees north and longitude from -180 to 360 degrees east.'};
  }
  const lon=((rawLon%360)+360)%360,point=projectToMap(lat,lon,metadata);
  const {width,height,noDataRuns=[]}=metadata.display;
  const inside=point.x>=0&&point.x<width&&point.y>=0&&point.y<height;
  const index=Math.floor(point.y)*width+Math.floor(point.x);
  const missing=inside&&noDataRuns.some(([start,length])=>index>=start&&index<start+length);
  const coverage=inside?(missing?'display-no-data':'display-valid'):'outside-display';
  const site=bundle.sites.find(s=>Math.abs(s.lat-lat)<=POINT_MATCH_TOLERANCE_DEG
    && Math.abs(((s.lon-lon+540)%360)-180)<=POINT_MATCH_TOLERANCE_DEG);
  const coordinate=`${lat.toFixed(6)} degrees north, ${lon.toFixed(6)} degrees east`;
  const support=site?`Matched ${site.name} within ${POINT_MATCH_TOLERANCE_DEG} degrees; using that exact cached study point.`
    :'Unsupported terrain-aware calculation: this coordinate has no cached horizon or visibility intervals. Mission decisions remain at the selected study point.';
  const detail=coverage==='display-valid'?'The displayed DEM cell contains valid source terrain; this alone does not establish calculation support.'
    :coverage==='display-no-data'?'The display cell has missing DEM data; no flat terrain is assumed.'
      :'This coordinate is outside the displayed DEM crop; no terrain inference is made here.';
  return {valid:true,lat,lon,point,coverage,insideMap:inside,calculationSupported:Boolean(site),
    siteId:site?.id??null,message:`${coordinate}. ${support} ${detail}`};
}

function svgNode(document,name,attributes={},text) {
  const node=document.createElementNS('http://www.w3.org/2000/svg',name);
  for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));
  if(text!==undefined)node.textContent=text;
  return node;
}

export async function createAtlas({bundle,mapRoot,sitesRoot,coordinateForm,feedback,onSelect=()=>{}}) {
  const url=new URL('./data/terrain-atlas.json',import.meta.url);
  const response=await fetch(url);
  if(!response.ok)throw new Error(`Terrain atlas metadata unavailable (${response.status})`);
  const metadata=await response.json(),document=mapRoot.ownerDocument;
  const {width,height,boundsM,spacingM}=metadata.display;
  const svg=svgNode(document,'svg',{viewBox:`0 0 ${width} ${height}`,role:'img',
    'aria-labelledby':'atlas-map-title atlas-description',class:'terrain-map'});
  svg.append(svgNode(document,'title',{id:'atlas-map-title'},'Lunar south-pole NASA LOLA terrain atlas'));
  svg.append(svgNode(document,'desc',{id:'atlas-description'},
    'South polar stereographic map: zero east up, ninety east right. Shaded relief from NASA terrain, not actual sunlight. Select a numbered study-point button below; click elsewhere only to inspect unsupported coordinates.'));
  const defs=svgNode(document,'defs');
  const pattern=svgNode(document,'pattern',{id:'atlas-missing',width:12,height:12,patternUnits:'userSpaceOnUse'});
  pattern.append(svgNode(document,'rect',{width:12,height:12,fill:'#18212d'}),
    svgNode(document,'path',{d:'M0 12L12 0',stroke:'#405168','stroke-width':2}));
  defs.append(pattern);svg.append(defs);
  svg.append(svgNode(document,'rect',{width,height,fill:'url(#atlas-missing)'}));
  svg.append(svgNode(document,'image',{href:new URL(metadata.display.image,url).href,x:0,y:0,width,height,
    preserveAspectRatio:'none'}));
  const grid=svgNode(document,'g',{fill:'none',stroke:'#d7eef2','stroke-opacity':'.32','stroke-width':'.8','pointer-events':'none'});
  for(const latitude of [-89.5,-89,-88.5,-88,-87.5]) {
    const edge=projectToMap(latitude,0,metadata),pole=projectToMap(-90,0,metadata);
    const radius=Math.abs(pole.y-edge.y);
    grid.append(svgNode(document,'circle',{cx:pole.x,cy:pole.y,r:radius}));
    if(edge.y>20)svg.append(svgNode(document,'text',{x:pole.x+6,y:edge.y-4,fill:'#e9f7fc','font-size':11,
      stroke:'#0a1720','stroke-width':2,'paint-order':'stroke',class:'map-graticule-label'},`${Math.abs(latitude)}° S`));
  }
  for(const longitude of [0,45,90,135,180,225,270,315]) {
    const start=projectToMap(-90,longitude,metadata),end=projectToMap(-85,longitude,metadata);
    grid.append(svgNode(document,'line',{x1:start.x,y1:start.y,x2:end.x,y2:end.y}));
  }
  svg.append(grid);
  const cardinalStyle={fill:'#e7f5f7','font-size':12,'font-weight':650,stroke:'#132130','stroke-width':3,'paint-order':'stroke'};
  for(const [label,x,y,anchor] of [['0° E',width/2,20,'middle'],['90° E',width-14,height/2,'end'],
    ['180° E',width/2,height-16,'middle'],['270° E',14,height/2,'start']]) {
    svg.append(svgNode(document,'text',{...cardinalStyle,x,y,'text-anchor':anchor},label));
  }
  const pole=projectToMap(-90,0,metadata);
  svg.append(svgNode(document,'path',{d:`M${pole.x-5} ${pole.y}h10 M${pole.x} ${pole.y-5}v10`,stroke:'#f0f5f3','stroke-width':1.3}));
  svg.append(svgNode(document,'text',{...cardinalStyle,x:pole.x+9,y:pole.y+17,'font-size':10},'SOUTH POLE'));
  const scaleWidth=20000/(boundsM[2]-boundsM[0])*width;
  svg.append(svgNode(document,'path',{d:`M24 ${height-35}v7h${scaleWidth}v-7`,stroke:'#eff9f9','stroke-width':2,fill:'none'}),
    svgNode(document,'text',{...cardinalStyle,x:24,y:height-42,'font-size':11},'20 km projected grid'));
  const markerGroup=svgNode(document,'g',{'aria-hidden':'true'}),markers=new Map(),buttons=new Map();
  let selected=bundle.demo?.siteId??bundle.sites[0]?.id;
  const select=siteId=>{setSelected(siteId);onSelect(siteId);};
  const list=document.createElement('div');list.className='atlas-site-list';
  bundle.sites.forEach((site,index)=>{
    const p=projectToMap(site.lat,site.lon,metadata);
    const marker=svgNode(document,'g',{class:'map-marker','data-site-id':site.id,transform:`translate(${p.x} ${p.y})`,cursor:'pointer'});
    marker.append(svgNode(document,'circle',{r:13,fill:'#102536',stroke:'#e7edf0','stroke-width':2}),
      svgNode(document,'text',{y:4.5,'text-anchor':'middle',fill:'#fff','font-size':12,'font-weight':750},index+1));
    marker.addEventListener('click',event=>{event.stopPropagation();select(site.id);});
    markerGroup.append(marker);markers.set(site.id,marker);
    const button=document.createElement('button');button.type='button';button.className='atlas-site-button';
    button.dataset.siteId=site.id;
    const name=document.createElement('strong');name.textContent=`${index+1}. ${site.name}`;
    const coords=document.createElement('span');coords.textContent=`${Math.abs(site.lat).toFixed(4)}° S · ${site.lon.toFixed(4)}° E`;
    button.append(name,coords);button.addEventListener('click',()=>select(site.id));
    list.append(button);buttons.set(site.id,button);
  });
  svg.append(markerGroup);
  const cursor=svgNode(document,'g',{'pointer-events':'none','aria-hidden':'true',visibility:'hidden'});
  cursor.append(svgNode(document,'circle',{r:7,fill:'none',stroke:'#ffc579','stroke-width':2}),
    svgNode(document,'path',{d:'M-13 0h7 M6 0h7 M0 -13v7 M0 6v7',stroke:'#ffc579','stroke-width':1.5}));
  svg.append(cursor);
  const caption=document.createElement('p');caption.className='map-caption';
  caption.textContent=`NASA LRO/LOLA · ${spacingM[0]} m display pixels from 80 m source. Artificial relief lighting; lighter elevation tint is generally higher. Hatched background marks missing terrain. Study-point numbers match the buttons.`;
  const provenance=document.createElement('details');provenance.className='atlas-provenance';
  const summary=document.createElement('summary');summary.textContent='Map provenance and limits';
  const details=document.createElement('p');
  details.textContent=`${metadata.source.filename} · SHA-256 ${metadata.source.sha256}. ${metadata.projection.frame}; ${metadata.projection.latitudeConvention}; ${metadata.projection.longitudeConvention}. Reference radius ${metadata.projection.radiusM.toLocaleString('en-US')} m. Source bounds ${metadata.source.raster.boundsM.join(', ')} m; displayed bounds ${boundsM.join(', ')} m. ${metadata.display.reduction}. ${metadata.limits.join(' ')}`;
  const source=document.createElement('a');source.href=metadata.source.citation;source.textContent='NASA PGDA terrain source';source.target='_blank';source.rel='noopener';
  provenance.append(summary,details,source);
  mapRoot.replaceChildren(svg,caption,provenance);sitesRoot.replaceChildren(list);
  if(feedback){feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');}

  function setSelected(siteId) {
    if(!buttons.has(siteId))return;
    selected=siteId;
    for(const [id,button] of buttons){button.setAttribute('aria-pressed',String(id===selected));button.classList.toggle('selected',id===selected);}
    for(const [id,marker] of markers){
      marker.classList.toggle('selected',id===selected);
      marker.firstChild.setAttribute('fill',id===selected?'#f1bd75':'#102536');
      marker.lastChild.setAttribute('fill',id===selected?'#12202d':'#fff');
    }
  }
  function explore(lat,lon) {
    const result=inspectCoordinate(bundle,metadata,lat,lon);
    if(feedback){feedback.textContent=result.message;feedback.dataset.supported=String(result.calculationSupported);}
    cursor.setAttribute('visibility',result.valid&&result.insideMap?'visible':'hidden');
    if(result.valid&&result.insideMap)cursor.setAttribute('transform',`translate(${result.point.x} ${result.point.y})`);
    if(result.siteId)select(result.siteId);
    return result;
  }
  coordinateForm?.addEventListener('submit',event=>{
    event.preventDefault();explore(coordinateForm.querySelector('#explore-lat')?.value,
      coordinateForm.querySelector('#explore-lon')?.value);
  });
  svg.addEventListener('click',event=>{
    const point=svg.createSVGPoint();point.x=event.clientX;point.y=event.clientY;
    const screen=svg.getScreenCTM();if(!screen)return;
    const position=point.matrixTransform(screen.inverse());
    const coordinate=mapToCoordinate(position.x,position.y,metadata);
    const latInput=coordinateForm?.querySelector('#explore-lat'),lonInput=coordinateForm?.querySelector('#explore-lon');
    if(latInput)latInput.value=coordinate.lat.toFixed(6);
    if(lonInput)lonInput.value=coordinate.lon.toFixed(6);
    explore(coordinate.lat,coordinate.lon);
  });
  setSelected(selected);
  return {setSelected,explore,metadata};
}
