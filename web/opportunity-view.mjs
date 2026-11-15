// Presentation helpers only; dates and pagination never evaluate a mission.
function utcValue(value,label){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))throw Error(`Choose a valid ${label} date and time in UTC.`);
  const seconds=Date.parse(`${value}Z`)/1000;
  if(!Number.isFinite(seconds)||new Date(seconds*1000).toISOString().slice(0,value.length)!==value)throw Error(`Choose a valid ${label} date and time in UTC.`);
  return seconds;
}

export function opportunityRange(fromUtc,toUtc,gridMinutes){
  const from=utcValue(fromUtc,'From'),to=utcValue(toUtc,'To'),grid=Number(gridMinutes);
  if(to<from)throw Error('To UTC must be at or after From UTC. Your arrival has not changed.');
  if(!Number.isFinite(grid)||grid<=0)throw Error('Choose a positive search grid in minutes.');
  return {from,to,gridMinutes:grid};
}

export function opportunityPage(total,page=0,size=10){
  if(!Number.isInteger(total)||total<0||!Number.isInteger(size)||size<1)throw Error('Opportunity pagination needs a valid count and page size.');
  const pages=Math.max(1,Math.ceil(total/size)),index=Math.max(0,Math.min(pages-1,Math.floor(Number(page)||0)));
  return {index,pages,size,start:index*size,end:Math.min(total,(index+1)*size),total};
}

export function opportunityRequestInputs(bundle,inputs,range,explicit={}){
  // A stale automatic preset bound is not a user scheduling restriction. These
  // are search-only inputs: the inspected mission and its certificate stay put.
  return {...inputs,gridMinutes:range.gridMinutes,
    earliest:explicit.earliest?inputs.earliest:bundle.coverage[0],
    latest:explicit.latest?inputs.latest:Math.max(bundle.coverage[0],bundle.coverage[1]-inputs.durationHours*3600)};
}
