// Presentation ranges only. No visibility, terrain or mission classification is computed here.
const monthYear=new Intl.DateTimeFormat('en-GB',{month:'short',year:'numeric',timeZone:'UTC'});
const monthName=new Intl.DateTimeFormat('en-GB',{month:'long',year:'numeric',timeZone:'UTC'});
const shortMonthYear=new Intl.DateTimeFormat('en-GB',{month:'short',year:'2-digit',timeZone:'UTC'});
const shortDay=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',timeZone:'UTC'});

function checkedCoverage(coverage){
  if(!Array.isArray(coverage)||coverage.length!==2||!coverage.every(Number.isFinite)||coverage[1]<=coverage[0])throw Error('A finite positive coverage range is required.');
  return coverage;
}

export function coverageLabel(coverage){
  const [from,to]=checkedCoverage(coverage),first=monthYear.format(from*1000),last=monthYear.format((to-Math.min(1,(to-from)/2))*1000);
  return first===last?first:`${first} – ${last}`;
}

export function isCachedTime(coverage,time){
  const [from,to]=checkedCoverage(coverage);
  return Number.isFinite(time)&&time>=from&&time<to;
}

export function coverageTicks(coverage,count=5){
  const [from,to]=checkedCoverage(coverage);
  if(!Number.isInteger(count)||count<2||count>12)throw Error('Choose between two and twelve axis ticks.');
  const formatter=to-from>62*86400?shortMonthYear:shortDay;
  return Array.from({length:count},(_,index)=>{
    const time=from+(to-from)*index/(count-1);
    return {time,label:formatter.format(time*1000)};
  });
}

export function utcMonthWindow(coverage,instant){
  const [from,to]=checkedCoverage(coverage),last=to-Math.min(1,(to-from)/2);
  const anchor=new Date(Math.max(from,Math.min(last,Number.isFinite(instant)?instant:from))*1000);
  const year=anchor.getUTCFullYear(),month=anchor.getUTCMonth();
  const start=Date.UTC(year,month,1)/1000,end=Date.UTC(year,month+1,1)/1000;
  return {range:[Math.max(from,start),Math.min(to,end)],label:monthName.format(start*1000),
    previous:start>from?Date.UTC(year,month-1,1)/1000:null,next:end<to?end:null};
}

export function searchQualification(search){
  return search?.windowLimited?'Only the displayed search window was checked. Later dates remain unsearched; move the arrival forward to inspect them.':'';
}
