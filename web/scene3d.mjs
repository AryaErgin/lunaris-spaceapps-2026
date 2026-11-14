// Display renderer only. Visibility and all mission decisions come from frozen intervals.
import {bodyDirection, moonPoint,localToMoonDirection} from './scene-model.mjs';
import {NOTABLE_SITES} from './anysite.mjs';

const RAD=Math.PI/180;
const asset=name=>new URL(`./assets/${name}`,import.meta.url).href;
const terrainUrl=new URL('./data/terrain-scenes.json',import.meta.url);
const clamp=(value,lo,hi)=>Math.max(lo,Math.min(hi,value));

export const moonFixedPosition=moonPoint;
export function surfaceLightState(sunState,hasDirection,enhanced=false){
  const lit=hasDirection&&sunState==='visible';
  return {direct:lit?2.3:0,ambient:(lit||enhanced)? .18:.002,fill:(lit||enhanced)? .3:0,
    skylineLevel:lit?1:(enhanced? .5:0),skylineFloor:(lit||enhanced)? .02:.001,enhanced:Boolean(enhanced)};
}
export function orbitalOverviewDistance(width,height) {
  if(width>900)return 3.3;
  const horizontalHalfFov=Math.atan(Math.tan(39*RAD/2)*Math.max(1,width)/Math.max(1,height));
  return Math.max(3.3,1/Math.sin(horizontalHalfFov*.67));
}
export function orbitalOverviewPosition(width,height) {
  const radius=orbitalOverviewDistance(width,height),length=Math.hypot(3.2,-.65,-.4);
  return [3.2,-.65,-.4].map(value=>value*radius/length);
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

export async function createMissionScene({container,bundle,onSiteSelect=()=>{},onNotableSelect=()=>{},onModeChange=()=>{},onStatus=()=>{}}) {
  if(!container||!bundle?.sites?.length)throw new Error('A scene container and cached study points are required.');
  const vendor=await import('./vendor/three-bundle.mjs');
  const THREE=vendor.THREE??vendor,OrbitControls=vendor.OrbitControls;
  let disposed=false,lost=false,mode='orbital',site=bundle.sites[0],sample=null,states={},selectedNotableId=null;
  let raf=0,intersecting=true,flight=null,pendingMode=null,pendingFocus=null,terrainRequest=0,terrainMetadataPromise;
  let terrainMesh=null,terrainSiteId=null,terrainRecord=null,terrainError=null;
  let moonTextureLoaded=false,earthTextureLoaded=false,moonBumpLoaded=false;
  let moonDetail='loading',moonHighDetailPromise=null,farHorizonMesh=null,farHorizonRecord=null,farHorizonSiteId=null;
  let terrainBearingDeg=terrainFocusBearing(site);
  let yaw=0,pitch=-5*RAD,surfaceFov=65,surfaceFocus='terrain',orbitalFocus='Moon',needsRender=true,captionSignature='';
  let enhancedNight=false;
  const mobileQuality=window.matchMedia('(max-width:700px)').matches||navigator.connection?.saveData===true;
  const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const resources=new Set(),listeners=[],terrainCache=new Map(),farHorizonCache=new Map();
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
  const note=document.createElement('span');note.className='mission-scene-note mission-scene-direction-note';
  caption.append(location,note);container.append(caption);
  const bodyStatus=document.createElement('div');bodyStatus.className='mission-scene-body-status';
  bodyStatus.setAttribute('aria-live','polite');container.append(bodyStatus);
  const markerLabel=document.createElement('div');markerLabel.className='mission-scene-marker-label';container.append(markerLabel);
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
  const dotGeometry=track(new THREE.SphereGeometry(.0012,12,8));
  const normal=new THREE.Vector3(0,0,1);
  bundle.sites.forEach((point,index)=>{
    const group=new THREE.Group();group.position.fromArray(moonPoint(point.lat,point.lon,1.008));
    group.quaternion.setFromUnitVectors(normal,group.position.clone().normalize());
    const material=track(new THREE.MeshBasicMaterial({color:0xc9d4e1,side:THREE.DoubleSide,depthTest:true}));
    const ring=new THREE.Mesh(ringGeometry,material);group.add(ring);
    const dot=new THREE.Mesh(dotGeometry,material);dot.position.z=.006;group.add(dot);
    ring.userData.siteId=dot.userData.siteId=point.id;orbitalScene.add(group);
    markers.push({group,ring,dot,material,site:point,index});
  });

  // Curated sites are positions only. Blue markers never enter terrain-dependent mission calculations.
  const notableMarkers=[],notableRing=track(new THREE.RingGeometry(.005,.008,24));
  const notableDot=track(new THREE.SphereGeometry(.0028,12,8));
  const notableHit=track(new THREE.SphereGeometry(.016,12,8));
  for(const point of NOTABLE_SITES){
    const group=new THREE.Group();group.position.fromArray(moonPoint(point.lat,point.lon,1.012));
    group.quaternion.setFromUnitVectors(normal,group.position.clone().normalize());
    const material=track(new THREE.MeshBasicMaterial({color:0x55bfdc,side:THREE.DoubleSide,depthTest:true}));
    const ring=new THREE.Mesh(notableRing,material);ring.userData.notableId=point.id;group.add(ring);
    const dot=new THREE.Mesh(notableDot,material);dot.userData.notableId=point.id;dot.position.z=.004;group.add(dot);
    // A transparent pick volume makes tiny scientifically located markers usable.
    const pickMaterial=track(new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false,depthTest:false}));
    const hit=new THREE.Mesh(notableHit,pickMaterial);hit.position.z=.004;hit.userData.notableId=point.id;group.add(hit);
    orbitalScene.add(group);notableMarkers.push({group,ring,dot,hit,material,site:point});
  }
  container.dataset.notableSiteCount=String(notableMarkers.length);
  const legend=document.createElement('div');legend.className='moon-site-legend';
  legend.textContent='Gold: terrain study · Blue: locations only';
  legend.setAttribute('aria-label','Gold markers are terrain-aware study points. Blue markers are notable lunar locations with level-horizon directions only.');
  container.append(legend);

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
  function regolithMaterial() {
    const material=new THREE.MeshStandardMaterial({color:0xa9a59d,roughness:1,metalness:0,side:THREE.FrontSide});
    const cosine='float dotNL = saturate( dot( geometryNormal, directLight.direction ) );';
    const chunk=THREE.ShaderChunk?.lights_physical_pars_fragment;
    if(!chunk?.includes(cosine))return material;
    regolithShading='lommel-seeliger';
    const grain=mobileQuality?'0':'1';
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
        diffuseColor.rgb*=0.93+0.04*lnNoise(vRegolith.xz*0.19)/(1.0+lnRange*0.02)+0.03*lnNoise(vRegolith.xz*0.0127);`)
        .replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
        #if ${grain}
        { float e=0.12+lnRange*0.004;vec2 q=vRegolith.xz;
          vec2 slope=vec2(lnGrain(q+vec2(e,0.0),lnRange)-lnGrain(q-vec2(e,0.0),lnRange),lnGrain(q+vec2(0.0,e),lnRange)-lnGrain(q-vec2(0.0,e),lnRange))*(0.004/e);
          normal=normalize(normal+mat3(viewMatrix)*vec3(-slope.x,0.0,-slope.y)); }
        #endif`);
    };
    material.customProgramCacheKey=()=>'lunaris-regolith-3-'+grain;
    return material;
  }
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2(),projected=new THREE.Vector3();
  function invalidate(){needsRender=true;schedule();}
  function schedule(){if(!disposed&&!lost&&!raf&&intersecting&&!document.hidden)raf=requestAnimationFrame(draw);}
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
    const signature=[site.id,mode,orbitalFocus,states.sun,states.earth,visibility.sun,visibility.earth,framed.sun,framed.earth,earthTextureLoaded].join('|');
    if(signature===captionSignature)return;captionSignature=signature;
    location.textContent=`${mode==='orbital'&&['earth','sun'].includes(orbitalFocus)?`${orbitalFocus==='earth'?'Earth':'Sun'} direction from `:''}${site.name} · ${Math.abs(site.lat).toFixed(4)}° S · ${((site.lon%360+360)%360).toFixed(4)}° E`;
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
    bodyStatus.hidden=false;
  }
  function updateFrame() {
    const show=renderedBodies(sample,states);
    sun.visible=!lost&&!disposed&&mode==='surface'&&show.sun;
    earth.visible=!lost&&!disposed&&mode==='surface'&&show.earth&&earthTextureLoaded;
    const cachedTime=Number.isFinite(sample?.[0])&&sample[0]>=bundle.coverage[0]&&sample[0]<bundle.coverage[1];
    orbitalSun.visible=!lost&&!disposed&&mode==='orbital'&&cachedTime&&Boolean(bodyDirection(sample?.[1],sample?.[2]));
    orbitalEarth.visible=!lost&&!disposed&&mode==='orbital'&&cachedTime&&Boolean(bodyDirection(sample?.[4],sample?.[5]))&&earthTextureLoaded;
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
    captionUpdate();invalidate();
  }
  function updateMarkers() {
    for(const marker of markers) {
      const active=marker.site.id===site.id;
      marker.material.color.set(active?0xeebf74:0xb9c9dd);
      marker.group.scale.setScalar(active?1.3:.8);
    }
    for(const marker of notableMarkers){
      const active=marker.site.id===selectedNotableId;
      marker.material.color.set(active?0xa7ebf5:0x55bfdc);
      marker.group.scale.setScalar(active?1.4:1);
    }
    markerLabel.textContent=site.name;
  }
  function draw(now) {
    raf=0;if(disposed||lost||!intersecting||document.hidden)return;
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
    const earthDirection=bodyDirection(sample?.[4],sample?.[5]),earthFraming=viewInfo(earthDirection);
    obstruction.hidden=mode!=='surface'||states.earth!=='blocked'||!earthDirection||!earthFraming.inFrustum;
    if(!obstruction.hidden){
      obstruction.style.left=`${clamp(earthFraming.projectedPosition[0]*100,18,82)}%`;
      obstruction.style.top=`${clamp(earthFraming.projectedPosition[1]*100,30,72)}%`;
      obstruction.title=`Earth-center direction: bearing ${sample[4].toFixed(1)} degrees, elevation ${sample[5].toFixed(1)} degrees. The calculated horizon blocks its center; no Earth body is drawn.`;
    }
    if(needsRender||flight) {
      renderer.toneMappingExposure=mode==='orbital'?1.15:1.3;
      renderer.render(mode==='orbital'?orbitalScene:surfaceScene,mode==='orbital'?orbitalCamera:surfaceCamera);
      needsRender=false;
      if(mode==='orbital') {
        const marker=markers.find(item=>item.site.id===site.id);
        projected.copy(marker.group.position).project(orbitalCamera);
        const facing=marker.group.position.dot(orbitalCamera.position.clone().sub(marker.group.position))>0;
        markerLabel.hidden=!facing||Math.abs(projected.x)>1||Math.abs(projected.y)>1||projected.z>1;
        markerLabel.style.left=`${(projected.x*.5+.5)*100}%`;markerLabel.style.top=`${(-projected.y*.5+.5)*100}%`;
        for(const [key,object] of [['earth',orbitalEarth],['sun',orbitalSun]]) {
          const label=bodyLabels[key],toBody=object.position.clone().sub(orbitalCamera.position),range=toBody.length();
          toBody.divideScalar(range);
          const along=-orbitalCamera.position.dot(toBody),miss=orbitalCamera.position.clone().addScaledVector(toBody,along).length();
          projected.copy(object.position).project(orbitalCamera);
          label.hidden=!object.visible||projected.z>1||Math.abs(projected.x)>1||Math.abs(projected.y)>1||(along>0&&along<range&&miss<1);
          label.style.left=`${(projected.x*.5+.5)*100}%`;label.style.top=`${(-projected.y*.5+.5)*100}%`;
        }
      } else {markerLabel.hidden=true;bodyLabels.earth.hidden=bodyLabels.sun.hidden=true;}
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
        if(ok)report('ready','Original 4K NASA LROC Moon texture loaded. Globe lighting remains illustrative.');
        else moonHighDetailPromise=null;
        return ok;
      });
    }
    return moonHighDetailPromise;
  }

  async function loadTerrain() {
    const request=++terrainRequest,requestedSite=site;
    if(terrainSiteId===site.id&&terrainMesh){container.dataset.terrainStatus='ready';return;}
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
        terrainCache.set(requestedSite.id,cached);
      }
      if(disposed||request!==terrainRequest)return;
      terrainMesh=cached.mesh;terrainRecord=record;terrainSiteId=requestedSite.id;surfaceScene.add(terrainMesh);
      container.dataset.terrainStatus='ready';container.dataset.terrainVertices=String(record.vertexCount);container.dataset.terrainIndices=String(record.indexCount);
      report('ready','NASA LOLA surface loaded. Visibility remains controlled by the authoritative interval model.');
      invalidate();
    } catch(error) {
      if(disposed||request!==terrainRequest)return;
      terrainError=error.message;container.dataset.terrainStatus='unavailable';
      report('warning',`Surface terrain unavailable: ${error.message} No substitute terrain is shown.`);invalidate();
    }
  }
  function focusSite(duration=900,onComplete=null) {
    if(!onComplete&&pendingMode==='surface')onComplete=()=>{if(pendingMode==='surface'&&!disposed)commitMode('surface');};
    const selected=new THREE.Vector3(...moonPoint(site.lat,site.lon));
    orbitalFocus='site';controls.target.set(0,0,0);controls.minDistance=1.06;
    const to=selected.clone().multiplyScalar(onComplete?1.25:orbitalOverviewDistance(container.clientWidth,container.clientHeight));
    if(reducedMotion){orbitalCamera.position.copy(to);orbitalCamera.lookAt(0,0,0);onComplete?.();}
    else{const from=orbitalCamera.position.clone();flight={from,to,start:performance.now(),duration,onComplete,fromDirection:from.clone().normalize(),fromRadius:from.length(),toRadius:to.length(),rotation:new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(),to.clone().normalize())};}
    invalidate();
  }
  function selectSite(siteId,{focus:shouldFocus=true}={}) {
    const next=bundle.sites.find(point=>point.id===siteId);if(!next)return false;
    const changed=site.id!==next.id;site=next;terrainBearingDeg=terrainFocusBearing(site);container.dataset.site=site.id;
    if(changed){sample=null;states={};container.dataset.frame='';}
    if(changed&&mode==='surface'){yaw=terrainBearingDeg*RAD;pitch=terrainPitch();surfaceFov=65;surfaceFocus='terrain';updateFarHorizon();}
    updateMarkers();setSurfaceLook();updateFrame();
    if(mode==='surface'&&changed)void loadTerrain();
    if(mode==='orbital'&&shouldFocus)focusSite(pendingMode==='surface'?520:900,pendingMode==='surface'?()=>commitMode('surface'):null);return true;
  }
  function commitMode(next) {
    pendingMode=null;
    mode=next;flight=null;controls.enabled=mode==='orbital';container.dataset.mode=mode;
    if(!reducedMotion&&typeof canvas.animate==='function')canvas.animate([{opacity:.15},{opacity:1}],{duration:420,easing:'ease-out'});
    canvas.setAttribute('aria-label',mode==='orbital'?'Interactive Moon. Drag or use arrow keys to rotate; scroll, pinch, plus and minus zoom. Scroll outside the scene to move the page.'
      :'Lunar surface at the recorded observer height. Drag or use arrow keys to look around; scroll, pinch, plus and minus change field of view. Scroll outside the scene to move the page.');
    if(mode==='surface') {
      yaw=terrainBearingDeg*RAD;pitch=terrainPitch();surfaceFov=65;surfaceFocus='terrain';
      setSurfaceLook();updateFarHorizon();void loadTerrain();earthTexturePromise??=texture('earth-color.jpg',earthMapTarget,'map','earth');
      if(pendingFocus){const target=pendingFocus;pendingFocus=null;focusBody(target);}
    }
    updateFrame();onModeChange(mode);resize();return true;
  }
  function setMode(next) {
    if(!['orbital','surface'].includes(next)||disposed)return false;
    if(next==='orbital'){pendingMode=null;pendingFocus=null;flight=null;controls.enabled=true;if(mode===next){invalidate();return true;}return commitMode(next);}
    if(next===mode||pendingMode===next)return true;
    if(!reducedMotion) {
      pendingMode='surface';controls.enabled=false;
      report('loading','Approaching the selected south-pole study point.');
      focusSite(520,()=>{if(pendingMode==='surface'&&!disposed)commitMode('surface');});return true;
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
      orbitalFocus='Moon';controls.target.set(0,0,0);controls.minDistance=1.06;
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
      pendingFocus=null;
      if(mode==='orbital')focusSite();else {yaw=terrainBearingDeg*RAD;surfaceFov=65;pitch=terrainPitch();surfaceFocus='terrain';setSurfaceLook();updateFrame();}return;
    }
    if(!['earth','sun'].includes(target))return;
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
      orbitalFocus=target;controls.target.set(0,0,0);controls.minDistance=1.06;
      const from=orbitalCamera.position.clone();
      if(reducedMotion){flight=null;orbitalCamera.position.copy(to);orbitalCamera.lookAt(0,0,0);controls.update();}
      else flight={from,to,start:performance.now(),duration:900,fromDirection:from.clone().normalize(),fromRadius:from.length(),toRadius:to.length(),
        rotation:new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(),to.clone().normalize())};
      captionUpdate();invalidate();return;
    }
    focusBody(target);
  }
  function resize() {
    if(disposed)return;
    const width=Math.max(1,container.clientWidth),height=Math.max(1,container.clientHeight);
    renderer.setSize(width,height,false);
    if(!flight&&orbitalFocus==='Moon')orbitalCamera.position.setLength(orbitalOverviewDistance(width,height));
    for(const camera of [orbitalCamera,surfaceCamera]){camera.aspect=width/height;camera.updateProjectionMatrix();}
    orbitalCamera.clearViewOffset();
    invalidate();
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
      graphics:{renderer:gpuExtension?gl.getParameter(gpuExtension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),quality:mobileQuality?'mobile-2K':'desktop-auto-4K'},
      orbital:{earth:orbitalBody(orbitalEarth,'earth',4,5),sun:orbitalBody(orbitalSun,'sun',1,2),rayOrigin:rayOrigin.toArray(),displayDepthMoonRadii:orbitalDepth,apparentDiameterDeg:{earth:1.9,sun:.53},
        disclosure:'Apparent observer-ray directions transformed from the selected site ENU frame. Bodies keep their apparent angular diameters from the Moon at schematic distances; no planetary ranges are cached. They are drawn whenever a cached direction exists; visibility from the study point is reported separately.'},
      moon:{textured:moonTextureLoaded,detail:moonDetail,bump:moonBumpLoaded,vertices:moon.geometry.attributes.position.count,projectedCenter:new THREE.Vector3().project(orbitalCamera).toArray()},
      terrain:{siteId:terrainSiteId,loaded:Boolean(terrainMesh),vertexCount:terrainMesh?.geometry.attributes.position.count??0,indexCount:terrainMesh?.geometry.index.count??0,sha256:terrainRecord?.sha256??null,error:terrainError},
      farHorizonSectors:farHorizonRecord?.sectorCount??0,
      farHorizon:{siteId:farHorizonSiteId,rendered:mode==='surface'&&!lost&&!disposed&&Boolean(farHorizonMesh),
        vertexCount:farHorizonMesh?.geometry.attributes.position.count??0,indexCount:farHorizonMesh?.geometry.index.count??0,
        skippedSectors:farHorizonRecord?.skippedSectors??0,projectionRangeM:farHorizonRecord?.rangeM??200000,
        maxSourceBlockerDistanceM:farHorizonRecord?.maxSourceBlockerDistanceM??null,sourceSectorsBeyond32Km:farHorizonRecord?.sourceSectorsBeyond32Km??0,
        source:'data/bundle.json: selected site terrain.skyline azimuthStartDeg and centerModelDeg',
        disclosure:'Display-only angular curtain at an artificial projection range, not terrain at that physical distance. Unknown sectors are omitted; interval visibility remains authoritative.'},
      camera:{position:(mode==='surface'?surfaceCamera:orbitalCamera).position.toArray(),direction:(mode==='surface'?surfaceCamera:orbitalCamera).getWorldDirection(new THREE.Vector3()).toArray(),fov:(mode==='surface'?surfaceCamera:orbitalCamera).fov,
        focus:mode==='surface'?surfaceFocus:'Moon',opticalZoomFactor:mode==='surface'?Math.tan(65*RAD/2)/Math.tan(surfaceFov*RAD/2):1,bodyAngularScaleFactor:1,terrainFocusBearingDeg:terrainBearingDeg,
        overviewPosition:orbitalOverviewPosition(container.clientWidth,container.clientHeight)},
      sun:{...bodyInfo(sun,'sun',1,2),angularDiameterDeg:2*Math.atan(sunDisc.geometry.parameters.radius/skyDistance)/RAD,directLightIntensity:sunlight.intensity,displayDistanceM:skyDistance},
      earth:{...bodyInfo(earth,'earth',4,5),textured:earthTextureLoaded,angularDiameterDeg:2*Math.atan(earth.geometry.parameters.radius/skyDistance)/RAD,displayDistanceM:skyDistance,
        limbIllustrative:true,
        material:earthMaterial.type,unlit:false,geographicFaceRegistered:false,approximateSunDirectionPhase:true,phaseBasis:'Approximate lit hemisphere follows the cached apparent Sun direction; geographic face and weather are unregistered.',
        disclosure:'Historical cloud-free Blue Marble composite. The phase follows the cached Sun direction; the geographic face and weather are not registered to the selected UTC.'},
      notableSites:{count:notableMarkers.length,selectedId:selectedNotableId,scope:'Level-horizon sky coordinates only; no terrain-aware verdicts.'},
      displayLighting:{ambientIntensity:floorLight.intensity,enhancedNight,shadowsLocalHalfExtentM:0,castShadowsRendered:false,proceduralMaterialGrain:regolithShading==='lommel-seeliger',proceduralNormalGrain:regolithShading==='lommel-seeliger'&&!mobileQuality,regolithShading,
        lightScope:'Direct display illumination follows confirmed Sun-center visibility. Dim ambient or enhanced fill is artificial; full-disc shadow, Earthshine and photometric brightness are not calculated.',
        materialNote:'Lommel-Seeliger regolith reflectance with procedural display grain. Grain adds no relief; all slopes and ridges are LOLA data.',
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
      const hit=raycaster.intersectObjects([
        ...markers.flatMap(marker=>[marker.ring,marker.dot]),
        ...notableMarkers.flatMap(marker=>[marker.ring,marker.dot,marker.hit])
      ],false)[0];
      const moonHit=raycaster.intersectObject(moon,false)[0];
      const onSurface=hit&&(!moonHit||hit.distance<moonHit.distance);
      let picked=onSurface?hit.object.userData.siteId:null;
      const pickedNotable=onSurface?hit.object.userData.notableId:null;
      if(!picked&&orbitalFocus==='site'){
        const candidates=markers.map(marker=>{
          const p=marker.group.position.clone().project(orbitalCamera),facing=marker.group.position.dot(orbitalCamera.position.clone().sub(marker.group.position))>0;
          return {id:marker.site.id,distance:facing&&p.z<1?Math.hypot((p.x*.5+.5)*bounds.width-(event.clientX-bounds.left),(-p.y*.5+.5)*bounds.height-(event.clientY-bounds.top)):Infinity};
        }).sort((a,b)=>a.distance-b.distance);
        if(candidates[0]?.distance<18)picked=candidates[0].id;
      }
      if(picked){selectedNotableId=null;selectSite(picked);onSiteSelect(picked);}
      else if(pickedNotable){selectedNotableId=pickedNotable;updateMarkers();invalidate();onNotableSelect(pickedNotable);}
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
    report('error','The WebGL context was lost. The accessible mission views remain available.');
  });
  listen(document,'visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else invalidate();});
  const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
    intersecting=entries[0].isIntersecting;if(!intersecting){cancelAnimationFrame(raf);raf=0;}else invalidate();
  },{rootMargin:'80px'}):null;observer?.observe(container);
  const resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(resize):null;resizeObserver?.observe(container);
  listen(window,'resize',resize);
  function dispose() {
    if(disposed)return;disposed=true;++terrainRequest;cancelAnimationFrame(raf);raf=0;
    observer?.disconnect();resizeObserver?.disconnect();listeners.forEach(remove=>remove());controls.dispose();
    resources.forEach(resource=>resource.dispose());renderer.dispose();
    canvas.remove();caption.remove();bodyStatus.remove();markerLabel.remove();legend.remove();obstruction.remove();bodyLabels.earth.remove();bodyLabels.sun.remove();
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
  return {selectSite,setMode,setFrame,focus,resize,dispose,inspect,loadHighDetail,
    setEnhancedNight(enabled){if(lost||disposed)return false;enhancedNight=Boolean(enabled);updateFrame();return true;}};
}
