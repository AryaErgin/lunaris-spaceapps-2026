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
const names={max_sun_block:'Sun-center unavailability',max_earth_block:'Earth-center obstruction',
  min_joint_total:'total joint visibility',min_joint_continuous:'continuous joint visibility'};
const n=value=>Number.isFinite(value)?Number(value.toFixed(2)).toString():'unresolved';
export function missionStory(result,phase) {
  const mission=result?.[phase];
  if(!mission)return {status:'UNAVAILABLE',heading:'No recovery established',message:'No sampled passing recovery meets the unchanged limits inside the allowed start range.'};
  const constraint=mission.constraints.find(c=>c.status==='FAIL');
  let message;
  if(constraint)message=`${names[constraint.id]??constraint.id}: ${n(constraint.metric)} h against a ${n(constraint.threshold)} h limit. Signed margin ${n(constraint.margin)} h. The interval below identifies the modeled violation.`;
  else if(mission.status==='INDETERMINATE')message='Coverage or numerical uncertainty prevents a definitive decision. No passing claim is made.';
  else if(mission.status==='FAIL')message=mission.scheduleWarnings?.join(' ')||'This start does not satisfy the mission requirements.';
  else message=phase==='recommended'?(mission.siteId===result.nominal?.siteId?'This same-site sampled start meets the original mission limits. Mission duration and hard constraints are unchanged.'
    :'This sampled start at another site meets the limits in a prelaunch concept study. It does not establish that a launched mission can reach that site.')
    :'This planned start meets the modeled surface-environment limits. Continue to see what a landing delay changes.';
  return {status:mission.status,heading:{nominal:'Your planned landing',delayed:'The landing is delayed',recommended:'A better start, same mission'}[phase],
    message,start:mission.start,end:mission.end,siteId:mission.siteId,constraint:constraint??null,witness:constraint?.witness??null};
}
