import test from 'node:test';
import assert from 'node:assert/strict';

const helpers=await import('../web/coverage.mjs').catch(()=>({}));
const utc=value=>Date.parse(value)/1000;
const annual=[utc('2026-11-01T00:00:00Z'),utc('2028-01-01T00:00:00Z')];

test('coverage labels respect a half-open end and include supported years',()=>{
  assert.equal(typeof helpers.coverageLabel,'function');
  assert.equal(helpers.coverageLabel(annual),'Nov 2026 – Dec 2027');
  assert.equal(helpers.coverageLabel([annual[0],utc('2026-12-01T00:00:00Z')]),'Nov 2026');
  assert.throws(()=>helpers.coverageLabel([2,1]),/coverage/i);
});

test('calendar month windows and navigation are clipped without changing the chosen arrival',()=>{
  assert.equal(typeof helpers.utcMonthWindow,'function');
  const arrival=utc('2027-05-17T03:00:00Z'),month=helpers.utcMonthWindow(annual,arrival);
  assert.equal(month.label,'May 2027');
  assert.deepEqual(month.range,[utc('2027-05-01T00:00:00Z'),utc('2027-06-01T00:00:00Z')]);
  assert.equal(month.previous,utc('2027-04-01T00:00:00Z'));
  assert.equal(month.next,utc('2027-06-01T00:00:00Z'));
  assert.equal(helpers.utcMonthWindow(annual,annual[0]).previous,null);
  const last=helpers.utcMonthWindow(annual,annual[1]);
  assert.equal(last.label,'December 2027');assert.equal(last.next,null);
  assert.equal(arrival,utc('2027-05-17T03:00:00Z'));
  const partial=helpers.utcMonthWindow([arrival,utc('2027-06-04T00:00:00Z')],arrival);
  assert.deepEqual(partial.range,[arrival,utc('2027-06-01T00:00:00Z')]);
});

test('level-horizon axis ticks derive from the actual range and remain chronological',()=>{
  assert.equal(typeof helpers.coverageTicks,'function');
  const ticks=helpers.coverageTicks(annual);
  assert.equal(ticks.length,5);assert.equal(ticks[0].time,annual[0]);assert.equal(ticks.at(-1).time,annual[1]);
  assert.match(ticks[0].label,/Nov.*26/);assert.match(ticks.at(-1).label,/Jan.*28/);
  assert(ticks.every((tick,index)=>!index||tick.time>ticks[index-1].time));
  assert.throws(()=>helpers.coverageTicks(annual,1),/tick/i);
});

test('a limited search is explicitly qualified rather than described as a complete-year result',()=>{
  assert.equal(typeof helpers.searchQualification,'function');
  assert.equal(helpers.searchQualification({windowLimited:false}),'');
  assert.match(helpers.searchQualification({windowLimited:true}),/later dates.*unsearched/i);
});

test('instantaneous views reject dates outside half-open cached coverage instead of clamping to an endpoint',()=>{
  assert.equal(typeof helpers.isCachedTime,'function');
  assert.equal(helpers.isCachedTime(annual,annual[0]),true);
  assert.equal(helpers.isCachedTime(annual,annual[1]-1),true);
  for(const time of [annual[0]-1,annual[1],annual[1]+86400,NaN])assert.equal(helpers.isCachedTime(annual,time),false);
});
