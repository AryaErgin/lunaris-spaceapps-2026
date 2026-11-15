// Hypothetical arrival at the displayed UTC, not a change to the saved mission.
// Every supported verdict is delegated to the existing authoritative evaluator.
import {evaluateStart} from './engine.mjs';
import {evidenceTime} from './decision-evidence.mjs';

const CACHE_LIMIT=512;
const INPUT_FIELDS=['siteId','nominal','durationHours','delayHours','maxSunHours','maxEarthHours',
  'minJointHours','minContinuousJointHours','earliest','latest','gridMinutes','mode'];

function freezeTree(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function ruleText(rule){
  const metric=evidenceTime(rule.metric),threshold=evidenceTime(rule.threshold);
  const bounded=rule.range&&rule.range[0]!==rule.range[1];
  const maximumPrefix=bounded?(rule.status==='PASS'?'at most ':'at least '):'';
  if(rule.id==='max_sun_block')return `Sun-center unavailable for ${maximumPrefix}${metric}; limit ${threshold}.`;
  if(rule.id==='max_earth_block')return `Earth-center blocked for ${maximumPrefix}${metric}; limit ${threshold}.`;
  const minimumPrefix=bounded&&rule.status==='FAIL'?'At most ':bounded?'At least ':'';
  if(rule.id==='min_joint_total')return `${minimumPrefix}${metric} Sun + Earth time; minimum ${threshold}.`;
  if(rule.id==='min_joint_continuous')return `${minimumPrefix}${metric} continuous Sun + Earth time; minimum ${threshold}.`;
  return 'Inspect the selected requirement and its calculated bounds.';
}

function evaluateDisplayedArrival(bundle,inputs,siteId,time,requirementsApplied){
  const durationHours=inputs?.durationHours,end=time+durationHours*3600;
  const coverage=bundle?.coverage;
  const validTime=Number.isFinite(time)&&Number.isFinite(new Date(time*1000).getTime());
  const validDuration=Number.isFinite(durationHours)&&durationHours>0&&Number.isFinite(end)&&end>time&&Number.isFinite(new Date(end*1000).getTime());
  const rangeCovered=validTime&&validDuration&&Array.isArray(coverage)&&coverage.length===2&&coverage.every(Number.isFinite)&&coverage[0]<coverage[1]&&time>=coverage[0]&&end<=coverage[1];
  const supportedSite=Boolean(bundle?.sites?.some(site=>site.id===siteId));
  const scheduleExcluded=validTime&&Number.isFinite(inputs?.earliest)&&Number.isFinite(inputs?.latest)&&(time<inputs.earliest||time>inputs.latest);
  const base={kind:'hypothetical-arrival',time,end,siteId,durationHours,requirementsApplied,
    scheduleExcluded,coverageComplete:Boolean(rangeCovered&&supportedSite),inCoverageRange:Boolean(rangeCovered),supportedSite};
  if(!requirementsApplied)return {...base,status:null,label:'Requirements not applied',reason:'Requirements not applied.',reasonCode:'NOT_APPLIED'};
  const unknown=(reason,reasonCode)=>({...base,status:'INDETERMINATE',label:'INDETERMINATE',reason,reasonCode,coverageComplete:false});
  if(!validTime)return unknown('Choose a valid displayed UTC time.','INVALID_TIME');
  if(!validDuration)return unknown('A valid positive duration is required for this arrival assessment.','INVALID_DURATION');
  if(!supportedSite)return unknown('This location has no terrain-aware visibility data.','UNSUPPORTED_SITE');
  if(!rangeCovered)return unknown('The full mission at this UTC is outside validated data coverage.','INCOMPLETE_COVERAGE');
  try{
    const decision=evaluateStart(bundle,inputs,siteId,time);
    const dataGap=['sun','earth'].some(channel=>decision.timeline[channel].some(([, ,state])=>state==='unknown'));
    const common={...base,decision,coverageComplete:!dataGap};
    if(scheduleExcluded)return {...common,status:decision.status,label:'Outside allowed schedule',reason:'This arrival is outside your allowed start schedule.',reasonCode:'SCHEDULE_EXCLUDED'};
    const candidates=decision.constraints.filter(rule=>rule.status===decision.status);
    const limitingConstraint=decision.status==='PASS'
      ?[...candidates].sort((a,b)=>(a.marginRange?.[0]??Infinity)-(b.marginRange?.[0]??Infinity))[0]
      :candidates[0];
    let reason;
    if(decision.status==='PASS')reason=`All ${decision.constraints.length} requirements pass. ${limitingConstraint?ruleText(limitingConstraint):''}`.trim();
    else if(decision.status==='FAIL')reason=limitingConstraint?ruleText(limitingConstraint):'A selected requirement fails at this arrival.';
    else reason=dataGap?'Sun or Earth visibility evidence is incomplete for this mission.'
      :limitingConstraint?'Unresolved visibility bounds prevent confirming a selected requirement.'
        :'Numerical refinements do not establish a mission verdict at this arrival.';
    return {...common,status:decision.status,label:decision.status,reason,limitingConstraint,
      reasonCode:decision.status==='PASS'?'REQUIREMENTS_PROVEN':decision.status==='FAIL'?'REQUIREMENT_FAILED':'UNRESOLVED_EVIDENCE'};
  }catch(error){
    return unknown(`Arrival assessment is unresolved: ${error instanceof Error?error.message:'invalid mission or visibility evidence.'}`,'INVALID_EVIDENCE');
  }
}

export function createLandingAssessmentCache(bundle){
  const records=new Map(),identities=new WeakMap();let nextIdentity=1;
  return {
    get size(){return records.size;},
    get limit(){return CACHE_LIMIT;},
    clear(){records.clear();},
    assess(inputs,siteId,time,{requirementsApplied=true}={}){
      const object=inputs&&typeof inputs==='object';
      if(object&&!identities.has(inputs))identities.set(inputs,nextIdentity++);
      // A value fingerprint also protects callers that mutate an existing input
      // object. UTC remains exact: no minute/sample rounding can reuse a verdict.
      const fingerprint=INPUT_FIELDS.map(field=>`${field}:${typeof inputs?.[field]}:${String(inputs?.[field])}`).join('|');
      const key=JSON.stringify([object?identities.get(inputs):null,fingerprint,siteId,String(time),Boolean(requirementsApplied)]);
      if(records.has(key)){
        const cached=records.get(key);records.delete(key);records.set(key,cached);return cached;
      }
      const result=freezeTree(structuredClone(evaluateDisplayedArrival(bundle,inputs,siteId,time,Boolean(requirementsApplied))));
      records.set(key,result);
      if(records.size>CACHE_LIMIT)records.delete(records.keys().next().value);
      return result;
    },
  };
}
