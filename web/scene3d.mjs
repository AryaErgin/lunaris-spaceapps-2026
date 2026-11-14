// Display renderer only. Visibility and all mission decisions come from frozen intervals.
import {bodyDirection, moonPoint} from './scene-model.mjs';

const RAD=Math.PI/180;
const asset=name=>new URL(`./assets/${name}`,import.meta.url).href;
const terrainUrl=new URL('./data/terrain-scenes.json',import.meta.url);
const clamp=(value,lo,hi)=>Math.max(lo,Math.min(hi,value));

export const moonFixedPosition=moonPoint;
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

export async function createMissionScene({container,bundle,onSiteSelect=()=>{},onModeChange=()=>{},onStatus=()=>{}}) {
  if(!container||!bundle?.sites?.length)throw new Error('A scene container and cached study points are required.');
  const vendor=await import('./vendor/three-bundle.mjs');
  const THREE=vendor.THREE??vendor,OrbitControls=vendor.OrbitControls;
  let disposed=false,lost=false,mode='orbital',site=bundle.sites[0],sample=null,states={};
  let raf=0,intersecting=true,flight=null,pendingMode=null,pendingFocus=null,terrainRequest=0,terrainMetadataPromise;
  let terrainMesh=null,terrainSiteId=null,terrainRecord=null,terrainError=null;
  let moonTextureLoaded=false,earthTextureLoaded=false,moonBumpLoaded=false;
  let moonDetail='loading',moonHighDetailPromise=null,farHorizonMesh=null,farHorizonRecord=null,farHorizonSiteId=null;
  let terrainBearingDeg=terrainFocusBearing(site);
  let yaw=0,pitch=-5*RAD,surfaceFov=65,surfaceFocus='terrain',needsRender=true,captionSignature='';
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
  canvas.setAttribute('aria-label','Interactive Moon. Drag to rotate, scroll or pinch to zoom. Arrow keys rotate; plus and minus zoom.');
  container.append(canvas);
  let renderer;
  try {
    renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance',logarithmicDepthBuffer:true});
  } catch(error) {
    canvas.remove();container.dataset.webgl=container.dataset.webglStatus='unavailable';
    report('error','WebGL is unavailable. Use the accessible mission and terrain views.');throw error;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000,1);
  container.dataset.webgl=container.dataset.webglStatus='ready';

  const caption=document.createElement('div');caption.className='mission-scene-caption';
  const location=document.createElement('span');location.className='mission-scene-location';
  const note=document.createElement('span');note.className='mission-scene-note';
  caption.append(location,note);container.append(caption);
  const bodyStatus=document.createElement('div');bodyStatus.className='mission-scene-body-status';
  bodyStatus.setAttribute('aria-live','polite');container.append(bodyStatus);
  const markerLabel=document.createElement('div');markerLabel.className='mission-scene-marker-label';container.append(markerLabel);

  const orbitalScene=new THREE.Scene(),surfaceScene=new THREE.Scene();
  orbitalScene.background=surfaceScene.background=new THREE.Color(0x000000);
  const orbitalCamera=new THREE.PerspectiveCamera(39,1,.01,30);
  orbitalCamera.position.fromArray(orbitalOverviewPosition(container.clientWidth,container.clientHeight));orbitalCamera.lookAt(0,0,0);
  const surfaceCamera=new THREE.PerspectiveCamera(surfaceFov,1,.08,500000);
  const controls=new OrbitControls(orbitalCamera,canvas);
  controls.enableDamping=!reducedMotion;controls.dampingFactor=.075;
  controls.enablePan=false;controls.enableZoom=true;controls.enableRotate=true;
  controls.minDistance=1.06;controls.maxDistance=18;controls.rotateSpeed=.55;controls.zoomSpeed=.65;
  listen(controls,'change',()=>invalidate());listen(controls,'start',()=>{flight=null;});

  const moonMaterial=track(new THREE.MeshStandardMaterial({color:0xc3c1bc,roughness:1,metalness:0}));
  const moon=new THREE.Mesh(track(new THREE.SphereGeometry(1,128,96)),moonMaterial);
  orbitalScene.add(moon);
  orbitalScene.add(new THREE.AmbientLight(0xffffff,.6));
  const globeLight=new THREE.DirectionalLight(0xfff2df,2.9);globeLight.position.set(4,1.5,-2);orbitalScene.add(globeLight);
  const markers=[];
  const ringGeometry=track(new THREE.RingGeometry(.018,.022,48));
  const dotGeometry=track(new THREE.SphereGeometry(.009,14,10));
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

  // Both sky objects retain their angular scale. Focus changes the camera FOV.
  // Display depth only: place angular-sized sky objects behind the projected skyline.
  const skyDistance=400000;
  const sun=new THREE.Group();
  const sunDisc=new THREE.Mesh(track(new THREE.SphereGeometry(skyDistance*Math.tan(.265*RAD),32,20)),
    track(new THREE.MeshBasicMaterial({color:0xfff7d1,toneMapped:false})));
  sun.add(sunDisc);sun.visible=false;surfaceScene.add(sun);
  const glowCanvas=document.createElement('canvas');glowCanvas.width=glowCanvas.height=128;
  const glowContext=glowCanvas.getContext('2d');
  if(glowContext) {
    const gradient=glowContext.createRadialGradient(64,64,9,64,64,64);
    gradient.addColorStop(0,'rgba(255,240,182,0.35)');gradient.addColorStop(.3,'rgba(255,214,125,0.13)');gradient.addColorStop(1,'rgba(255,194,92,0)');
    glowContext.fillStyle=gradient;glowContext.fillRect(0,0,128,128);
    const sprite=new THREE.Sprite(track(new THREE.SpriteMaterial({map:track(new THREE.CanvasTexture(glowCanvas)),transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false})));
    const size=skyDistance*Math.tan(.265*RAD)*7;sprite.scale.set(size,size,1);sun.add(sprite);
  }
  // Blue Marble already contains shading; its geographic face and epoch are unregistered.
  const earthMaterial=track(new THREE.MeshBasicMaterial({color:0xffffff,toneMapped:false}));
  const earth=new THREE.Mesh(track(new THREE.SphereGeometry(skyDistance*Math.tan(.95*RAD),64,48)),earthMaterial);
  earth.rotation.y=-.7;earth.rotation.z=.12;earth.visible=false;surfaceScene.add(earth);
  const floorLight=new THREE.AmbientLight(0xd9d9d7,.45);surfaceScene.add(floorLight);
  // A separate, explicitly illustrative fill shades actual DEM normals without casting shadows.
  const displayFill=new THREE.DirectionalLight(0xe1e4e8,1.2);
  displayFill.castShadow=false;surfaceScene.add(displayFill,displayFill.target);
  const sunlight=new THREE.DirectionalLight(0xfff2dd,3.2);
  sunlight.castShadow=true;sunlight.shadow.mapSize.set(1024,1024);
  Object.assign(sunlight.shadow.camera,{left:-350,right:350,top:350,bottom:-350,near:1,far:1500});
  sunlight.shadow.bias=-.00005;sunlight.shadow.normalBias=.1;
  surfaceScene.add(sunlight,sunlight.target);

  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2(),projected=new THREE.Vector3();
  function invalidate(){needsRender=true;schedule();}
  function schedule(){if(!disposed&&!lost&&!raf&&intersecting&&!document.hidden)raf=requestAnimationFrame(draw);}
  function setSurfaceLook() {
    surfaceCamera.position.set(0,Number.isFinite(site.heightM)?site.heightM:2,0);
    const direction=bodyDirection(yaw/RAD,pitch/RAD);
    surfaceCamera.lookAt(surfaceCamera.position.clone().add(new THREE.Vector3(...direction)));
    surfaceCamera.fov=surfaceFov;surfaceCamera.updateProjectionMatrix();
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
        const material=track(new THREE.MeshBasicMaterial({color:0x25282b,side:THREE.DoubleSide,toneMapped:false}));
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
  function captionUpdate() {
    const visibility=renderedBodies(sample,states);
    const framed=Object.fromEntries([['sun',1,2],['earth',4,5]].map(([key,az,el])=>[key,viewInfo(bodyDirection(sample?.[az],sample?.[el])).inFrustum]));
    const signature=[site.id,mode,states.sun,states.earth,visibility.sun,visibility.earth,framed.sun,framed.earth].join('|');
    if(signature===captionSignature)return;captionSignature=signature;
    location.textContent=`${site.name} · ${Math.abs(site.lat).toFixed(4)}° S · ${((site.lon%360+360)%360).toFixed(4)}° E`;
    note.textContent=mode==='orbital'?'NASA lunar imagery · Moon-fixed markers · Globe lighting and bump relief illustrative'
      :`NASA LOLA mesh + projected nominal skyline · ${site.heightM} m observer · Display lighting; historical unregistered Earth composite`;
    bodyStatus.replaceChildren();
    for(const key of ['sun','earth']) {
      const label=document.createElement('span');label.dataset.body=key;label.dataset.state=states[key]||'unknown';
      label.textContent=`${key==='sun'?'Sun center':'Earth center'}: ${visibility[key]?(framed[key]?'visible':'visible · outside view'):states[key]==='blocked'?(key==='sun'?'unavailable':'terrain-blocked'):states[key]==='uncertain'?'unresolved · withheld':'no verified geometry'}`;
      bodyStatus.append(label);
    }
    bodyStatus.hidden=mode!=='surface';
  }
  function updateFrame() {
    const show=renderedBodies(sample,states);
    sun.visible=!lost&&!disposed&&mode==='surface'&&show.sun;
    earth.visible=!lost&&!disposed&&mode==='surface'&&show.earth&&earthTextureLoaded;
    container.dataset.sunRendered=String(sun.visible);container.dataset.earthRendered=String(earth.visible);
    for(const [key,object,az,el] of [['sun',sun,1,2],['earth',earth,4,5]]) {
      const direction=bodyDirection(sample?.[az],sample?.[el]);
      if(direction)object.position.copy(surfaceCamera.position).addScaledVector(new THREE.Vector3(...direction),skyDistance);
      container.dataset[`${key}Direction`]=direction?direction.map(v=>v.toFixed(8)).join(','):'';
      container.dataset[`${key}Azimuth`]=Number.isFinite(sample?.[az])?String(sample[az]):'';
      container.dataset[`${key}Elevation`]=Number.isFinite(sample?.[el])?String(sample[el]):'';
      const framing=viewInfo(direction);
      container.dataset[`${key}InFrustum`]=String(framing.inFrustum);
      container.dataset[`${key}ProjectedBearing`]=framing.projectedBearingDeg===null?'':String(framing.projectedBearingDeg);
    }
    const sunDirection=bodyDirection(sample?.[1],sample?.[2]);
    sunlight.intensity=!lost&&!disposed&&sunDirection&&states.sun==='visible'?3.2:0;
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
    if(needsRender||flight) {
      renderer.render(mode==='orbital'?orbitalScene:surfaceScene,mode==='orbital'?orbitalCamera:surfaceCamera);
      needsRender=false;
      if(mode==='orbital') {
        const marker=markers.find(item=>item.site.id===site.id);
        projected.copy(marker.group.position).project(orbitalCamera);
        const facing=marker.group.position.dot(orbitalCamera.position.clone().sub(marker.group.position))>0;
        markerLabel.hidden=!facing||Math.abs(projected.x)>1||Math.abs(projected.y)>1||projected.z>1;
        markerLabel.style.left=`${(projected.x*.5+.5)*100}%`;markerLabel.style.top=`${(-projected.y*.5+.5)*100}%`;
      } else markerLabel.hidden=true;
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
        const material=track(new THREE.MeshStandardMaterial({color:0x898782,roughness:1,metalness:0,side:THREE.FrontSide}));
        cached={mesh:new THREE.Mesh(geometry,material),record};cached.mesh.castShadow=cached.mesh.receiveShadow=true;
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
    // Retain enough equator in view to recognize the Moon, while exposing its south pole.
    const direction=selected.clone().add(new THREE.Vector3(.22,.5,.4)).normalize();
    const to=direction.multiplyScalar(orbitalOverviewDistance(container.clientWidth,container.clientHeight));
    if(reducedMotion){orbitalCamera.position.copy(to);orbitalCamera.lookAt(0,0,0);onComplete?.();}
    else flight={from:orbitalCamera.position.clone(),to,start:performance.now(),duration,onComplete};
    invalidate();
  }
  function selectSite(siteId,{focus:shouldFocus=true}={}) {
    const next=bundle.sites.find(point=>point.id===siteId);if(!next)return false;
    const changed=site.id!==next.id;site=next;terrainBearingDeg=terrainFocusBearing(site);container.dataset.site=site.id;
    if(changed){sample=null;states={};container.dataset.frame='';}
    if(changed&&mode==='surface'){yaw=terrainBearingDeg*RAD;pitch=-5*RAD;surfaceFov=65;surfaceFocus='terrain';updateFarHorizon();}
    updateMarkers();setSurfaceLook();updateFrame();
    if(mode==='surface'&&changed)void loadTerrain();
    if(mode==='orbital'&&shouldFocus)focusSite(pendingMode==='surface'?520:900,pendingMode==='surface'?()=>commitMode('surface'):null);return true;
  }
  function commitMode(next) {
    pendingMode=null;
    mode=next;flight=null;controls.enabled=mode==='orbital';container.dataset.mode=mode;
    if(!reducedMotion&&typeof canvas.animate==='function')canvas.animate([{opacity:.15},{opacity:1}],{duration:420,easing:'ease-out'});
    canvas.setAttribute('aria-label',mode==='orbital'?'Interactive Moon. Drag or use arrow keys to rotate; scroll, pinch, plus and minus zoom.'
      :'Lunar surface at the recorded observer height. Drag or use arrow keys to look around; scroll, pinch, plus and minus change field of view.');
    if(mode==='surface') {
      yaw=terrainBearingDeg*RAD;pitch=-5*RAD;surfaceFov=65;surfaceFocus='terrain';
      setSurfaceLook();updateFarHorizon();void loadTerrain();earthTexturePromise??=texture('earth-color.jpg',earthMaterial,'map','earth');
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
    yaw=sample[az]*RAD;pitch=sample[el]*RAD;surfaceFov=target==='earth'?10:28;surfaceFocus=target;
    setSurfaceLook();updateFrame();
  }
  function focus(target) {
    if(target==='overview') {
      setMode('orbital');
      const from=orbitalCamera.position.clone(),to=new THREE.Vector3(...orbitalOverviewPosition(container.clientWidth,container.clientHeight));
      // Clear orbit inertia before restoring the overview, without a visible jump.
      const damping=controls.enableDamping;controls.enableDamping=false;controls.update();controls.enableDamping=damping;
      orbitalCamera.position.copy(from);orbitalCamera.lookAt(0,0,0);
      if(reducedMotion){orbitalCamera.position.copy(to);orbitalCamera.lookAt(0,0,0);}
      else flight={from,to,start:performance.now(),duration:700,fromDirection:from.clone().normalize(),
        fromRadius:from.length(),toRadius:to.length(),rotation:new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(),to.clone().normalize())};
      invalidate();return;
    }
    if(target==='site') {
      pendingFocus=null;
      if(mode==='orbital')focusSite();else {yaw=terrainBearingDeg*RAD;surfaceFov=65;pitch=-5*RAD;surfaceFocus='terrain';setSurfaceLook();updateFrame();}return;
    }
    if(!['earth','sun'].includes(target))return;
    if(mode!=='surface'){pendingFocus=target;setMode('surface');return;}
    focusBody(target);
  }
  function resize() {
    if(disposed)return;
    const width=Math.max(1,container.clientWidth),height=Math.max(1,container.clientHeight);
    renderer.setSize(width,height,false);
    if(!flight)orbitalCamera.position.setLength(orbitalOverviewDistance(width,height));
    for(const camera of [orbitalCamera,surfaceCamera]){camera.aspect=width/height;camera.updateProjectionMatrix();}
    orbitalCamera.clearViewOffset();
    invalidate();
  }
  function inspect() {
    const bodyInfo=(object,key,az,el)=>{
      const direction=bodyDirection(sample?.[az],sample?.[el]),framing=viewInfo(direction);
      return {visible:object.visible,position:object.position.toArray(),direction,azimuth:sample?.[az]??null,elevation:sample?.[el]??null,state:states[key]??'unknown',
        ...framing,renderedInFrustum:object.visible&&framing.inFrustum};
    };
    return {mode,siteId:site.id,time:sample?.[0]??null,webgl:disposed?'disposed':lost?'lost':'ready',
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
        material:earthMaterial.type,unlit:earthMaterial.isMeshBasicMaterial===true,geographicFaceRegistered:false,timeMatchedPhase:false,
        disclosure:'Historical Blue Marble composite with baked shading; geographic face, weather and phase are not registered to the selected UTC.'},
      displayLighting:{ambientIntensity:floorLight.intensity,shadowsLocalHalfExtentM:350,proceduralMaterialGrain:false,
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
      if(hit&&(!moonHit||hit.distance<moonHit.distance)){selectSite(hit.object.userData.siteId);onSiteSelect(hit.object.userData.siteId);}
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
    if(mode==='surface') {
      if(event.key==='ArrowLeft')yaw-=step;if(event.key==='ArrowRight')yaw+=step;
      if(event.key==='ArrowUp')pitch+=step;if(event.key==='ArrowDown')pitch-=step;
      pitch=clamp(pitch,-85*RAD,85*RAD);
      if(['+','='].includes(event.key))surfaceFov=clamp(surfaceFov-3,8,85);
      if(['-','_'].includes(event.key))surfaceFov=clamp(surfaceFov+3,8,85);
      setSurfaceLook();updateFrame();
    } else {
      const offset=orbitalCamera.position.clone().sub(controls.target),spherical=new THREE.Spherical().setFromVector3(offset);
      if(event.key==='ArrowLeft')spherical.theta-=step;if(event.key==='ArrowRight')spherical.theta+=step;
      if(event.key==='ArrowUp')spherical.phi-=step;if(event.key==='ArrowDown')spherical.phi+=step;
      spherical.makeSafe();if(['+','='].includes(event.key))spherical.radius*=.9;if(['-','_'].includes(event.key))spherical.radius*=1.1;
      spherical.radius=clamp(spherical.radius,controls.minDistance,controls.maxDistance);orbitalCamera.position.setFromSpherical(spherical).add(controls.target);controls.update();invalidate();
    }
  });
  listen(canvas,'webglcontextlost',event=>{
    event.preventDefault();lost=true;cancelAnimationFrame(raf);raf=0;
    sun.visible=earth.visible=false;container.dataset.sunRendered=container.dataset.earthRendered='false';
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
    canvas.remove();caption.remove();bodyStatus.remove();markerLabel.remove();
    container.dataset.webgl=container.dataset.webglStatus='disposed';
    container.dataset.sunRendered=container.dataset.earthRendered='false';
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
  return {selectSite,setMode,setFrame,focus,resize,dispose,inspect,loadHighDetail};
}
