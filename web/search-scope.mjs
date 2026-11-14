// Limit automatic enumeration, without rewriting any mission requirement or schedule.
// Changing arrival explores later opportunities; exported searches retain their scope.
export function automaticSearchOptions(bundle,inputs,days=30){
  if(!Number.isFinite(days)||days<=0)throw Error('Search window must be a positive finite number of days.');
  const from=Math.max(inputs.nominal+inputs.delayHours*3600,inputs.earliest);
  const end=Math.min(inputs.latest,from+days*86400);
  return end<inputs.latest?{searchEnd:end}:{};
}
