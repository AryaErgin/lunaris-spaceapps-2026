// Presentation only. Consume conservative engine metrics; never classify a mission.
export function conciseDuration(seconds){
  if(seconds>0&&seconds<1)return '<1 s';
  const value=Math.floor(seconds),h=Math.floor(value/3600),m=Math.floor(value%3600/60),s=value%60;
  return [h?`${h} h`:'',m?`${m} min`:'',s?`${s} s`:''].filter(Boolean).join(' ')||'0 h';
}

export function visibilityConclusion(metrics,duration,{complete=true}={}){
  if(!complete)return {headline:'This view extends beyond the available data',reason:'Choose an arrival and duration inside the November coverage. Missing time is not evidence of favorable or unfavorable conditions.'};
  const [lo,hi]=metrics.joint.visibleRangeSeconds;
  const earth=metrics.earth.longestBlockedRangeSeconds[0],sun=metrics.sun.longestBlockedRangeSeconds[0];
  const reason=earth>=duration?'Earth is blocked by terrain for the full view.'
    :sun>=duration?'Sun-center visibility is unavailable for the full view.'
      :earth>0?`Earth is hidden by terrain for at least ${conciseDuration(earth)} at a time.`
        :sun>0?`Sun-center visibility is interrupted for at least ${conciseDuration(sun)} at a time.`
          :hi>lo?'Some time remains unresolved. Open the durations to see the bounds.':'Their visibility windows do not overlap throughout the whole view.';
  if(lo>=duration)return {headline:`Sun and Earth visible together for all ${conciseDuration(duration)}`,reason:'Both center-visibility conditions hold throughout this modeled view.'};
  if(lo>0)return {headline:`At least ${conciseDuration(lo)} with Sun and Earth together`,reason};
  if(hi>0)return {headline:'Simultaneous visibility is not confirmed',reason:`Unresolved intervals may allow up to ${conciseDuration(Math.ceil(hi))} together. The data do not establish that opportunity.`};
  return {headline:'No simultaneous Sun and Earth visibility in this view',reason};
}

export function comparisonConclusion(options,expectedCount=options.length){
  if(options.length!==expectedCount||options.some(o=>!o.complete))return 'Comparison incomplete. Choose valid arrivals with complete cached coverage for every option.';
  const sorted=[...options].sort((a,b)=>b.metrics.joint.visibleRangeSeconds[0]-a.metrics.joint.visibleRangeSeconds[0]);
  const best=sorted[0],others=sorted.slice(1),[lo,hi]=best.metrics.joint.visibleRangeSeconds;
  const uniqueSiteNames=new Set(options.map(o=>o.name).filter(Boolean)).size===options.length;
  const label=o=>uniqueSiteNames&&o.name?o.name:'Option '+o.key;
  if(lo===0)return options.some(o=>o.metrics.joint.visibleRangeSeconds[1]>0)
    ?'No option has confirmed simultaneous visibility. Unresolved time prevents a conclusive comparison.'
    :'No option has simultaneous Sun and Earth visibility in this modeled view.';
  const tied=others.filter(o=>o.metrics.joint.visibleRangeSeconds[0]===lo);
  if(tied.length===others.length)return `These options have the same confirmed simultaneous time: ${conciseDuration(lo)}. ${options.some(o=>o.metrics.joint.visibleRangeSeconds[1]>lo)?'Unresolved time may change their actual totals.':'Their timing and interruptions may still differ.'}`;
  const leaders=[best,...tied].map(label).join(' and '),less=others.filter(o=>o.metrics.joint.visibleRangeSeconds[0]<lo);
  const difference=less.map(o=>`${conciseDuration(lo-o.metrics.joint.visibleRangeSeconds[0])} more confirmed simultaneous visibility than ${label(o)}`).join('; ');
  const overlap=less.some(o=>lo<=o.metrics.joint.visibleRangeSeconds[1]);
  return `${leaders} ${tied.length?'provide':'provides'} ${difference}. ${overlap?'The ranges overlap, so the actual total ordering remains unresolved.':'This difference is resolved within the modeled bounds.'}`;
}

export function opportunityConclusion(report,siteName){
  if(report.kind==='NO_DATA')return 'No complete view fits the available November data. Choose a covered arrival or a shorter duration.';
  if(report.kind==='SCHEDULE_EMPTY')return 'No eligible start fits your allowed schedule. Edit the allowed dates to search further.';
  if(report.kind==='UNRESOLVED')return 'The data do not establish simultaneous visibility on this grid. Possible opportunities remain unresolved.';
  if(report.kind==='NO_JOINT')return 'No simultaneous Sun and Earth visibility occurs in the checked views.';
  const duration=report.requested.durationHours*3600,full=report.options.filter(o=>o.metrics.joint.visibleRangeSeconds[0]>=duration);
  const best=report.options[0];
  if(full.length){
    const earliest=[...full].sort((a,b)=>a.start-b.start)[0];
    return `${full.length===1?'1 site offers':`${full.length} sites offer`} ${conciseDuration(duration)} of confirmed simultaneous visibility. ${siteName(earliest.siteId)} reaches this full window earliest on the checked grid.`;
  }
  return `The largest confirmed overlap found is ${conciseDuration(best.metrics.joint.visibleRangeSeconds[0])} at ${siteName(best.siteId)}. Unresolved time may change the overall ordering.`;
}

/* The first screen needs one readable conclusion. Full precision remains in the
   expandable measurements and exported evidence. Never round a lower bound up. */
export function firstScreenConclusion(metrics,duration,{complete=true}={}){
  if(!complete)return {headline:'Outside the available dates',reason:'Choose a covered arrival or a shorter viewing period.'};
  const [lower,upper]=metrics.joint.visibleRangeSeconds;
  if(lower>=duration)return {headline:conciseDuration(duration)+' together',reason:'Sun and Earth are visible together throughout your selected period.'};
  if(lower>0){
    const minutes=Math.floor(lower/60);
    const short=minutes>=60?Math.floor(minutes/60)+' h '+(minutes%60?minutes%60+' min':''):minutes?minutes+' min':conciseDuration(lower);
    return {headline:'At least '+short.trim(),reason:'Confirmed time when both Sun and Earth can be seen. More time may be possible.'};
  }
  if(upper>0)return {headline:'Visibility is uncertain',reason:'No simultaneous Sun and Earth time is confirmed. Some time may still be possible.'};
  const detail=visibilityConclusion(metrics,duration,{complete:true});
  return {headline:'No Sun + Earth overlap',reason:detail.reason};
}
