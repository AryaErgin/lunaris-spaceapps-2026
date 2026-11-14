// Presentation only: statuses, metrics, bounds and witnesses belong to the engine.
const rules={
  max_sun_block:{title:'Longest sunlight outage',channel:'sun',sense:'≤',
    reason:'The low polar Sun moves against the local terrain skyline. Qualified sunlight needs its center clear of terrain and outside Earth’s apparent disc.'},
  max_earth_block:{title:'Longest Earth blockage',channel:'earth',sense:'≤',
    reason:'Earth’s direction changes relative to the local terrain horizon. A ridge can interrupt the geometric line to Earth’s center.'},
  min_joint_total:{title:'Total Sun + Earth time',channel:'joint',sense:'≥',
    reason:'Both visibility conditions must hold at once. Losing either removes joint operating time.'},
  min_joint_continuous:{title:'Uninterrupted Sun + Earth',channel:'joint',sense:'≥',
    reason:'A continuous window must remain open without a break in either visibility condition.'},
};

export function evidenceTime(value,signed=false){
  if(!Number.isFinite(value))return 'Unresolved';
  const raw=Math.abs(value)*3600,seconds=Math.round(raw*1000)/1000;
  const h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=Number((seconds%60).toFixed(3));
  const parts=[];
  if(h)parts.push(`${h} h`);
  if(m)parts.push(`${h?String(m).padStart(2,'0'):m} m`);
  if(s)parts.push(`${h||m?String(s).padStart(2,'0'):s} s`);
  const sign=value<0?'−':signed&&value>0?'+':'';
  return `${Math.abs(raw-seconds)>1e-7?'≈ ':''}${sign}${parts.join(' ')||'0 h'}`;
}
function bound(value,range){
  if(!range||range[0]===range[1])return '';
  return Math.abs(value-range[0])<1e-9?'≥ ':Math.abs(value-range[1])<1e-9?'≤ ':'';
}
export function constraintEvidence(item){
  const rule=rules[item.id]??{title:item.id,channel:'joint',sense:'',reason:'Inspect the declared model requirement.'};
  return {...rule,id:item.id,status:item.status,
    requirementText:`${rule.sense} ${evidenceTime(item.threshold)}`.trim(),
    metricText:bound(item.metric,item.range)+evidenceTime(item.metric),
    marginText:bound(item.margin,item.marginRange)+evidenceTime(item.margin,true),
    rangeText:item.range?.map(v=>evidenceTime(v)).join(' to ')??'Unresolved',
    marginRangeText:item.marginRange?.map(v=>evidenceTime(v,true)).join(' to ')??'Unresolved',
    explanation:item.status==='INDETERMINATE'?'Unresolved: supported bounds or numerical checks cannot prove this rule.'
      :item.status==='FAIL'?'This rule is broken even by the bound most favorable to the mission.'
        :'This rule is proven within the supported model bounds.',
  };
}
export function constraintSegments(item){
  const segments=Array.isArray(item?.witnessSegments)?item.witnessSegments:Array.isArray(item?.witness)?[item.witness]:[];
  return segments.filter(s=>Array.isArray(s)&&s.length===2&&s.every(Number.isFinite)&&s[0]<s[1]).map(s=>s.slice());
}
