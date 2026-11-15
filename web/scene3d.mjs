// Display renderer only. Visibility and all mission decisions come from frozen intervals.
import {bodyDirection, moonPoint,localToMoonDirection} from './scene-model.mjs';
import {NOTABLE_SITES} from './anysite.mjs';
import {surfaceUVs,surfacePhotoLevel,surfaceVisualRecord} from './surface-visuals.mjs';

const RAD=Math.PI/180;
const asset=name=>new URL(`./assets/${name}`,import.meta.url).href;
const terrainUrl=new URL('./data/terrain-scenes.json',import.meta.url);
const surfaceVisualsUrl=new URL('./assets/surface/manifest.json',import.meta.url);
const clamp=(value,lo,hi)=>Math.max(lo,Math.min(hi,value));

export const moonFixedPosition=moonPoint;
// Catalog pins are geographical context. Only bundle study points have terrain-aware evidence.
export function orbitalMarkerRecords(studyPoints) {
  return [...studyPoints.map(point=>({point,kind:'terrain',terrainAware:true,symbol:'○',color:0xeebf74})),
    ...NOTABLE_SITES.map(point=>({point,kind:'context',terrainAware:false,symbol:'◇',color:0x8edbea}))]
    .map(record=>({...record,position:moonPoint(record.point.lat,record.point.lon,1.008)}));
}
export function surfaceLightState(sunState,hasDirection,enhanced=false){
  const lit=hasDirection&&sunState==='visible';
  return {direct:lit?2.3:0,ambient:(lit||enhanced)? .18:.002,fill:(lit||enhanced)? .3:0,
    skylineLevel:lit?1:(enhanced? .5:0),skylineFloor:(lit||enhanced)? .02:.001,enhanced:Boolean(enhanced)};
}
// Display framing only: a zoomed, lifted overview. Directions and sizes in the scene are unchanged.
const ORBITAL_CINEMATIC_ZOOM=1.08,ORBITAL_CINEMATIC_LIFT=.03;
export function orbitalOverviewDistance(width,height) {
  if(width>900)return 3.3;
  const horizontalHalfFov=Math.atan(Math.tan(39*RAD/2)*Math.max(1,width)/Math.max(1,height));
  return Math.max(3.3,1/Math.sin(horizontalHalfFov*.67));
}
export function orbitalOverviewPosition(width,height) {
  const radius=orbitalOverviewDistance(width,height),length=Math.hypot(3.2,-1.9,-.4);
  // Keep the actual south-pole points in front of the finite-distance limb.
  return [3.2,-1.9,-.4].map(value=>value*radius/length);
}
// Geographical pins never move. Only overlapping selection targets are combined.
export function terrainMarkerLayout(views,width,height,targetSize=44) {
  const visible=views.filter(view=>view.visible&&view.projectedPosition?.every(Number.isFinite));
  const grouped=visible.length>1&&visible.some((a,i)=>visible.slice(i+1).some(b=>
    Math.hypot((a.projectedPosition[0]-b.projectedPosition[0])*width,
      (a.projectedPosition[1]-b.projectedPosition[1])*height)<targetSize));
  return {grouped,ids:visible.map(view=>view.id),anchor:visible.length?
    [0,1].map(axis=>visible.reduce((sum,view)=>sum+view.projectedPosition[axis],0)/visible.length):null};
}
export function terrainFocusBearing(site) {
  let best=null;
  for(const row of site?.terrain?.skyline??[]) {
    if(!Number.isFinite(row?.[0])||!Number.isFinite(row?.[3]))continue;
    if(!best||row[3]>best[3])best=row;
  }
  return best?(best[0]>=0&&best[0]<360?best[0]:((best[0]%360)+360)%360):0;
}
export function renderedBodies(sample,states={}) {
  return Object.fromEntries([['sun',1,2],['earth',4,5]].map(([key,az,el])=>[
    key,states[key]==='visible'&&Boolean(bodyDirection(sample?.[az],sample?.[el])),
  ]));
}

export function farHorizonData(site,rangeM=200000) {
  const rows=site?.terrain?.skyline??[],bin=site?.terrain?.fine?.azimuthBinDeg;
  const positions=[],indices=[];
  let sectorCount=0,maxSourceBlockerDistanceM=0,sourceSectorsBeyond32Km=0;
  if(!Number.isFinite(site?.heightM)||!Number.isFinite(bin)||bin<=0||bin>360||!Number.isFinite(rangeM)||rangeM<=0) {
    return {positions:new Float32Array(),indices:new Uint32Array(),sectorCount,skippedSectors:rows.length,rangeM,maxSourceBlockerDistanceM,sourceSectorsBeyond32Km};
  }
  const lowerY=site.heightM+Math.tan(-60*RAD)*rangeM;
  for(const row of rows) {
    // A gap cap other than the no-gap sentinel makes this sector unavailable.
    if(![row?.[0],row?.[1],row?.[2],row?.[3],row?.[4]].every(Number.isFinite)||row[4]>-89.999||Math.abs(row[3])>=89||row[1]>row[2])continue;
    const start=row[0]*RAD,end=(row[0]+bin)*RAD,topY=site.heightM+Math.tan(row[3]*RAD)*rangeM;
    const first=positions.length/3;
    positions.push(Math.sin(start)*rangeM,topY,-Math.cos(start)*rangeM,
      Math.sin(end)*rangeM,topY,-Math.cos(end)*rangeM,
      Math.sin(start)*rangeM,lowerY,-Math.cos(start)*rangeM,
      Math.sin(end)*rangeM,lowerY,-Math.cos(end)*rangeM);
    indices.push(first,first+2,first+1,first+1,first+2,first+3);sectorCount++;
    const distance=row[5]?.[2];
    if(Number.isFinite(distance)){maxSourceBlockerDistanceM=Math.max(maxSourceBlockerDistanceM,distance);if(distance>32000)sourceSectorsBeyond32Km++;}
  }
  return {positions:new Float32Array(positions),indices:new Uint32Array(indices),sectorCount,skippedSectors:rows.length-sectorCount,rangeM,maxSourceBlockerDistanceM,sourceSectorsBeyond32Km};
}

export function bodyFraming(localDirection,verticalFovDeg,aspect) {
  const unavailable={inFrustum:false,projectedPosition:null,projectedBearingDeg:null,behindCamera:null};
  if(!localDirection?.every(Number.isFinite)||localDirection.length!==3||!Number.isFinite(verticalFovDeg)||verticalFovDeg<=0||verticalFovDeg>=180||!Number.isFinite(aspect)||aspect<=0||Math.hypot(...localDirection)===0)return unavailable;
  const [x,y,z]=localDirection,behindCamera=z>=0;
  const projectedBearingDeg=x===0&&y===0?null:((Math.atan2(x,y)/RAD)%360+360)%360;
  if(behindCamera)return {...unavailable,behindCamera,projectedBearingDeg};
  const halfHeight=Math.tan(verticalFovDeg*RAD/2),px=x/(-z*halfHeight*aspect),py=y/(-z*halfHeight);
  return {inFrustum:Math.abs(px)<=1&&Math.abs(py)<=1,projectedPosition:[px*.5+.5,.5-py*.5],projectedBearingDeg,behindCamera};
}

export function terrainBufferViews(buffer,metadata) {
  const {vertexCount,indexCount,positionsByteOffset=0,indicesByteOffset=vertexCount*12,byteLength}=metadata;
  if(!(buffer instanceof ArrayBuffer)||!Number.isInteger(vertexCount)||vertexCount<3||
     !Number.isInteger(indexCount)||indexCount<3||indexCount%3||
     !Number.isInteger(positionsByteOffset)||positionsByteOffset<0||positionsByteOffset%4||
     !Number.isInteger(indicesByteOffset)||indicesByteOffset%4||indicesByteOffset<positionsByteOffset+vertexCount*12||
     buffer.byteLength!==byteLength||indicesByteOffset+indexCount*4>buffer.byteLength) {
    throw new Error('Terrain binary length or layout does not match its metadata.');
  }
  const positions=new Float32Array(buffer,positionsByteOffset,vertexCount*3);
  const indices=new Uint32Array(buffer,indicesByteOffset,indexCount);
  if(positions.some(value=>!Number.isFinite(value)))throw new Error('Terrain contains invalid positions.');
  if(indices.some(index=>index>=vertexCount))throw new Error('Terrain index exceeds the vertex count.');
  return {positions,indices};
}

export async function createMissionScene({container,bundle,onSiteSelect=()=>{},onContextSelect=()=>{},onModeChange=()=>{},onStatus=()=>{}}) {
  if(!container||!bundle?.sites?.length)throw new Error('A scene container and cached study points are required.');
  const vendor=await import('./vendor/three-bundle.mjs');
  const THREE=vendor.THREE??vendor,OrbitControls=vendor.OrbitControls;
  let disposed=false,lost=false,mode='orbital',site=bundle.sites[0],sample=null,states={};
  let raf=0,intersecting=true,flight=null,pendingMode=null,pendingFocus=null,terrainRequest=0,terrainMetadataPromise;
  let modeTransition=0,transitionTimer=0;
  let terrainMesh=null,terrainSiteId=null,terrainRecord=null,terrainError=null;
  let surfaceDetailMesh=null,surfaceVisualEntry=null,surfaceVisualError=null,surfaceVisualsPromise=null,surfaceVisualAbort=null;
  let surfaceImageryEnabled=true;
  let surfaceSourceSignature='';
  let moonTextureLoaded=false,earthTextureLoaded=false,moonBumpLoaded=false;
  let moonDetail='loading',moonHighDetailPromise=null,farHorizonMesh=null,farHorizonRecord=null,farHorizonSiteId=null;
  let terrainBearingDeg=terrainFocusBearing(site);
  let yaw=0,pitch=-5*RAD,surfaceFov=65,surfaceFocus='terrain',orbitalFocus='Moon',needsRender=true,captionSignature='';
  let enhancedNight=false;
  let contextSite=null;
  const mobileQuality=window.matchMedia('(max-width:700px)').matches||navigator.connection?.saveData===true;
  const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const resources=new Set(),listeners=[],terrainCache=new Map(),farHorizonCache=new Map();
  const surfaceVisualCache=new Map();
  const track=resource=>(resources.add(resource),resource);
  const listen=(target,event,fn,options)=>{target.addEventListener(event,fn,options);listeners.push(()=>target.removeEventListener(event,fn,options));};
  const report=(kind,message)=>{if(disposed||lost&&kind!=='error')return;onStatus({kind,message,mode,siteId:site.id});};
  container.classList.add('mission-scene');
  Object.assign(container.dataset,{mode,site:site.id,frame:'',sunRendered:'false',earthRendered:'false',moonDetail,webgl:'loading',webglStatus:'loading',terrainStatus:'unloaded',farHorizonSectors:'0',farHorizonSource:'retained nominal angular skyline; display projection only'});
  const canvas=document.createElement('canvas');
  canvas.className='mission-scene-canvas';canvas.tabIndex=0;
  canvas.setAttribute('role','application');
  canvas.setAttribute('aria-label','Interactive Moon. Drag to rotate; scroll or pinch to zoom. Arrow keys rotate; plus and minus zoom. Scroll outside the scene to move the page.');
  container.append(canvas);
  let renderer;
  try {
    renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance',logarithmicDepthBuffer:true});
  } catch(error) {
    canvas.remove();container.dataset.webgl=container.dataset.webglStatus='unavailable';
    report('error','WebGL is unavailable. Use the accessible mission and terrain views.');throw error;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,mobileQuality?1.25:1.5));
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
  // Shadow maps alias badly at polar Sun elevations of a few degrees; slopes turned from the Sun shade themselves instead.
  renderer.shadowMap.enabled=false;
  renderer.setClearColor(0x000000,1);
  renderer.debug.onShaderError=()=>report('error','A 3D shader could not be compiled. The scientific 2D views remain available.');
  container.dataset.webgl=container.dataset.webglStatus='ready';

  const caption=document.createElement('div');caption.className='mission-scene-caption';
  const location=document.createElement('span');location.className='mission-scene-location';
  const setLocation=(name,coordinates)=>{
    const title=document.createElement('strong'),detail=document.createElement('span');
    const separator=document.createElement('span');separator.className='mission-scene-separator';separator.textContent=' · ';
    title.textContent=name;detail.textContent=coordinates;location.replaceChildren(title,separator,detail);
  };
  const note=document.createElement('span');note.className='mission-scene-note mission-scene-direction-note';
  caption.append(location,note);container.append(caption);
  const surfaceSource=document.createElement('span');surfaceSource.className='mission-surface-source';surfaceSource.hidden=true;caption.append(surfaceSource);
  const bodyStatus=document.createElement('div');bodyStatus.className='mission-scene-body-status';
  bodyStatus.setAttribute('aria-live','polite');container.append(bodyStatus);
  const markerLabel=document.createElement('div');markerLabel.className='mission-scene-marker-label';container.append(markerLabel);
  const markerLegend=document.createElement('div');markerLegend.className='mission-marker-legend';
  markerLegend.innerHTML='<span>○ Terrain study points</span><span>◇ Other landing locations · level horizon only</span>';container.append(markerLegend);
  const terrainCluster=document.createElement('details');terrainCluster.className='mission-terrain-cluster';terrainCluster.hidden=true;
  const terrainLeader=document.createElement('span');terrainLeader.className='mission-terrain-leader';terrainLeader.hidden=true;container.append(terrainLeader);
  const terrainClusterSummary=document.createElement('summary');terrainClusterSummary.textContent=`${bundle.sites.length} study points`;
  terrainClusterSummary.setAttribute('aria-label','Choose a terrain-aware south-pole study point');
  const terrainClusterList=document.createElement('div');terrainClusterList.className='mission-terrain-choices';
  terrainCluster.append(terrainClusterSummary,terrainClusterList);container.append(terrainCluster);
  listen(terrainCluster,'toggle',()=>{if(terrainCluster.open)updateTerrainPins();});
  listen(window,'scroll',()=>{if(terrainCluster.open)updateTerrainPins();},{passive:true});
  listen(terrainCluster,'keydown',event=>{if(event.key==='Escape'){event.preventDefault();terrainCluster.open=false;terrainClusterSummary.focus();}});
  listen(document,'pointerdown',event=>{if(terrainCluster.open&&!terrainCluster.contains(event.target))terrainCluster.open=false;});
  // Orbital bodies are drawn at fixed approximate angular sizes, so small labels make them findable.
  const bodyLabels={};
  const obstruction=document.createElement('div');obstruction.className='mission-terrain-obstruction';obstruction.hidden=true;
  obstruction.textContent='Earth’s center is behind the terrain horizon in this direction ↓';obstruction.dataset.body='earth';
  container.append(obstruction);
  for(const [key,text] of [['earth','EARTH'],['sun','SUN']]) {
    const label=document.createElement('div');label.className='mission-scene-body-label';label.dataset.body=key;label.textContent=text;label.hidden=true;
    container.append(label);bodyLabels[key]=label;
  }

  const orbitalScene=new THREE.Scene(),surfaceScene=new THREE.Scene();
  orbitalScene.background=surfaceScene.background=new THREE.Color(0x000000);
  const orbitalCamera=new THREE.PerspectiveCamera(39,1,.01,260);
  orbitalCamera.position.fromArray(orbitalOverviewPosition(container.clientWidth,container.clientHeight));orbitalCamera.lookAt(0,0,0);
  const surfaceCamera=new THREE.PerspectiveCamera(surfaceFov,1,.08,500000);
  const controls=new OrbitControls(orbitalCamera,canvas);
  controls.enableDamping=!reducedMotion;controls.dampingFactor=.075;
  controls.enablePan=false;controls.enableZoom=true;controls.enableRotate=true;
  controls.minDistance=1.06;controls.maxDistance=18;controls.rotateSpeed=.55;controls.zoomSpeed=.65;
  listen(controls,'change',()=>invalidate());listen(controls,'start',()=>{flight=null;});

  const moonMaterial=track(new THREE.MeshStandardMaterial({color:0xeeeeea,roughness:1,metalness:0}));
  const moon=new THREE.Mesh(track(new THREE.SphereGeometry(1,128,96)),moonMaterial);
  orbitalScene.add(moon);
  orbitalScene.add(new THREE.AmbientLight(0xffffff,.24));
  const globeLight=new THREE.DirectionalLight(0xfff2df,2.9);globeLight.position.set(4,1.5,-2);orbitalScene.add(globeLight);
  const markers=[];
  const ringGeometry=track(new THREE.RingGeometry(.0017,.0025,36));
  const contextGeometry=track(new THREE.RingGeometry(.004,.007,4,1,Math.PI/4));
  const dotGeometry=track(new THREE.SphereGeometry(.0012,12,8));
  const normal=new THREE.Vector3(0,0,1);
  orbitalMarkerRecords(bundle.sites).forEach((record,index)=>{
    const {point,kind}=record;
    const group=new THREE.Group();group.position.fromArray(record.position);
    group.quaternion.setFromUnitVectors(normal,group.position.clone().normalize());
    const material=track(new THREE.MeshBasicMaterial({color:record.color,side:THREE.DoubleSide,depthTest:true}));
    const ring=new THREE.Mesh(kind==='context'?contextGeometry:ringGeometry,material);group.add(ring);
    const dot=new THREE.Mesh(dotGeometry,material);dot.position.z=.006;group.add(dot);
    ring.userData.siteId=dot.userData.siteId=point.id;orbitalScene.add(group);
    let button=null,pin=null,choice=null;
    if(kind==='context'){
      button=document.createElement('button');button.className='mission-context-marker';button.type='button';button.hidden=true;
      button.dataset.contextSite=point.id;button.textContent=record.symbol;
      button.setAttribute('aria-label',`${point.name}: explore Sun and Earth above a level horizon; local terrain is not modeled.`);
      button.title=`${point.name} (${point.year}) · level-horizon geometry only`;
      listen(button,'click',event=>{
        let chosen=point;
        // Some Apollo sites are close on the globe. A pointer chooses the nearest
        // real projected pin even when generous touch targets overlap; keyboard
        // activation always chooses the focused named button.
        if(event.detail>0){
          const bounds=canvas.getBoundingClientRect();
          const nearest=markers.filter(marker=>marker.kind==='context').map(marker=>{
            const view=markerView(marker);
            return {point:marker.site,distance:view.visible?Math.hypot(bounds.left+view.projectedPosition[0]*bounds.width-event.clientX,
              bounds.top+view.projectedPosition[1]*bounds.height-event.clientY):Infinity};
          }).sort((a,b)=>a.distance-b.distance)[0];
          if(nearest&&Number.isFinite(nearest.distance))chosen=nearest.point;
        }
        selectContextSite(chosen.id);onContextSelect(chosen);
      });container.append(button);
    }else{
      pin=document.createElement('span');pin.className='mission-terrain-pin';pin.dataset.siteId=point.id;pin.hidden=true;pin.setAttribute('aria-hidden','true');container.append(pin);
      button=document.createElement('button');button.className='mission-terrain-marker';button.type='button';button.hidden=true;button.dataset.terrainSite=point.id;
      button.setAttribute('aria-label',`Select ${point.name}, terrain-aware study point`);button.title=point.name;container.append(button);
      choice=document.createElement('button');choice.type='button';choice.dataset.terrainSite=point.id;
      const name=document.createElement('strong');name.textContent=point.name;
      const coordinates=document.createElement('span');coordinates.textContent=`${Math.abs(point.lat).toFixed(4)}\u00b0 S \u00b7 ${point.lon.toFixed(4)}\u00b0 E`;
      choice.append(name,coordinates);terrainClusterList.append(choice);
      const choose=()=>{terrainCluster.open=false;selectSite(point.id);onSiteSelect(point.id);};
      listen(button,'click',choose);listen(choice,'click',choose);
    }
    markers.push({group,ring,dot,material,site:point,index,kind,button,pin,choice});
  });

  // Both sky objects retain their angular scale. Focus changes the camera FOV.
  // Display depth only: place angular-sized sky objects behind the projected skyline.
  const skyDistance=400000;
  const sun=new THREE.Group();
  const sphereVertex=`varying vec3 vNormalEye; varying vec3 vViewEye;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0);vNormalEye=normalMatrix*normal;vViewEye=-mv.xyz;gl_Position=projectionMatrix*mv;
    #include <logdepthbuf_vertex>
    }`;
  const sunMaterial=track(new THREE.ShaderMaterial({toneMapped:false,vertexShader:sphereVertex,
    fragmentShader:`varying vec3 vNormalEye;varying vec3 vViewEye;
    #include <logdepthbuf_pars_fragment>
    void main(){
    #include <logdepthbuf_fragment>
    float facing=max(0.0,dot(normalize(vNormalEye),normalize(vViewEye)));vec3 color=mix(vec3(1.0,0.72,0.37),vec3(1.0,0.98,0.87),pow(facing,0.25));gl_FragColor=vec4(color,1.0);}` }));
  const sunDisc=new THREE.Mesh(track(new THREE.SphereGeometry(skyDistance*Math.tan(.265*RAD),32,20)),
    sunMaterial);
  sun.add(sunDisc);sun.visible=false;surfaceScene.add(sun);
  const glowCanvas=document.createElement('canvas');glowCanvas.width=glowCanvas.height=256;
  const glowContext=glowCanvas.getContext('2d');
  if(glowContext) {
    // Illustrative camera glare. The disc itself keeps its 0.53 degree apparent diameter.
    const gradient=glowContext.createRadialGradient(128,128,2,128,128,128);
    gradient.addColorStop(0,'rgba(255,252,240,0.95)');gradient.addColorStop(.035,'rgba(255,246,222,0.7)');gradient.addColorStop(.09,'rgba(255,232,186,0.26)');
    gradient.addColorStop(.25,'rgba(255,218,160,0.085)');gradient.addColorStop(.6,'rgba(255,205,140,0.02)');gradient.addColorStop(1,'rgba(255,194,92,0)');
    glowContext.fillStyle=gradient;glowContext.fillRect(0,0,256,256);
    glowContext.globalCompositeOperation='lighter';
    for(const angle of [0,Math.PI/2]) {
      glowContext.save();glowContext.translate(128,128);glowContext.rotate(angle);
      const streak=glowContext.createLinearGradient(-128,0,128,0);
      streak.addColorStop(0,'rgba(255,230,190,0)');streak.addColorStop(.5,'rgba(255,240,214,0.22)');streak.addColorStop(1,'rgba(255,230,190,0)');
      glowContext.fillStyle=streak;glowContext.fillRect(-128,-1.2,256,2.4);glowContext.restore();
    }
    const sprite=new THREE.Sprite(track(new THREE.SpriteMaterial({map:track(new THREE.CanvasTexture(glowCanvas)),transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false})));
    const size=skyDistance*Math.tan(.265*RAD)*20;sprite.scale.set(size,size,1);sun.add(sprite);
  }
  // Earth's lit hemisphere follows the cached apparent Sun direction (the Sun is far enough that
  // the Moon-to-Sun and Earth-to-Sun directions differ by under 0.2 degrees). The geographic face
  // and cloud-free Blue Marble composite remain unregistered to the simulated time.
  const earthShader=()=>track(new THREE.ShaderMaterial({toneMapped:false,
    uniforms:{map:{value:null},sunDirection:{value:new THREE.Vector3(0,1,0)},phaseLit:{value:1}},
    vertexShader:`varying vec2 vUv;varying vec3 vNormalWorld;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main(){vUv=uv;vNormalWorld=normalize(mat3(modelMatrix)*normal);vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;
    #include <logdepthbuf_vertex>
    }`,
    fragmentShader:`uniform sampler2D map;uniform vec3 sunDirection;uniform float phaseLit;varying vec2 vUv;varying vec3 vNormalWorld;
    #include <logdepthbuf_pars_fragment>
    void main(){
    #include <logdepthbuf_fragment>
    vec3 day=texture2D(map,vUv).rgb;float mu=dot(normalize(vNormalWorld),normalize(sunDirection));
    float lit=mix(1.0,smoothstep(-0.06,0.2,mu),phaseLit);
    gl_FragColor=vec4(day*(0.012+1.3*lit)+vec3(0.06,0.12,0.24)*lit*0.3,1.0);
    #include <colorspace_fragment>
    }`}));
  const earthMaterial=earthShader();
  const earth=new THREE.Mesh(track(new THREE.SphereGeometry(skyDistance*Math.tan(.95*RAD),64,48)),earthMaterial);
  earth.rotation.y=-.7;earth.rotation.z=.12;earth.visible=false;surfaceScene.add(earth);
  const limbMaterial=track(new THREE.ShaderMaterial({transparent:true,depthWrite:false,depthTest:true,blending:THREE.AdditiveBlending,toneMapped:false,vertexShader:sphereVertex,
    fragmentShader:`varying vec3 vNormalEye;varying vec3 vViewEye;
    #include <logdepthbuf_pars_fragment>
    void main(){
    #include <logdepthbuf_fragment>
    float rim=pow(1.0-max(0.0,dot(normalize(vNormalEye),normalize(vViewEye))),4.0);gl_FragColor=vec4(0.2,0.48,0.8,0.13*rim);}` }));
  const limb=new THREE.Mesh(earth.geometry,limbMaterial);limb.scale.setScalar(1.014);earth.add(limb);
  // Only observer-ray directions are cached. These orbital depths/sizes are schematic.
  const orbitalDepth={earth:30,sun:60};
  // Orbital bodies keep the apparent angular diameters seen from the Moon; only their distances are schematic.
  const orbitalEarth=earth.clone(true);orbitalEarth.material=earthShader();
  orbitalEarth.scale.setScalar(orbitalDepth.earth*Math.tan(.95*RAD)/earth.geometry.parameters.radius);orbitalScene.add(orbitalEarth);
  const earthMapTarget={set map(value){earthMaterial.uniforms.map.value=orbitalEarth.material.uniforms.map.value=value;},get map(){return earthMaterial.uniforms.map.value;},needsUpdate:false};
  const orbitalSun=sun.clone(true);orbitalSun.scale.setScalar(orbitalDepth.sun*Math.tan(.265*RAD)/sunDisc.geometry.parameters.radius);orbitalScene.add(orbitalSun);
  const rayOrigin=new THREE.Vector3();
  const orbitalRays={};
  for(const [key,color]of [['sun',0xc6a463],['earth',0x6fbbd3]]){
    const geometry=track(new THREE.BufferGeometry());geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,0,0,0],3));
    const line=new THREE.Line(geometry,track(new THREE.LineBasicMaterial({color,transparent:true,opacity:.4})));orbitalRays[key]=line;orbitalScene.add(line);
  }
  const floorLight=new THREE.AmbientLight(0xd9d9d7,.18);surfaceScene.add(floorLight);
  // A separate, explicitly illustrative fill shades actual DEM normals without casting shadows.
  const displayFill=new THREE.DirectionalLight(0xdfe4ec,.3);
  displayFill.castShadow=false;surfaceScene.add(displayFill,displayFill.target);
  const sunlight=new THREE.DirectionalLight(0xfff4e2,2.3);
  sunlight.castShadow=false;
  surfaceScene.add(sunlight,sunlight.target);

  // Display-only tone for the projected skyline: faces turned toward the Sun bearing read brighter.
  const farHorizonMaterial=track(new THREE.ShaderMaterial({side:THREE.DoubleSide,toneMapped:false,
    uniforms:{sunAzimuth:{value:0},sunLevel:{value:0},baseTone:{value:.001}},
    vertexShader:`varying vec3 vCurtain;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main(){vCurtain=position;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;
    #include <logdepthbuf_vertex>
    }`,
    fragmentShader:`uniform float sunAzimuth;uniform float sunLevel;uniform float baseTone;varying vec3 vCurtain;
    #include <logdepthbuf_pars_fragment>
    void main(){
    #include <logdepthbuf_fragment>
    float azimuth=atan(vCurtain.x,-vCurtain.z);float facing=0.5-0.5*cos(azimuth-sunAzimuth);
    float tone=baseTone+sunLevel*(0.02+0.1*facing*facing);
    gl_FragColor=vec4(vec3(tone*1.02,tone,tone*0.97),1.0);
    #include <colorspace_fragment>
    }`}));
  // Lunar regolith scatters light back strongly and shows no limb darkening. A Lommel-Seeliger
  // term replaces the Lambert cosine; procedural grain is display texture, never relief data.
  let regolithShading='lambert';
  function regolithMaterial({fineTerrain=false}={}) {
    const material=new THREE.MeshStandardMaterial({color:0xa9a59d,roughness:1,metalness:0,side:THREE.FrontSide});
    const cosine='float dotNL = saturate( dot( geometryNormal, directLight.direction ) );';
    const chunk=THREE.ShaderChunk?.lights_physical_pars_fragment;
    if(!chunk?.includes(cosine))return material;
    regolithShading='lommel-seeliger';
    const grain=mobileQuality||fineTerrain?'0':'1';
    material.onBeforeCompile=shader=>{
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vRegolith;')
        .replace('#include <begin_vertex>','#include <begin_vertex>\nvRegolith=position;');
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
        varying vec3 vRegolith;
        float lnHash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
        float lnNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
          return mix(mix(lnHash(i),lnHash(i+vec2(1.0,0.0)),f.x),mix(lnHash(i+vec2(0.0,1.0)),lnHash(i+vec2(1.0,1.0)),f.x),f.y);}
        float lnGrain(vec2 p,float range){float near=1.0/(1.0+range*range*0.004),mid=1.0/(1.0+range*range*0.00002);
          return lnNoise(p*2.3)*0.35*near+lnNoise(p*0.47)*0.8*near+lnNoise(p*0.083)*0.75*mid+lnNoise(p*0.011)*0.25*mid;}`)
        .replace('#include <lights_physical_pars_fragment>',chunk.replace(cosine,`float lsIn = saturate( dot( geometryNormal, directLight.direction ) );
        float lsOut = saturate( dot( geometryNormal, geometryViewDir ) );
        float dotNL = smoothstep( 0.0, 0.035, lsIn ) * min( 1.0, 2.0 * lsIn / ( lsIn + lsOut + 0.05 ) );`))
        .replace('#include <color_fragment>',`#include <color_fragment>
        float lnRange=length(vRegolith.xz);
        ${fineTerrain?'':'diffuseColor.rgb*=0.93+0.04*lnNoise(vRegolith.xz*0.19)/(1.0+lnRange*0.02)+0.03*lnNoise(vRegolith.xz*0.0127);'}`)
        .replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
        #if ${grain}
        { float e=0.12+lnRange*0.004;vec2 q=vRegolith.xz;
          vec2 slope=vec2(lnGrain(q+vec2(e,0.0),lnRange)-lnGrain(q-vec2(e,0.0),lnRange),lnGrain(q+vec2(0.0,e),lnRange)-lnGrain(q-vec2(0.0,e),lnRange))*(0.004/e);
          normal=normalize(normal+mat3(viewMatrix)*vec3(-slope.x,0.0,-slope.y)); }
        #endif`);
    };
    material.customProgramCacheKey=()=>'lunaris-regolith-3-'+grain+'-'+fineTerrain;
    return material;
  }
  function photographedMaterial(photo,mask,bounds) {
    const uniforms={surfacePhoto:{value:photo},surfaceMask:{value:mask},surfacePhotoLevel:{value:0},surfacePhotoEnabled:{value:surfaceImageryEnabled?1:0},surfaceEdge:{value:new THREE.Vector2(40/(bounds[2]-bounds[0]),40/(bounds[3]-bounds[1]))}};
    const material=new THREE.MeshStandardMaterial({color:0xa9a59d,roughness:1,metalness:0,side:THREE.FrontSide});
    material.userData.surfaceUniforms=uniforms;
    material.onBeforeCompile=shader=>{
      Object.assign(shader.uniforms,uniforms);
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute vec2 surfaceUv;varying vec2 vSurfaceUv;')
        .replace('#include <begin_vertex>','#include <begin_vertex>\nvSurfaceUv=surfaceUv;');
      const chunk=THREE.ShaderChunk.lights_physical_pars_fragment,cosine='float dotNL = saturate( dot( geometryNormal, directLight.direction ) );';
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
        varying vec2 vSurfaceUv;uniform sampler2D surfacePhoto;uniform sampler2D surfaceMask;
        uniform float surfacePhotoLevel;uniform float surfacePhotoEnabled;uniform vec2 surfaceEdge;`)
        .replace('#include <lights_physical_pars_fragment>',chunk.replace(cosine,`float lsIn=saturate(dot(geometryNormal,directLight.direction));
          float lsOut=saturate(dot(geometryNormal,geometryViewDir));
          float dotNL=smoothstep(0.0,0.035,lsIn)*min(1.0,2.0*lsIn/(lsIn+lsOut+0.05));`))
        .replace('#include <opaque_fragment>',`vec2 edge=min(vSurfaceUv,vec2(1.0)-vSurfaceUv);
          float sourceWeight=smoothstep(0.0,surfaceEdge.x,edge.x)*smoothstep(0.0,surfaceEdge.y,edge.y);
          sourceWeight*=smoothstep(0.5,0.99,texture2D(surfaceMask,vSurfaceUv).r)*surfacePhotoEnabled;
          // The photo already contains historical illumination. Replace radiance;
          // multiplying by current Sun shading here would double-light it.
          outgoingLight=mix(outgoingLight,texture2D(surfacePhoto,vSurfaceUv).rgb*surfacePhotoLevel,sourceWeight);
          #include <opaque_fragment>`);
    };
    material.customProgramCacheKey=()=>`lunaris-registered-surface-1`;
    return material;
  }
  function updateSurfaceSource(){
    const active=mode==='surface'&&surfaceVisualEntry?.entry.site.id===site.id;
    surfaceSource.hidden=!active;
    if(active)surfaceSource.textContent=surfaceImageryEnabled&&surfaceVisualEntry.photo?'LROC imagery · historical lighting':surfaceDetailMesh?'NASA SfS display terrain · modeled lighting':'NASA LOLA terrain · modeled lighting';
    container.dataset.surfacePhoto=String(Boolean(active&&surfaceVisualEntry.photo&&surfaceImageryEnabled));
    container.dataset.surfaceDetail=String(Boolean(active&&surfaceDetailMesh));
    const signature=[site.id,mode,Boolean(active&&surfaceVisualEntry?.photo),surfaceImageryEnabled].join(':');
    if(signature!==surfaceSourceSignature){surfaceSourceSignature=signature;container.dispatchEvent(new CustomEvent('surfacevisualchange',{detail:{siteId:site.id,available:Boolean(active&&surfaceVisualEntry?.photo),enabled:surfaceImageryEnabled}}));}
  }
  function updateSurfaceMaterial(){
    const uniforms=surfaceVisualEntry?.material?.userData.surfaceUniforms;
    if(uniforms){uniforms.surfacePhotoLevel.value=surfacePhotoLevel(states.sun,Boolean(sample&&Number.isFinite(sample[1])&&Number.isFinite(sample[2])),enhancedNight);uniforms.surfacePhotoEnabled.value=surfaceImageryEnabled?1:0;}
    updateSurfaceSource();
  }
  function clearSurfaceAttachment(){
    if(surfaceDetailMesh)surfaceScene.remove(surfaceDetailMesh);
    surfaceDetailMesh=null;surfaceVisualEntry=null;surfaceVisualError=null;
    if(terrainMesh){terrainMesh.geometry.setDrawRange(0,Infinity);terrainMesh.material=terrainMesh.userData.originalMaterial??terrainMesh.material;}
    updateSurfaceSource();
  }
  async function verifiedSurfaceBytes(record,signal){
    const url=new URL(record.url??record.positionFile,surfaceVisualsUrl);
    if(url.origin!==surfaceVisualsUrl.origin||!url.pathname.startsWith(new URL('./',surfaceVisualsUrl).pathname))throw Error('Surface asset must remain in its offline directory.');
    const response=await fetch(url,{signal});if(!response.ok)throw Error(`Surface asset: HTTP ${response.status}`);
    const bytes=await response.arrayBuffer();
    if(bytes.byteLength!==record.byteLength)throw Error('Surface asset byte count differs.');
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    if(digest!==record.sha256)throw Error('Surface asset checksum differs.');
    return {bytes,url};
  }
  async function verifiedSurfaceTexture(record,signal,mask=false){
    const {bytes,url}=await verifiedSurfaceBytes(record,signal);
    const blobUrl=URL.createObjectURL(new Blob([bytes],{type:url.pathname.endsWith('.webp')?'image/webp':'image/png'}));
    try{
      const texture=await new THREE.TextureLoader().loadAsync(blobUrl);
      if(texture.image.width!==record.width||texture.image.height!==record.height){texture.dispose();throw Error('Surface image dimensions differ.');}
      texture.colorSpace=mask?THREE.NoColorSpace:THREE.SRGBColorSpace;
      texture.wrapS=texture.wrapT=THREE.ClampToEdgeWrapping;
      texture.anisotropy=Math.min(mobileQuality?2:8,renderer.capabilities.getMaxAnisotropy());
      return texture;
    }finally{URL.revokeObjectURL(blobUrl);}
  }
  function evictSurfaceAssets(){
    const limit=mobileQuality?1:2;
    while(surfaceVisualCache.size>limit){
      const [id,cached]=surfaceVisualCache.entries().next().value;
      if(id===site.id){surfaceVisualCache.delete(id);surfaceVisualCache.set(id,cached);continue;}
      surfaceVisualCache.delete(id);
      for(const resource of cached.resources){resource.dispose();resources.delete(resource);}
    }
  }
  async function loadSurfaceVisuals(requestedSite,metadata,request){
    surfaceVisualAbort?.abort();const controller=new AbortController();surfaceVisualAbort=controller;
    const ownResources=[];
    try{
      surfaceVisualsPromise??=fetch(surfaceVisualsUrl).then(response=>{if(!response.ok)throw Error(`Surface manifest: HTTP ${response.status}`);return response.json();});
      const manifest=await surfaceVisualsPromise;
      const entry=surfaceVisualRecord(manifest,requestedSite,{bundleFileSha256:metadata.bundleSha256,frame:bundle.manifest?.frame?.working});
      if(!entry||request!==terrainRequest||requestedSite.id!==site.id||disposed||lost)return;
      let cached=surfaceVisualCache.get(requestedSite.id);
      if(!cached){
        const tier=mobileQuality?'mobile':'desktop',record=entry.terrain?.[tier],imagery=entry.imagery;
        let detailMesh=null,photo=null,mask=null;
        if(imagery){
          photo=await verifiedSurfaceTexture(imagery.textures[tier],controller.signal);ownResources.push(photo);
          mask=await verifiedSurfaceTexture(imagery.masks[tier],controller.signal,true);ownResources.push(mask);
        }
        const material=photo?photographedMaterial(photo,mask,imagery.bounds):regolithMaterial({fineTerrain:true});ownResources.push(material);
        if(record){
          const {bytes}=await verifiedSurfaceBytes(record,controller.signal),view=terrainBufferViews(bytes,record);
          const geometry=new THREE.BufferGeometry();ownResources.push(geometry);
          geometry.setAttribute('position',new THREE.BufferAttribute(view.positions,3));geometry.setIndex(new THREE.BufferAttribute(view.indices,1));
          if(photo)geometry.setAttribute('surfaceUv',new THREE.BufferAttribute(surfaceUVs(requestedSite,view.positions,imagery.bounds),2));
          geometry.computeVertexNormals();geometry.computeBoundingSphere();detailMesh=new THREE.Mesh(geometry,material);
          detailMesh.name='NASA shape-from-shading display patch';
        }
        cached={entry,record,detailMesh,material,photo,mask,tier,resources:ownResources};
        ownResources.forEach(track);surfaceVisualCache.set(requestedSite.id,cached);
      }else{surfaceVisualCache.delete(requestedSite.id);surfaceVisualCache.set(requestedSite.id,cached);}
      if(controller.signal.aborted||request!==terrainRequest||requestedSite.id!==site.id||disposed||lost){evictSurfaceAssets();return;}
      clearSurfaceAttachment();surfaceVisualEntry=cached;surfaceDetailMesh=cached.detailMesh;
      if(surfaceDetailMesh){
        const outer=terrainRecord.chunks.find(chunk=>chunk.innerHalfExtentM===cached.record.outerHalfExtentM);
        if(!outer)throw Error('Surface detail has no matching original outer seam.');
        terrainMesh.geometry.setDrawRange(outer.indexOffset,outer.indexCount);surfaceScene.add(surfaceDetailMesh);
      }else if(cached.photo){
        const positions=terrainMesh.geometry.attributes.position.array;
        terrainMesh.geometry.setAttribute('surfaceUv',new THREE.BufferAttribute(surfaceUVs(requestedSite,positions,cached.entry.imagery.bounds),2));
        terrainMesh.material=cached.material;
      }
      updateSurfaceMaterial();evictSurfaceAssets();invalidate();
    }catch(error){
      for(const resource of ownResources)if(!resources.has(resource))resource.dispose();
      if(error.name==='AbortError'||request!==terrainRequest||requestedSite.id!==site.id||disposed)return;
      clearSurfaceAttachment();surfaceVisualError=error.message;container.dataset.surfaceDetail='false';container.dataset.surfacePhoto='false';invalidate();
    }
  }
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2(),projected=new THREE.Vector3();
  function invalidate(){needsRender=true;schedule();}
  function schedule(){if(!disposed&&!lost&&!raf&&(intersecting||flight)&&!document.hidden)raf=requestAnimationFrame(draw);}
  function setSurfaceLook() {
    surfaceCamera.position.set(0,Number.isFinite(site.heightM)?site.heightM:2,0);
    const direction=bodyDirection(yaw/RAD,pitch/RAD);
    surfaceCamera.lookAt(surfaceCamera.position.clone().add(new THREE.Vector3(...direction)));
    surfaceCamera.fov=surfaceFov;surfaceCamera.updateProjectionMatrix();
  }
  function terrainPitch(){
    const row=site.terrain?.skyline?.find(r=>Math.abs(r[0]-terrainBearingDeg)<1e-7);
    return Math.max(-5,Math.min(25,(Number.isFinite(row?.[3])?row[3]:0)-14))*RAD;
  }
  function updateFarHorizon() {
    if(farHorizonSiteId===site.id)return;
    if(farHorizonMesh)surfaceScene.remove(farHorizonMesh);
    let cached=farHorizonCache.get(site.id);
    if(!cached) {
      const model=farHorizonData(site);let mesh=null;
      if(model.sectorCount) {
        const geometry=track(new THREE.BufferGeometry());
        geometry.setAttribute('position',new THREE.BufferAttribute(model.positions,3));
        geometry.setIndex(new THREE.BufferAttribute(model.indices,1));geometry.computeBoundingSphere();
        const material=farHorizonMaterial;
        mesh=new THREE.Mesh(geometry,material);mesh.name='Display-only projected retained skyline';
        mesh.castShadow=mesh.receiveShadow=false;
      }
      cached={mesh,model};farHorizonCache.set(site.id,cached);
    }
    farHorizonMesh=cached.mesh;farHorizonRecord=cached.model;farHorizonSiteId=site.id;
    if(farHorizonMesh)surfaceScene.add(farHorizonMesh);
    container.dataset.farHorizonSectors=String(farHorizonRecord.sectorCount);
    container.dataset.farHorizonSkippedSectors=String(farHorizonRecord.skippedSectors);
  }
  function viewInfo(direction) {
    if(!direction||mode!=='surface')return bodyFraming(null,surfaceCamera.fov,surfaceCamera.aspect);
    surfaceCamera.updateMatrixWorld(true);
    const rotation=surfaceCamera.getWorldQuaternion(new THREE.Quaternion()).invert();
    const local=new THREE.Vector3(...direction).applyQuaternion(rotation).toArray();
    return bodyFraming(local,surfaceCamera.fov,surfaceCamera.aspect);
  }
  function orbitalFraming(object){
    orbitalCamera.updateMatrixWorld(true);
    const direction=object.position.clone().sub(orbitalCamera.position).normalize();
    direction.applyQuaternion(orbitalCamera.getWorldQuaternion(new THREE.Quaternion()).invert());
    return bodyFraming(direction.toArray(),orbitalCamera.fov,orbitalCamera.aspect);
  }
  function captionUpdate() {
    const visibility=renderedBodies(sample,states);
    const framed=Object.fromEntries([['sun',1,2,orbitalSun],['earth',4,5,orbitalEarth]].map(([key,az,el,object])=>[key,(mode==='orbital'?orbitalFraming(object):viewInfo(bodyDirection(sample?.[az],sample?.[el]))).inFrustum]));
    const signature=[site.id,contextSite?.id,mode,orbitalFocus,states.sun,states.earth,visibility.sun,visibility.earth,framed.sun,framed.earth,earthTextureLoaded].join('|');
    if(signature===captionSignature)return;captionSignature=signature;
    setLocation(`${mode==='orbital'&&['earth','sun'].includes(orbitalFocus)?`${orbitalFocus==='earth'?'Earth':'Sun'} direction from `:''}${site.name}`,`${Math.abs(site.lat).toFixed(4)}° S · ${((site.lon%360+360)%360).toFixed(4)}° E`);
    note.textContent=mode==='orbital'?'Sun and Earth sit in their computed directions at fixed approximate angular sizes (0.53° and 1.9°). Distances are schematic.'
      :`NASA LOLA mesh + projected nominal skyline · ${site.heightM} m observer · Illustrative grain and lighting; Earth phase from the cached Sun direction`;
    bodyStatus.replaceChildren();
    for(const key of ['sun','earth']) {
      const label=document.createElement('span');label.dataset.body=key;label.dataset.state=states[key]||'unknown';
      const name=key==='sun'?'Sun center':'Earth center',state=states[key];
      label.textContent=mode==='orbital'
        ?`${name}: ${state==='visible'?'in view from this site':state==='blocked'?'hidden by terrain at this site':state==='uncertain'?'visibility unresolved at this site':'no verified geometry'}`
        :`${name}: ${visibility[key]?(key==='earth'&&!earthTextureLoaded?'visible · image loading/unavailable':framed[key]?'visible':'visible · outside view'):state==='blocked'?(key==='sun'?'hidden by terrain':'terrain-blocked'):state==='uncertain'?'unresolved · not drawn':'no verified geometry'}`;
      bodyStatus.append(label);
    }
    if(mode==='orbital'&&contextSite){
      setLocation(contextSite.name,`${Math.abs(contextSite.lat).toFixed(4)}° ${contextSite.lat<0?'S':'N'} · ${((contextSite.lon%360+360)%360).toFixed(4)}° E`);
      note.textContent='Context location: level-horizon geometry only. Local ridges and terrain-aware feasibility are not calculated here.';
    }
    bodyStatus.hidden=mode==='orbital'&&Boolean(contextSite);
  }
  function updateObstruction() {
    const earthDirection=bodyDirection(sample?.[4],sample?.[5]),earthFraming=viewInfo(earthDirection);
    obstruction.hidden=mode!=='surface'||states.earth!=='blocked'||!earthDirection||!earthFraming.inFrustum;
    if(!obstruction.hidden){
      obstruction.style.left=`${clamp(earthFraming.projectedPosition[0]*100,18,82)}%`;
      obstruction.style.top=`${clamp(earthFraming.projectedPosition[1]*100,30,72)}%`;
      obstruction.title=`Earth-center direction: bearing ${sample[4].toFixed(1)} degrees, elevation ${sample[5].toFixed(1)} degrees. The calculated horizon blocks its center; no Earth body is drawn.`;
    }
  }
  function updateFrame() {
    const show=renderedBodies(sample,states);
    sun.visible=!lost&&!disposed&&mode==='surface'&&show.sun;
    earth.visible=!lost&&!disposed&&mode==='surface'&&show.earth&&earthTextureLoaded;
    const cachedTime=Number.isFinite(sample?.[0])&&sample[0]>=bundle.coverage[0]&&sample[0]<bundle.coverage[1];
    orbitalSun.visible=!contextSite&&!lost&&!disposed&&mode==='orbital'&&cachedTime&&Boolean(bodyDirection(sample?.[1],sample?.[2]));
    orbitalEarth.visible=!contextSite&&!lost&&!disposed&&mode==='orbital'&&cachedTime&&Boolean(bodyDirection(sample?.[4],sample?.[5]))&&earthTextureLoaded;
    rayOrigin.fromArray(moonPoint(site.lat,site.lon,1+((site.groundM??0)+(site.heightM??2))/1737400)??[0,0,0]);
    container.dataset.sunRendered=String(sun.visible);container.dataset.earthRendered=String(earth.visible);
    for(const [key,object,az,el] of [['sun',sun,1,2],['earth',earth,4,5]]) {
      const direction=bodyDirection(sample?.[az],sample?.[el]);
      if(direction)object.position.copy(surfaceCamera.position).addScaledVector(new THREE.Vector3(...direction),skyDistance);
      const world=localToMoonDirection(site,direction),orbitalObject=key==='sun'?orbitalSun:orbitalEarth;
      if(world)orbitalObject.position.copy(rayOrigin).addScaledVector(new THREE.Vector3(...world),orbitalDepth[key]);
      else orbitalObject.visible=false;
      const ray=orbitalRays[key];ray.visible=orbitalObject.visible;ray.material.opacity=states[key]==='visible'?.62:.2;
      const vertices=ray.geometry.attributes.position;vertices.setXYZ(0,...rayOrigin.toArray());vertices.setXYZ(1,...orbitalObject.position.toArray());vertices.needsUpdate=true;ray.geometry.computeBoundingSphere();
      container.dataset[`${key}Direction`]=direction?direction.map(v=>v.toFixed(8)).join(','):'';
      container.dataset[`${key}Azimuth`]=Number.isFinite(sample?.[az])?String(sample[az]):'';
      container.dataset[`${key}Elevation`]=Number.isFinite(sample?.[el])?String(sample[el]):'';
      const framing=viewInfo(direction);
      container.dataset[`${key}InFrustum`]=String(framing.inFrustum);
      container.dataset[`${key}ProjectedBearing`]=framing.projectedBearingDeg===null?'':String(framing.projectedBearingDeg);
    }
    const sunDirection=bodyDirection(sample?.[1],sample?.[2]);
    const worldSun=localToMoonDirection(site,sunDirection);
    globeLight.intensity=worldSun&&cachedTime?2.9:0;
    if(sunDirection)earthMaterial.uniforms.sunDirection.value.fromArray(sunDirection);
    if(worldSun)orbitalEarth.material.uniforms.sunDirection.value.fromArray(worldSun);
    earthMaterial.uniforms.phaseLit.value=sunDirection?1:0;orbitalEarth.material.uniforms.phaseLit.value=worldSun?1:0;
    if(Number.isFinite(sample?.[1]))farHorizonMaterial.uniforms.sunAzimuth.value=sample[1]*RAD;
    const illumination=surfaceLightState(states.sun,!lost&&!disposed&&Boolean(sunDirection),enhancedNight);
    floorLight.intensity=illumination.ambient;displayFill.intensity=illumination.fill;
    farHorizonMaterial.uniforms.sunLevel.value=illumination.skylineLevel;
    farHorizonMaterial.uniforms.baseTone.value=illumination.skylineFloor;
    if(worldSun)globeLight.position.fromArray(worldSun).multiplyScalar(10);
    sunlight.intensity=illumination.direct;
    container.dataset.enhancedNight=String(enhancedNight);
    if(sunDirection)sunlight.position.fromArray(sunDirection).multiplyScalar(700);
    sunlight.target.position.set(0,0,0);
    displayFill.position.fromArray(bodyDirection(terrainBearingDeg-55,35)).multiplyScalar(700);
    displayFill.target.position.set(0,0,0);
    captionUpdate();updateObstruction();invalidate();
    updateSurfaceMaterial();
  }
  function updateMarkers() {
    for(const marker of markers) {
      const active=marker.kind==='context'?marker.site.id===contextSite?.id:!contextSite&&marker.site.id===site.id;
      marker.material.color.set(marker.kind==='context'?(active?0xc6f3ff:0x8edbea):active?0xeebf74:0xb9c9dd);
      marker.group.scale.setScalar(active?1.3:.8);marker.button?.setAttribute('aria-pressed',String(active));
      if(marker.pin)marker.pin.dataset.selected=String(active);marker.choice?.setAttribute('aria-pressed',String(active));
    }
    markerLabel.dataset.kind=contextSite?'context':'terrain';
    markerLabel.textContent=contextSite?`${contextSite.name} · level horizon only`:site.name;
    container.dataset.contextSite=contextSite?.id??'';
  }
  function markerView(marker){
    const projected=marker.group.position.clone().project(orbitalCamera);
    const facing=marker.group.position.dot(orbitalCamera.position.clone().sub(marker.group.position))>0;
    return {facing,visible:mode==='orbital'&&!lost&&!disposed&&facing&&Math.abs(projected.x)<=1&&Math.abs(projected.y)<=1&&projected.z<=1,
      projectedPosition:[projected.x*.5+.5,-projected.y*.5+.5]};
  }
  function updateTerrainPins(){
    const terrain=markers.filter(marker=>marker.kind==='terrain'),views=terrain.map(marker=>({id:marker.site.id,...markerView(marker)}));
    const layout=terrainMarkerLayout(views,container.clientWidth,container.clientHeight);
    for(const marker of terrain){
      const view=views.find(item=>item.id===marker.site.id);
      marker.pin.hidden=!view.visible;marker.button.hidden=!view.visible||layout.grouped;
      for(const node of [marker.pin,marker.button]){node.style.left=`${view.projectedPosition[0]*100}%`;node.style.top=`${view.projectedPosition[1]*100}%`;}
      marker.choice.hidden=!view.visible;
    }
    terrainCluster.hidden=terrainLeader.hidden=!layout.grouped;
    if(layout.grouped){
      terrainClusterSummary.textContent=`${layout.ids.length} study points`;
      const width=container.clientWidth,height=container.clientHeight,x=layout.anchor[0]*width,y=layout.anchor[1]*height;
      // The pin stays at its true projection. Only the label moves clear of
      // the mobile camera row, with a leader back to the exact geographic anchor.
      const labelY=width<=740?Math.min(y,height-92):y;
      const labelRight=clamp(x-18,terrainClusterSummary.offsetWidth+8,width-8);
      // Size the transient chooser to the visible part of the scene, including
      // ordinary page scrolling. Dataset growth must not push choices offscreen.
      const rect=container.getBoundingClientRect(),halfSummary=terrainClusterSummary.offsetHeight/2;
      const visibleTop=Math.max(0,-rect.top),visibleBottom=Math.min(height,window.innerHeight-rect.top);
      const spaceAbove=labelY-halfSummary-16-visibleTop,spaceBelow=visibleBottom-labelY-halfSummary-16;
      const above=spaceAbove>=spaceBelow;
      terrainCluster.style.left=`${labelRight}px`;terrainCluster.style.top=`${labelY}px`;
      terrainLeader.style.left=`${labelRight}px`;terrainLeader.style.top=`${labelY}px`;
      terrainLeader.style.width=`${Math.hypot(x-labelRight,y-labelY)}px`;
      terrainLeader.style.transform=`rotate(${Math.atan2(y-labelY,x-labelRight)}rad)`;
      terrainCluster.style.setProperty('--terrain-menu-height',`${Math.max(0,Math.min(320,above?spaceAbove:spaceBelow))}px`);
      terrainCluster.dataset.placement=above?'above':'below';
    }else terrainCluster.open=false;
    return layout;
  }
  function draw(now,force=false) {
    raf=0;if(disposed||lost||(!force&&(document.hidden||(!intersecting&&!flight))))return;
    if(flight) {
      const t=clamp((now-flight.start)/flight.duration,0,1),eased=t*t*(3-2*t);
      if(flight.rotation) {
        const rotation=new THREE.Quaternion().slerp(flight.rotation,eased);
        orbitalCamera.position.copy(flight.fromDirection).applyQuaternion(rotation)
          .multiplyScalar(flight.fromRadius+(flight.toRadius-flight.fromRadius)*eased);
      } else orbitalCamera.position.lerpVectors(flight.from,flight.to,eased);
      orbitalCamera.lookAt(0,0,0);
      if(t===1){const complete=flight.onComplete;flight=null;complete?.();}
      needsRender=true;
    }
    const controlsMoving=mode==='orbital'&&controls.update();
    if(mode==='orbital'&&controlsMoving)captionUpdate();
    updateObstruction();
    if(needsRender||flight) {
      renderer.toneMappingExposure=mode==='orbital'?1.15:1.3;
      renderer.render(mode==='orbital'?orbitalScene:surfaceScene,mode==='orbital'?orbitalCamera:surfaceCamera);
      needsRender=false;
      if(mode==='orbital') {
        const marker=markers.find(item=>item.site.id===(contextSite?.id??site.id));
        projected.copy(marker.group.position).project(orbitalCamera);
        const facing=marker.group.position.dot(orbitalCamera.position.clone().sub(marker.group.position))>0;
        markerLabel.hidden=!facing||Math.abs(projected.x)>1||Math.abs(projected.y)>1||projected.z>1;
        markerLabel.style.left=`${(projected.x*.5+.5)*100}%`;markerLabel.style.top=`${(-projected.y*.5+.5)*100}%`;
        for(const marker of markers.filter(item=>item.kind==='context'&&item.button)){
          const view=markerView(marker);marker.button.hidden=!view.visible;
          marker.button.style.left=`${view.projectedPosition[0]*100}%`;marker.button.style.top=`${view.projectedPosition[1]*100}%`;
        }
        const terrainLayout=updateTerrainPins();
        if(!contextSite&&terrainLayout.grouped)markerLabel.hidden=true;
        markerLegend.hidden=false;
        for(const [key,object] of [['earth',orbitalEarth],['sun',orbitalSun]]) {
          const label=bodyLabels[key],toBody=object.position.clone().sub(orbitalCamera.position),range=toBody.length();
          toBody.divideScalar(range);
          const along=-orbitalCamera.position.dot(toBody),miss=orbitalCamera.position.clone().addScaledVector(toBody,along).length();
          projected.copy(object.position).project(orbitalCamera);
          label.hidden=!object.visible||projected.z>1||Math.abs(projected.x)>1||Math.abs(projected.y)>1||(along>0&&along<range&&miss<1);
          label.style.left=`${(projected.x*.5+.5)*100}%`;label.style.top=`${(-projected.y*.5+.5)*100}%`;
        }
      } else {markerLabel.hidden=true;bodyLabels.earth.hidden=bodyLabels.sun.hidden=true;markerLegend.hidden=true;terrainCluster.hidden=terrainLeader.hidden=true;terrainCluster.open=false;for(const marker of markers){if(marker.button)marker.button.hidden=true;if(marker.pin)marker.pin.hidden=true;}}
    }
    if(flight||controlsMoving&&controls.enableDamping)schedule();
  }
  const loader=new THREE.TextureLoader();
  async function texture(name,material,key,debugKey,detail=null) {
    try {
      const map=await loader.loadAsync(asset(name));
      if(disposed||lost){map.dispose();return false;}
      track(map);if(key!=='bumpMap')map.colorSpace=THREE.SRGBColorSpace;
      map.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
      const previous=material[key];material[key]=map;material.needsUpdate=true;
      if(debugKey==='moon'){
        moonTextureLoaded=true;moonDetail=detail??moonDetail;container.dataset.moonTextureLoaded='true';container.dataset.moonDetail=moonDetail;
        if(previous&&previous!==map){previous.dispose();resources.delete(previous);}
      }
      if(debugKey==='earth'){earthTextureLoaded=true;container.dataset.earthTextureLoaded='true';updateFrame();}
      if(debugKey==='bump'){moonBumpLoaded=true;moonMaterial.bumpScale=.003;}
      invalidate();
      return true;
    } catch(error) {
      if(!disposed&&debugKey!=='bump')report('warning',`${debugKey==='moon'?'Moon':'Earth'} image is unavailable; the image layer cannot be shown.`);
      return false;
    }
  }
  const moonTexturePromise=texture('moon-preview.jpg',moonMaterial,'map','moon','preview');
  void texture('moon-bump.jpg',moonMaterial,'bumpMap','bump');
  let earthTexturePromise;
  async function loadHighDetail() {
    if(disposed||lost)return false;
    if(moonDetail==='high')return true;
    if(!moonHighDetailPromise) {
      report('loading','Loading the original 4K NASA LROC Moon texture.');
      moonHighDetailPromise=texture('moon-color.jpg',moonMaterial,'map','moon','high').then(ok=>{
        if(ok)report('ready','');
        else moonHighDetailPromise=null;
        return ok;
      });
    }
    return moonHighDetailPromise;
  }

  async function loadTerrain() {
    const request=++terrainRequest,requestedSite=site;
    if(terrainSiteId===site.id&&terrainMesh){
      container.dataset.terrainStatus='ready';
      if(!surfaceVisualEntry){const metadata=await terrainMetadataPromise;if(request===terrainRequest)void loadSurfaceVisuals(requestedSite,metadata,request);}
      return;
    }
    surfaceVisualAbort?.abort();clearSurfaceAttachment();
    if(terrainMesh)surfaceScene.remove(terrainMesh);
    terrainMesh=null;terrainSiteId=null;terrainRecord=null;terrainError=null;
    container.dataset.terrainStatus='loading';report('loading','Loading the NASA LOLA surface mesh.');
    invalidate();
    try {
      terrainMetadataPromise??=fetch(terrainUrl).then(response=>{if(!response.ok)throw new Error(`Terrain metadata: HTTP ${response.status}`);return response.json();});
      const metadata=await terrainMetadataPromise;
      if(disposed||lost)return;
      const record=metadata.sites.find(item=>item.siteId===requestedSite.id);
      if(!record)throw new Error('No display terrain is cached for this study point.');
      let cached=terrainCache.get(requestedSite.id);
      if(!cached) {
        const response=await fetch(new URL(record.positionFile,terrainUrl));
        if(!response.ok)throw new Error(`Terrain mesh: HTTP ${response.status}`);
        const buffer=await response.arrayBuffer();
        if(disposed||lost)return;
        const {positions,indices}=terrainBufferViews(buffer,record);
        const geometry=track(new THREE.BufferGeometry());
        geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
        geometry.setIndex(new THREE.BufferAttribute(indices,1));geometry.computeVertexNormals();geometry.computeBoundingSphere();
        const material=track(regolithMaterial());
        cached={mesh:new THREE.Mesh(geometry,material),record};
        cached.mesh.userData.originalMaterial=material;
        terrainCache.set(requestedSite.id,cached);
      }
      if(disposed||request!==terrainRequest)return;
      terrainMesh=cached.mesh;terrainRecord=record;terrainSiteId=requestedSite.id;surfaceScene.add(terrainMesh);
      container.dataset.terrainStatus='ready';container.dataset.terrainVertices=String(record.vertexCount);container.dataset.terrainIndices=String(record.indexCount);
      report('ready','');
      void loadSurfaceVisuals(requestedSite,metadata,request);
      invalidate();
    } catch(error) {
      if(disposed||request!==terrainRequest)return;
      terrainError=error.message;container.dataset.terrainStatus='unavailable';
      report('warning',`Surface terrain unavailable: ${error.message} No substitute terrain is shown.`);invalidate();
    }
  }
  function focusSite(duration=900,onComplete=null,point=site) {
    if(!onComplete&&pendingMode==='surface')onComplete=()=>{if(pendingMode==='surface'&&!disposed)commitMode('surface');};
    const selected=new THREE.Vector3(...moonPoint(point.lat,point.lon));
    orbitalFocus='site';applyOrbitalFraming();controls.target.set(0,0,0);controls.minDistance=1.06;
    const to=selected.clone().multiplyScalar(onComplete?1.25:orbitalOverviewDistance(container.clientWidth,container.clientHeight));
    if(reducedMotion){orbitalCamera.position.copy(to);orbitalCamera.lookAt(0,0,0);onComplete?.();}
    else{const from=orbitalCamera.position.clone();flight={from,to,start:performance.now(),duration,onComplete,fromDirection:from.clone().normalize(),fromRadius:from.length(),toRadius:to.length(),rotation:new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(),to.clone().normalize())};}
    invalidate();
  }
  function selectSite(siteId,{focus:shouldFocus=true}={}) {
    const next=bundle.sites.find(point=>point.id===siteId);if(!next)return false;
    contextSite=null;
    const changed=site.id!==next.id;site=next;terrainBearingDeg=terrainFocusBearing(site);container.dataset.site=site.id;
    if(changed){surfaceVisualAbort?.abort();clearSurfaceAttachment();sample=null;states={};container.dataset.frame='';}
    if(changed&&mode==='surface'){yaw=terrainBearingDeg*RAD;pitch=terrainPitch();surfaceFov=65;surfaceFocus='terrain';updateFarHorizon();}
    updateMarkers();setSurfaceLook();updateFrame();
    if(mode==='surface'&&changed)void loadTerrain();
    if(mode==='orbital'&&shouldFocus)focusSite(pendingMode==='surface'?520:900,pendingMode==='surface'?()=>commitMode('surface'):null);return true;
  }
  function selectContextSite(siteId,{focus:shouldFocus=true}={}){
    if(siteId===null){
      if(lost||disposed)return false;
      contextSite=null;updateMarkers();updateFrame();captionUpdate();invalidate();return true;
    }
    const point=NOTABLE_SITES.find(item=>item.id===siteId);if(!point||lost||disposed)return false;
    if(mode!=='orbital'||pendingMode)setMode('orbital');
    contextSite=point;updateMarkers();updateFrame();
    if(shouldFocus){focusSite(900,null,point);orbitalFocus='context';applyOrbitalFraming();}
    captionUpdate();invalidate();return true;
  }
  function commitMode(next) {
    ++modeTransition;clearTimeout(transitionTimer);transitionTimer=0;
    pendingMode=null;
    mode=next;flight=null;controls.enabled=mode==='orbital';container.dataset.mode=mode;
    if(!reducedMotion&&typeof canvas.animate==='function')canvas.animate([{opacity:.15},{opacity:1}],{duration:420,easing:'ease-out'});
    canvas.setAttribute('aria-label',mode==='orbital'?'Interactive Moon. Drag or use arrow keys to rotate; scroll, pinch, plus and minus zoom. Scroll outside the scene to move the page.'
      :'Lunar surface at the recorded observer height. Drag or use arrow keys to look around; scroll, pinch, plus and minus change field of view. Scroll outside the scene to move the page.');
    if(mode==='surface') {
      contextSite=null;updateMarkers();
      yaw=terrainBearingDeg*RAD;pitch=terrainPitch();surfaceFov=65;surfaceFocus='terrain';
      setSurfaceLook();updateFarHorizon();void loadTerrain();earthTexturePromise??=texture('earth-color.jpg',earthMapTarget,'map','earth');
      if(pendingFocus){const target=pendingFocus;pendingFocus=null;focusBody(target);}
    }
    updateFrame();onModeChange(mode);resize();return true;
  }
  function setMode(next) {
    if(!['orbital','surface'].includes(next)||disposed)return false;
    if(next==='orbital'){++modeTransition;clearTimeout(transitionTimer);transitionTimer=0;pendingMode=null;pendingFocus=null;flight=null;controls.enabled=true;if(mode===next){invalidate();return true;}return commitMode(next);}
    if(next===mode||pendingMode===next)return true;
    if(!reducedMotion) {
      pendingMode='surface';controls.enabled=false;
      report('loading','Approaching the selected south-pole study point.');
      const intent=++modeTransition;
      const finish=()=>{if(intent===modeTransition&&pendingMode==='surface'&&!disposed&&!lost)commitMode('surface');};
      focusSite(520,finish);
      // The presentation tween must not be the only completion path: RAF is
      // deliberately paused when the scene leaves the viewport or tab hides.
      // Commit the requested camera mode even if no animation frames can run.
      clearTimeout(transitionTimer);transitionTimer=setTimeout(finish,680);return true;
    }
    return commitMode(next);
  }
  function setFrame(frame) {
    if(!frame||disposed)return;
    if(frame.site&&frame.site.id!==site.id)selectSite(frame.site.id);
    sample=frame.sample??null;states=frame.states??{};
    container.dataset.frame=Number.isFinite(sample?.[0])?String(sample[0]):'';
    updateFrame();
  }
  function focusBody(target) {
    const [az,el]=target==='earth'?[4,5]:[1,2];
    if(!bodyDirection(sample?.[az],sample?.[el])){report('warning',`No verified ${target} geometry exists at this frame.`);return;}
    yaw=sample[az]*RAD;pitch=sample[el]*RAD;surfaceFov=target==='earth'?10:8;surfaceFocus=target;
    setSurfaceLook();updateFrame();
  }
  function focus(target) {
    if(target==='overview') {
      setMode('orbital');
      orbitalFocus='Moon';applyOrbitalFraming();controls.target.set(0,0,0);controls.minDistance=1.06;
      const from=orbitalCamera.position.clone(),to=new THREE.Vector3(...orbitalOverviewPosition(container.clientWidth,container.clientHeight));
      // Clear orbit inertia before restoring the overview, without a visible jump.
      const damping=controls.enableDamping;controls.enableDamping=false;controls.update();controls.enableDamping=damping;
      orbitalCamera.position.copy(from);orbitalCamera.lookAt(0,0,0);
      if(reducedMotion){orbitalCamera.position.copy(to);orbitalCamera.lookAt(0,0,0);}
      else flight={from,to,start:performance.now(),duration:700,fromDirection:from.clone().normalize(),
        fromRadius:from.length(),toRadius:to.length(),rotation:new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(),to.clone().normalize())};
      captionUpdate();invalidate();return;
    }
    if(target==='site') {
      contextSite=null;updateMarkers();updateFrame();
      pendingFocus=null;
      if(mode==='orbital')focusSite();else {yaw=terrainBearingDeg*RAD;surfaceFov=65;pitch=terrainPitch();surfaceFocus='terrain';setSurfaceLook();updateFrame();}return;
    }
    if(!['earth','sun'].includes(target))return;
    if(contextSite){report('warning','This context marker has level-horizon angles in the other-locations explorer. Choose a terrain study point to use the Sun/Earth scene cameras.');return;}
    // A body focus requested during the descent applies once the surface view is committed.
    if(pendingMode==='surface'){pendingFocus=target;return;}
    if(mode==='orbital'){
      const object=target==='earth'?orbitalEarth:orbitalSun;
      if(!Number.isFinite(sample?.[0])){report('warning','No cached body direction exists at this time.');return;}
      if(!object.visible){report('warning',`No ${target==='earth'?'Earth':'Sun'} direction can be drawn at this time.`);return;}
      const body=object.position.clone().normalize(),pole=new THREE.Vector3(...moonPoint(site.lat,site.lon)).normalize();
      const side=pole.addScaledVector(body,-pole.dot(body));
      if(side.lengthSq()<1e-6)side.set(0,-1,0).addScaledVector(body,body.y);
      side.normalize();
      const offset=16*RAD,radius=Math.max(5.2,orbitalOverviewDistance(container.clientWidth,container.clientHeight)*1.3);
      const to=body.multiplyScalar(-Math.cos(offset)).addScaledVector(side,Math.sin(offset)).multiplyScalar(radius);
      orbitalFocus=target;applyOrbitalFraming();controls.target.set(0,0,0);controls.minDistance=1.06;
      const from=orbitalCamera.position.clone();
      if(reducedMotion){flight=null;orbitalCamera.position.copy(to);orbitalCamera.lookAt(0,0,0);controls.update();}
      else flight={from,to,start:performance.now(),duration:900,fromDirection:from.clone().normalize(),fromRadius:from.length(),toRadius:to.length(),
        rotation:new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(),to.clone().normalize())};
      captionUpdate();invalidate();return;
    }
    focusBody(target);
  }
  function applyOrbitalFraming(width=Math.max(1,container.clientWidth),height=Math.max(1,container.clientHeight)) {
    // Earth and Sun focus keep the plain projection so the body stays framed beside the limb.
    const cinematic=width>=640&&!['earth','sun'].includes(orbitalFocus);
    orbitalCamera.zoom=cinematic?ORBITAL_CINEMATIC_ZOOM:1;
    if(cinematic)orbitalCamera.setViewOffset(width,height,-Math.round(width*.18),Math.round(height*ORBITAL_CINEMATIC_LIFT),width,height);else orbitalCamera.clearViewOffset();
    orbitalCamera.updateProjectionMatrix();needsRender=true;
  }
  function resize() {
    if(disposed)return;
    const width=Math.max(1,container.clientWidth),height=Math.max(1,container.clientHeight);
    const previous=renderer.getSize(new THREE.Vector2());
    if(previous.x!==width||previous.y!==height)renderer.setSize(width,height,false);
    if(!flight&&orbitalFocus==='Moon')orbitalCamera.position.setLength(orbitalOverviewDistance(width,height));
    applyOrbitalFraming(width,height);
    for(const camera of [orbitalCamera,surfaceCamera]){camera.aspect=width/height;camera.updateProjectionMatrix();}
    // Resizing clears the WebGL drawing buffer. Paint it immediately even if
    // an IntersectionObserver entry from the previous viewport is still stale.
    // Continuous rendering remains paused offscreen; this is one explicit paint.
    if(raf){cancelAnimationFrame(raf);raf=0;}
    needsRender=true;draw(performance.now(),true);
  }
  function zoom(direction) {
    if(disposed||lost||![-1,1].includes(direction))return;
    if(pendingMode==='surface')commitMode('surface');
    flight=null;
    if(mode==='surface') {
      surfaceFov=clamp(surfaceFov-direction*3,8,85);setSurfaceLook();updateFrame();
    } else {
      const offset=orbitalCamera.position.clone().sub(controls.target);
      offset.setLength(clamp(offset.length()*(direction>0?.9:1.1),controls.minDistance,controls.maxDistance));
      orbitalCamera.position.copy(offset).add(controls.target);controls.update();invalidate();
    }
  }
  function inspect() {
    const bodyInfo=(object,key,az,el)=>{
      const direction=bodyDirection(sample?.[az],sample?.[el]),framing=viewInfo(direction);
      return {visible:object.visible,position:object.position.toArray(),direction,azimuth:sample?.[az]??null,elevation:sample?.[el]??null,state:states[key]??'unknown',
        ...framing,renderedInFrustum:object.visible&&framing.inFrustum};
    };
    const orbitalBody=(object,key,az,el)=>({visible:object.visible,position:object.position.toArray(),direction:localToMoonDirection(site,bodyDirection(sample?.[az],sample?.[el])),state:states[key]??'unknown',...orbitalFraming(object),...(key==='earth'?{textured:earthTextureLoaded,limbIllustrative:true}:{photosphereIllustrative:true})});
    const gl=renderer.getContext(),gpuExtension=gl.getExtension('WEBGL_debug_renderer_info');
    return {mode,siteId:site.id,time:sample?.[0]??null,webgl:disposed?'disposed':lost?'lost':'ready',
      contextSiteId:contextSite?.id??null,
      terrainMarkers:markers.filter(marker=>marker.kind==='terrain').map(marker=>({id:marker.site.id,lat:marker.site.lat,lon:marker.site.lon,
        selected:marker.site.id===site.id&&!contextSite,terrainAware:true,position:marker.group.position.toArray(),
        pinVisible:!marker.pin.hidden,selectionTargetVisible:!marker.button.hidden,...markerView(marker)})),
      terrainCluster:{...terrainMarkerLayout(markers.filter(marker=>marker.kind==='terrain').map(marker=>({id:marker.site.id,...markerView(marker)})),container.clientWidth,container.clientHeight),visible:!terrainCluster.hidden,open:terrainCluster.open},
      contextMarkers:markers.filter(marker=>marker.kind==='context').map(marker=>({id:marker.site.id,lat:marker.site.lat,lon:marker.site.lon,group:marker.site.group,
        selected:marker.site.id===contextSite?.id,terrainAware:false,position:marker.group.position.toArray(),...markerView(marker)})),
      graphics:{renderer:gpuExtension?gl.getParameter(gpuExtension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),quality:mobileQuality?'mobile-2K':'desktop-auto-4K'},
      orbital:{earth:orbitalBody(orbitalEarth,'earth',4,5),sun:orbitalBody(orbitalSun,'sun',1,2),rayOrigin:rayOrigin.toArray(),displayDepthMoonRadii:orbitalDepth,apparentDiameterDeg:{earth:1.9,sun:.53},
        disclosure:'Apparent observer-ray directions transformed from the selected site ENU frame. Bodies keep their apparent angular diameters from the Moon at schematic distances; no planetary ranges are cached. They are drawn whenever a cached direction exists; visibility from the study point is reported separately.'},
      moon:{textured:moonTextureLoaded,detail:moonDetail,bump:moonBumpLoaded,vertices:moon.geometry.attributes.position.count,projectedCenter:new THREE.Vector3().project(orbitalCamera).toArray()},
      terrain:{siteId:terrainSiteId,loaded:Boolean(terrainMesh),vertexCount:terrainMesh?.geometry.attributes.position.count??0,indexCount:terrainMesh?.geometry.index.count??0,sha256:terrainRecord?.sha256??null,error:terrainError},
      surfaceVisuals:{siteId:surfaceVisualEntry?.entry.site.id??null,imagery:Boolean(surfaceVisualEntry?.photo),imageryEnabled:surfaceImageryEnabled,
        historicalLighting:Boolean(surfaceVisualEntry?.photo&&surfaceImageryEnabled),photoLightLevel:surfaceVisualEntry?.material?.userData.surfaceUniforms?.surfacePhotoLevel.value??0,
        detailLoaded:Boolean(surfaceDetailMesh),detailVertexCount:surfaceDetailMesh?.geometry.attributes.position.count??0,detailIndexCount:surfaceDetailMesh?.geometry.index.count??0,
        detailSha256:surfaceVisualEntry?.record?.sha256??null,quality:surfaceVisualEntry?.tier??null,
        photoSha256:surfaceVisualEntry?.entry.imagery?.textures?.[surfaceVisualEntry.tier]?.sha256??null,
        photoBounds:surfaceVisualEntry?.entry.imagery?.bounds??null,observer:surfaceVisualEntry?.entry.observer??null,
        sourceUrl:surfaceVisualEntry?.entry.imagery?.sourceUrl??null,cacheCount:surfaceVisualCache.size,error:surfaceVisualError},
      farHorizonSectors:farHorizonRecord?.sectorCount??0,
      farHorizon:{siteId:farHorizonSiteId,rendered:mode==='surface'&&!lost&&!disposed&&Boolean(farHorizonMesh),
        vertexCount:farHorizonMesh?.geometry.attributes.position.count??0,indexCount:farHorizonMesh?.geometry.index.count??0,
        skippedSectors:farHorizonRecord?.skippedSectors??0,projectionRangeM:farHorizonRecord?.rangeM??200000,
        maxSourceBlockerDistanceM:farHorizonRecord?.maxSourceBlockerDistanceM??null,sourceSectorsBeyond32Km:farHorizonRecord?.sourceSectorsBeyond32Km??0,
        source:'data/bundle.json: selected site terrain.skyline azimuthStartDeg and centerModelDeg',
        disclosure:'Display-only angular curtain at an artificial projection range, not terrain at that physical distance. Unknown sectors are omitted; interval visibility remains authoritative.'},
      camera:{orbitalZoom:orbitalCamera.zoom,orbitalViewLiftPx:orbitalCamera.view?.enabled?orbitalCamera.view.offsetY:0,canvasSize:[canvas.clientWidth,canvas.clientHeight],position:(mode==='surface'?surfaceCamera:orbitalCamera).position.toArray(),direction:(mode==='surface'?surfaceCamera:orbitalCamera).getWorldDirection(new THREE.Vector3()).toArray(),fov:(mode==='surface'?surfaceCamera:orbitalCamera).fov,
        focus:mode==='surface'?surfaceFocus:'Moon',opticalZoomFactor:mode==='surface'?Math.tan(65*RAD/2)/Math.tan(surfaceFov*RAD/2):1,bodyAngularScaleFactor:1,terrainFocusBearingDeg:terrainBearingDeg,
        overviewPosition:orbitalOverviewPosition(container.clientWidth,container.clientHeight)},
      sun:{...bodyInfo(sun,'sun',1,2),angularDiameterDeg:2*Math.atan(sunDisc.geometry.parameters.radius/skyDistance)/RAD,directLightIntensity:sunlight.intensity,displayDistanceM:skyDistance},
      earth:{...bodyInfo(earth,'earth',4,5),textured:earthTextureLoaded,angularDiameterDeg:2*Math.atan(earth.geometry.parameters.radius/skyDistance)/RAD,displayDistanceM:skyDistance,
        limbIllustrative:true,
        material:earthMaterial.type,unlit:false,geographicFaceRegistered:false,approximateSunDirectionPhase:true,phaseBasis:'Approximate lit hemisphere follows the cached apparent Sun direction; geographic face and weather are unregistered.',
        disclosure:'Historical cloud-free Blue Marble composite. The phase follows the cached Sun direction; the geographic face and weather are not registered to the selected UTC.'},
      displayLighting:{ambientIntensity:floorLight.intensity,enhancedNight,shadowsLocalHalfExtentM:0,castShadowsRendered:false,proceduralMaterialGrain:regolithShading==='lommel-seeliger',proceduralNormalGrain:regolithShading==='lommel-seeliger'&&!mobileQuality,regolithShading,
        lightScope:'Direct display illumination follows confirmed Sun-center visibility. Dim ambient or enhanced fill is artificial; full-disc shadow, Earthshine and photometric brightness are not calculated.',
        materialNote:surfaceVisualEntry?(surfaceImageryEnabled&&surfaceVisualEntry.photo?'Registered LROC historical image brightness replaces directional shading inside its footprint; it is not calibrated albedo or current-epoch shadows.':surfaceDetailMesh?'NASA shape-from-shading display geometry, modeled reflectance; no procedural local relief.':'NASA LOLA geometry, modeled reflectance.'):'Lommel-Seeliger regolith reflectance with procedural display grain. Grain adds no relief; all slopes and ridges are LOLA data.',
        fill:{intensity:displayFill.intensity,direction:displayFill.position.clone().normalize().toArray(),castsShadows:displayFill.castShadow,basis:'Illustrative display fill; actual DEM normals, independent of Sun visibility.'}},
      renderedFrames:renderer.info.render.frame,triangles:renderer.info.render.triangles,
      gpuResources:{geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures}};
  }

  const pointers=new Map();let pressed=null,pinchDistance=null;
  listen(canvas,'pointerdown',event=>{
    pressed={x:event.clientX,y:event.clientY,moved:false};
    if(mode!=='surface')return;
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});canvas.setPointerCapture(event.pointerId);
    if(pointers.size===2){const [a,b]=[...pointers.values()];pinchDistance=Math.hypot(a.x-b.x,a.y-b.y);}
  });
  listen(canvas,'pointermove',event=>{
    if(pressed&&Math.hypot(event.clientX-pressed.x,event.clientY-pressed.y)>5)pressed.moved=true;
    if(mode!=='surface'||!pointers.has(event.pointerId))return;
    const previous=pointers.get(event.pointerId);pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(pointers.size===2) {
      const [a,b]=[...pointers.values()],distance=Math.hypot(a.x-b.x,a.y-b.y);
      if(pinchDistance&&distance)surfaceFov=clamp(surfaceFov*pinchDistance/distance,8,85);pinchDistance=distance;
    } else {yaw-=(event.clientX-previous.x)*.004;pitch=clamp(pitch+(event.clientY-previous.y)*.004,-85*RAD,85*RAD);}
    setSurfaceLook();updateFrame();
  });
  const release=event=>{
    pointers.delete(event.pointerId);pinchDistance=null;
    if(mode==='orbital'&&pressed&&!pressed.moved&&event.type==='pointerup') {
      const bounds=canvas.getBoundingClientRect();pointer.set((event.clientX-bounds.left)/bounds.width*2-1,-(event.clientY-bounds.top)/bounds.height*2+1);
      raycaster.setFromCamera(pointer,orbitalCamera);
      const hit=raycaster.intersectObjects(markers.flatMap(marker=>[marker.ring,marker.dot]),false)[0];
      const moonHit=raycaster.intersectObject(moon,false)[0];
      let picked=hit&&(!moonHit||hit.distance<moonHit.distance)?hit.object.userData.siteId:null;
      if(!picked){
        const candidates=markers.map(marker=>{
          const p=marker.group.position.clone().project(orbitalCamera),facing=marker.group.position.dot(orbitalCamera.position.clone().sub(marker.group.position))>0;
          return {id:marker.site.id,distance:facing&&p.z<1?Math.hypot((p.x*.5+.5)*bounds.width-(event.clientX-bounds.left),(-p.y*.5+.5)*bounds.height-(event.clientY-bounds.top)):Infinity};
        }).sort((a,b)=>a.distance-b.distance);
        if(candidates[0]?.distance<18)picked=candidates[0].id;
      }
      if(picked){
        const context=NOTABLE_SITES.find(point=>point.id===picked);
        if(context){selectContextSite(picked);onContextSelect(context);}
        else{selectSite(picked);onSiteSelect(picked);}
      }
    }
    pressed=null;
  };
  listen(canvas,'pointerup',release);listen(canvas,'pointercancel',release);
  listen(canvas,'wheel',event=>{
    if(mode!=='surface')return;event.preventDefault();surfaceFov=clamp(surfaceFov+event.deltaY*.025,8,85);setSurfaceLook();updateFrame();
  },{passive:false});
  listen(canvas,'keydown',event=>{
    const step=(event.shiftKey?8:3)*RAD;
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','_'].includes(event.key))return;
    if(pendingMode==='surface')commitMode('surface');
    event.preventDefault();flight=null;
    if(['+','=','-','_'].includes(event.key)){zoom(['+','='].includes(event.key)?1:-1);return;}
    if(mode==='surface') {
      if(event.key==='ArrowLeft')yaw-=step;if(event.key==='ArrowRight')yaw+=step;
      if(event.key==='ArrowUp')pitch+=step;if(event.key==='ArrowDown')pitch-=step;
      pitch=clamp(pitch,-85*RAD,85*RAD);
      setSurfaceLook();updateFrame();
    } else {
      const offset=orbitalCamera.position.clone().sub(controls.target),spherical=new THREE.Spherical().setFromVector3(offset);
      if(event.key==='ArrowLeft')spherical.theta-=step;if(event.key==='ArrowRight')spherical.theta+=step;
      if(event.key==='ArrowUp')spherical.phi-=step;if(event.key==='ArrowDown')spherical.phi+=step;
      spherical.makeSafe();
      spherical.radius=clamp(spherical.radius,controls.minDistance,controls.maxDistance);orbitalCamera.position.setFromSpherical(spherical).add(controls.target);controls.update();invalidate();
    }
  });
  listen(canvas,'webglcontextlost',event=>{
    event.preventDefault();lost=true;cancelAnimationFrame(raf);raf=0;
    sun.visible=earth.visible=orbitalSun.visible=orbitalEarth.visible=false;Object.values(orbitalRays).forEach(ray=>{ray.visible=false;});container.dataset.sunRendered=container.dataset.earthRendered='false';
    container.dataset.webgl=container.dataset.webglStatus='lost';
    markerLabel.hidden=markerLegend.hidden=terrainCluster.hidden=terrainLeader.hidden=true;terrainCluster.open=false;for(const marker of markers){if(marker.button)marker.button.hidden=true;if(marker.pin)marker.pin.hidden=true;}
    report('error','The WebGL context was lost. The accessible mission views remain available.');
  });
  listen(document,'visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else invalidate();});
  const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
    intersecting=entries[0].isIntersecting;if(!intersecting){cancelAnimationFrame(raf);raf=0;}else invalidate();
  },{rootMargin:'80px'}):null;observer?.observe(container);
  const resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(resize):null;resizeObserver?.observe(container);
  listen(window,'resize',resize);
  function dispose() {
    if(disposed)return;disposed=true;surfaceVisualAbort?.abort();++terrainRequest;++modeTransition;clearTimeout(transitionTimer);transitionTimer=0;cancelAnimationFrame(raf);raf=0;
    observer?.disconnect();resizeObserver?.disconnect();listeners.forEach(remove=>remove());controls.dispose();
    resources.forEach(resource=>resource.dispose());renderer.dispose();
    canvas.remove();caption.remove();bodyStatus.remove();markerLabel.remove();markerLegend.remove();obstruction.remove();bodyLabels.earth.remove();bodyLabels.sun.remove();
    terrainCluster.remove();terrainLeader.remove();for(const marker of markers){marker.button?.remove();marker.pin?.remove();}
    container.dataset.webgl=container.dataset.webglStatus='disposed';
    container.dataset.sunRendered=container.dataset.earthRendered='false';
    sun.visible=earth.visible=orbitalSun.visible=orbitalEarth.visible=false;
  }
  updateMarkers();setSurfaceLook();updateFrame();resize();
  const moonReady=await moonTexturePromise;
  if(!moonReady||lost) {
    const message=lost?'WebGL was lost while loading the Moon.':'The NASA Moon image could not be loaded.';
    report('error',`${message} Use the accessible mission views.`);
    dispose();container.dataset.webgl=container.dataset.webglStatus='unavailable';
    throw new Error(message);
  }
  report('ready','Interactive Moon ready. Select a cached study point or enter its surface view.');
  earthTexturePromise??=texture('earth-color.jpg',earthMapTarget,'map','earth');
  if(!mobileQuality)requestAnimationFrame(()=>{if(!disposed&&!lost)void loadHighDetail();});
  return {selectSite,selectContextSite,setMode,setFrame,focus,resize,dispose,inspect,loadHighDetail,
    setSurfaceImagery(enabled){if(lost||disposed)return false;surfaceImageryEnabled=Boolean(enabled);updateSurfaceMaterial();invalidate();return true;},
    setEnhancedNight(enabled){if(lost||disposed)return false;enhancedNight=Boolean(enabled);updateFrame();return true;}};
}
