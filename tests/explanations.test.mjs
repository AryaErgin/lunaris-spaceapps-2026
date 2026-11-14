import test from 'node:test';
import assert from 'node:assert/strict';
import {visibilityConclusion,comparisonConclusion,opportunityConclusion,firstScreenConclusion} from '../web/explanations.mjs';

const metrics=(joint,sunGap=[0,0],earthGap=[0,0])=>({joint:{visibleRangeSeconds:joint},sun:{longestBlockedRangeSeconds:sunGap},earth:{longestBlockedRangeSeconds:earthGap}});
test('environment conclusions distinguish full, confirmed minimum, unresolved, absent and incomplete evidence',()=>{
  assert.match(visibilityConclusion(metrics([86400,86400]),86400).headline,/all 24 h/);
  assert.match(visibilityConclusion(metrics([28432,43200]),43200).headline,/At least 7 h 53 min 52 s/);
  assert.match(visibilityConclusion(metrics([0,43200]),43200).headline,/not confirmed/);
  assert.match(visibilityConclusion(metrics([0,3600.1]),43200).reason,/up to 1 h 1 s/,'A displayed upper bound must round outward.');
  assert.match(visibilityConclusion(metrics([0,0],[0,0],[43200,43200]),43200).reason,/Earth.*terrain.*full view/);
  assert.match(visibilityConclusion(metrics([0,0],[43200,43200]),43200).reason,/Sun-center.*full view/);
  assert.match(visibilityConclusion(metrics([86400,86400]),86400,{complete:false}).headline,/available data/);
  assert.doesNotMatch(visibilityConclusion(metrics([86399.9,86400]),86400).headline,/all 24/,'Rounding a lower bound must not invent complete coverage.');
});
test('comparison separates confirmed differences, overlapping ranges, ties and incomplete options',()=>{
  const a={key:'A',metrics:metrics([36000,43200]),complete:true},b={key:'B',metrics:metrics([7200,40000]),complete:true};
  assert.match(comparisonConclusion([a,b],2),/confirmed minimum.*8 h/i);
  assert.match(comparisonConclusion([{...a,name:'de Gerlache Rim 1'},{...b,name:'Connecting Ridge'}],2),/de Gerlache Rim 1.*Connecting Ridge/);
  assert.match(comparisonConclusion([a,b],2),/overlap.*unresolved/i);
  assert.match(comparisonConclusion([a,{...b,metrics:metrics([7200,7200])}],2),/at least 8 h more/);
  const separated=comparisonConclusion([a,{...b,metrics:metrics([7200,14400])}],2);
  assert.match(separated,/at least 6 h more/,'Only the lower-minus-upper difference is proven for uncertain totals.');
  assert.doesNotMatch(separated,/8 h more/);
  assert.match(comparisonConclusion([a,{...a,key:'B'}],2),/same confirmed/);
  assert.match(comparisonConclusion([a],2),/incomplete/i);
  assert.match(comparisonConclusion([a,{...b,complete:false}],2),/incomplete/i);
  const zero=[{key:'A',metrics:metrics([0,0]),complete:true},{key:'B',metrics:metrics([0,100]),complete:true}];
  assert.match(comparisonConclusion(zero,2),/No option.*confirmed.*unresolved/i);
  assert.doesNotMatch(comparisonConclusion([a,b],2),/safer|safe landing|\bPASS\b/);
});
test('opportunity headline counts sites with confirmed full-duration overlap rather than candidate statistics',()=>{
  const report={kind:'VISIBILITY_FOUND',requested:{durationHours:24},options:[{siteId:'a',start:1,metrics:metrics([86400,86400])},{siteId:'b',start:2,metrics:metrics([86400,86400])},{siteId:'c',start:3,metrics:metrics([0,86400])}]};
  assert.match(opportunityConclusion(report,id=>({a:'de Gerlache',b:'Connecting Ridge',c:'Shackleton'}[id])),/2 sites.*24 h.*de Gerlache.*earliest/);
  assert.match(opportunityConclusion({...report,kind:'UNRESOLVED'},x=>x),/not confirmed|not establish/);
  assert.match(opportunityConclusion({...report,kind:'NO_DATA'},x=>x),/data|coverage/);
  assert.match(opportunityConclusion({...report,kind:'SCHEDULE_EMPTY'},x=>x),/schedule/);
});

test('first-screen evidence is readable and never rounds up confirmed time',()=>{
  const partial=firstScreenConclusion(metrics([28432,43200]),43200);
  assert.equal(partial.headline,'At least 7 h 53 min');
  assert.match(partial.reason,/Sun and Earth/i);
  assert.equal(firstScreenConclusion(metrics([43200,43200]),43200).headline,'12 h together');
  assert.equal(firstScreenConclusion(metrics([0,43200]),43200).headline,'Visibility is uncertain');
  assert.equal(firstScreenConclusion(metrics([0,0],[0,0],[43200,43200]),43200).headline,'No Sun + Earth overlap');
  assert.equal(firstScreenConclusion(metrics([0,0]),43200,{complete:false}).headline,'Outside the available dates');
  assert.doesNotMatch(firstScreenConclusion(metrics([7200,7200]),43200).reason,/More time may be possible/);
});
