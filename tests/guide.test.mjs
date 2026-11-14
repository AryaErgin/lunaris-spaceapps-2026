import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as guide from '../web/guide.mjs';
const {GUIDE_STEPS,shouldOfferOnboarding,markOnboardingOffered,ONBOARDING_KEY}=guide;

const html = await readFile(new URL('../web/index.html',import.meta.url),'utf8');
const styles = await readFile(new URL('../web/judge.css',import.meta.url),'utf8');

test('onboarding covers the real workflow with short, discoverable actions',()=>{
  assert.deepEqual(GUIDE_STEPS.map(s=>s.id),['welcome','site','date','views','geometry','playback','visibility','requirements','demo-consent','nominal','delay','recovery','compare','opportunities','locations','advanced','finish']);
  for(const step of GUIDE_STEPS){
    assert(step.title.length>7&&step.description.length>20);
    assert(step.description.length<190,'Do not turn a tour step into a text wall.');
    assert(step.selectors.length>=1);
    for(const selector of step.selectors){
      assert(selector.startsWith('#'),'Tour step must refer to an actual identified control.');
      const id=selector.slice(1).split(/[ .>]/)[0];
      assert(html.includes('id="'+id+'"')||/^comparison-(site|arrival)-[AB]$/.test(id)&&html.includes('id="option-comparison"'),selector+' does not exist on the page or the generated comparison controls.');
    }
  }
  assert.deepEqual(GUIDE_STEPS.find(s=>s.id==='opportunities').selectors,['#find-opportunities']);
  assert(GUIDE_STEPS.find(s=>s.id==='demo-consent').description.includes('permission'));
});

test('first-visit offer is persistent, optional and resilient to blocked storage',()=>{
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  assert.equal(shouldOfferOnboarding(storage),true);markOnboardingOffered(storage);
  assert.equal(shouldOfferOnboarding(storage),false);assert(values.has(ONBOARDING_KEY));
  const blocked={getItem(){throw Error('privacy');},setItem(){throw Error('privacy');}};
  assert.doesNotThrow(()=>markOnboardingOffered(blocked));assert.equal(shouldOfferOnboarding(blocked),false);
});

test('tour replay and its presentation support closing and keyboard use',()=>{
  assert.match(html,/id="tour-start"[^>]*>Show me how/);
  assert.match(html,/src="\.\/guide\.mjs"/);
  assert.match(html,/href="\.\/judge\.css"/);
  assert.match(styles,/quick-tour\[hidden\]/);
  assert.match(styles,/quick-tour-target/);
  assert.match(styles,/prefers-reduced-motion/);
});

test('important comparison result precedes the individual option cards',()=>{
  assert(html.indexOf('id="comparison-difference"')<html.indexOf('id="option-comparison"'));
  assert.match(html,/Explore the Moon\. Find a landing window\./);
});
