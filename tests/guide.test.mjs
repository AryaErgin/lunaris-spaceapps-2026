import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GUIDE_STEPS} from '../web/guide.mjs';

const html = await readFile(new URL('../web/index.html',import.meta.url),'utf8');
const styles = await readFile(new URL('../web/judge.css',import.meta.url),'utf8');
const guideSource = await readFile(new URL('../web/guide.mjs',import.meta.url),'utf8');

test('first-visit guide covers the real lunar mission lifecycle and its limits',()=>{
  assert.equal(GUIDE_STEPS.length,11);
  assert(GUIDE_STEPS.some(step=>/level horizon/i.test(step.description)));
  assert(GUIDE_STEPS.some(step=>/72-hour/.test(step.description)));
  assert(GUIDE_STEPS.some(step=>/uncertain/i.test(step.description)));
  assert(GUIDE_STEPS.some(step=>/radio link/i.test(step.description)));
  for(const step of GUIDE_STEPS){
    assert(step.title.length>7&&step.description.length>20);
    assert(step.description.length<260,'Do not turn a tour step into a text wall.');
    assert(step.selectors.length>=1);
    for(const selector of step.selectors){
      assert(selector.startsWith('#'),'Tour step must refer to an actual identified control.');
      assert(html.includes('id="'+selector.slice(1)+'"')||/^#comparison-(site|arrival)-[AB]$/.test(selector)&&html.includes('id="option-comparison"'),selector+' does not exist on the page or the generated comparison controls.');
    }
  }
  assert.equal(GUIDE_STEPS.filter(s=>s.workspace==='compare').length,1);
  assert(GUIDE_STEPS.at(-1).selectors.includes('#product-analyst'));
  assert(!GUIDE_STEPS.some(step=>/NASA-certified/i.test(step.description)));
});

test('tour auto-opens on first visit but remains skippable, replayable and keyboard accessible',()=>{
  assert.match(html,/id="tour-start"[^>]*>Show me how/);
  assert.match(html,/src="\.\/guide\.mjs"/);
  assert.match(html,/href="\.\/judge\.css"/);
  assert.match(styles,/quick-tour\[hidden\]/);
  assert.match(styles,/quick-tour-target/);
  assert.match(styles,/prefers-reduced-motion/);
  assert.match(guideSource,/localStorage\.getItem\(SEEN_KEY\)/);
  assert.match(guideSource,/localStorage\.setItem\(SEEN_KEY,'seen'\)/);
  assert.match(guideSource,/if\(autoPending&&ready\)/);
  assert.match(guideSource,/e\.key==='Escape'/);
});

test('important comparison result precedes the individual option cards',()=>{
  assert(html.indexOf('id="comparison-difference"')<html.indexOf('id="option-comparison"'));
  assert.match(html,/Explore the Moon\. Find a landing window\./);
});
