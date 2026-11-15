// Display-only registration helpers. No visibility or mission decisions live here.
const RAD=Math.PI/180,RADIUS=1737400;
export function surfaceUVs(site,positions,bounds){
  if(![site?.lat,site?.lon,site?.groundM].every(Number.isFinite)||Math.abs(site.lat)>90)throw Error('A finite lunar observer is required.');
  if(!Array.isArray(bounds)||bounds.length!==4||!bounds.every(Number.isFinite)||bounds[2]<=bounds[0]||bounds[3]<=bounds[1])throw Error('Invalid photographic bounds.');
  if(!positions||positions.length%3)throw Error('Finite XYZ positions are required.');
  const phi=site.lat*RAD,lam=site.lon*RAD,sp=Math.sin(phi),cp=Math.cos(phi),sl=Math.sin(lam),cl=Math.cos(lam),r=RADIUS+site.groundM;
  const uv=new Float32Array(positions.length/3*2),width=bounds[2]-bounds[0],height=bounds[3]-bounds[1];
  for(let i=0,j=0;i<positions.length;i+=3,j+=2){
    const east=positions[i],up=positions[i+1],north=-positions[i+2];
    if(![east,up,north].every(Number.isFinite))throw Error('Surface positions must be finite.');
    const x=cl*cp*(r+up)-sl*east-sp*cl*north;
    const y=sl*cp*(r+up)+cl*east-sp*sl*north;
    const z=sp*(r+up)+cp*north,length=Math.hypot(x,y,z);
    const denominator=length-z;
    if(!(denominator>0))throw Error('Surface projection is outside the south-pole chart.');
    // Spherical south-polar stereographic, 90S/0E, identical to the raster CRS.
    const scale=2*RADIUS/denominator;
    uv[j]=(y*scale-bounds[0])/width;uv[j+1]=(x*scale-bounds[1])/height;
  }
  return uv;
}
export function surfacePhotoLevel(sunState,hasDirection,nightAssist=false){
  // Source brightness is already photographed illumination. Do not multiply it
  // by a second directional Sun term. Darkness still follows authoritative LOS.
  return hasDirection&&sunState==='visible'?1:(nightAssist?.16:0);
}
export function surfaceVisualRecord(manifest,site,binding){
  if(manifest?.schemaVersion!==1)throw Error('Unsupported surface display manifest.');
  if(manifest.analysisBundleSha256!==binding?.bundleFileSha256)throw Error('Surface display bundle identity differs.');
  if(manifest.frame!==binding?.frame)throw Error('Surface display frame differs.');
  const records=manifest.sites??(manifest.site?[manifest]:[]);
  const record=records.find(row=>(row.site?.id??row.siteId)===site.id);
  if(!record)return null;
  if(!['lat','lon','groundM','heightM'].every(key=>record.site?.[key]===site[key]))throw Error('Surface display observer identity differs.');
  return record;
}
