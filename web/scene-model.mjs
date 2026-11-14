// Display-only transforms. The scientific engine and its frozen data are unchanged.
const RAD=Math.PI/180;
export function bodyDirection(azimuthDeg,elevationDeg) {
  if(!Number.isFinite(azimuthDeg)||!Number.isFinite(elevationDeg)||Math.abs(elevationDeg)>90)return null;
  const az=azimuthDeg*RAD,el=elevationDeg*RAD;
  return [Math.cos(el)*Math.sin(az),Math.sin(el),-Math.cos(el)*Math.cos(az)];
}
export function moonPoint(lat,lon,radius=1) {
  if(![lat,lon,radius].every(Number.isFinite)||Math.abs(lat)>90||radius<=0)return null;
  const phi=lat*RAD,lambda=lon*RAD;
  return [radius*Math.cos(phi)*Math.cos(lambda),radius*Math.sin(phi),-radius*Math.cos(phi)*Math.sin(lambda)];
}
function stateAt(timeline,time) {
  return timeline?.find(([a,b])=>a<=time&&time<b)?.[2]??'unknown';
}
export function sceneFrame(site,sample,coverage) {
  const time=sample?.[0],inCache=Number.isFinite(time)&&time>=coverage[0]&&time<coverage[1];
  const states={};
  for(const [key,az,el] of [['sun',1,2],['earth',4,5]]) {
    const levels=[stateAt(site[key],time)];
    if(site.refinementIntervals)for(const level of ['coarse','fine'])levels.push(stateAt(site.refinementIntervals[key]?.[level],time));
    states[key]=!inCache||!bodyDirection(sample?.[az],sample?.[el])||levels.includes('unknown')?'unknown'
      :levels.every(s=>s==='visible')?'visible':levels.every(s=>s==='blocked')?'blocked':'uncertain';
  }
  return {site,sample,states,basis:'Bodies render only on common retained/coarse/fine visible intervals. Display meshes and textures never establish visibility.'};
}
const n=value=>Number.isFinite(value)?Number(value.toFixed(2)).toString():'unresolved';
export function missionStory(result,phase) {
  const mission=result?.[phase];
  if(!mission)return {status:'UNAVAILABLE',heading:'No recovery established',message:'No sampled passing recovery meets the unchanged limits inside the allowed start range.'};
  const constraint=mission.constraints.find(c=>c.status==='FAIL');
  let message;
  if(constraint){
    const metric=n(constraint.metric),limit=n(constraint.threshold);
    if(constraint.id==='max_sun_block')message=`No qualified sunlight for ${metric} hours. Your limit is ${limit} hours. That is ${n(-constraint.margin)} hours too long.`;
    else if(constraint.id==='max_earth_block')message=`Earth is hidden for ${metric} hours. Your limit is ${limit} hours. That is ${n(-constraint.margin)} hours too long.`;
    else if(constraint.id==='min_joint_total')message=`Only ${metric} hours with Sun and Earth together. Your mission needs ${limit} hours.`;
    else if(constraint.id==='min_joint_continuous')message=`The longest uninterrupted Sun-and-Earth window is ${metric} hours. Your mission needs ${limit} hours.`;
    else message=`This arrival breaks a mission requirement. Inspect the decision record for its limit and timing.`;
  }
  else if(mission.status==='INDETERMINATE')message='Coverage or numerical uncertainty prevents a definitive decision. No passing claim is made.';
  else if(mission.status==='FAIL')message=mission.scheduleWarnings?.join(' ')||'This start does not satisfy the mission requirements.';
  else message=phase==='recommended'?(mission.siteId===result.nominal?.siteId?'Land at this same study point later. All original requirements still apply.'
    :'This sampled start at another site meets the limits in a prelaunch concept study. It does not establish that a launched mission can reach that site.')
    :'This arrival meets your sunlight and Earth-visibility requirements. See what happens if landing slips.';
  return {status:mission.status,heading:{nominal:'Original arrival',delayed:'Delayed arrival',recommended:'Next confirmed arrival'}[phase],
    message,start:mission.start,end:mission.end,siteId:mission.siteId,constraint:constraint??null,witness:constraint?.witness??null};
}
