import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GUIDE_STEPS} from '../web/guide.mjs';

const html = await readFile(new URL('../web/index.html',import.meta.url),'utf8');
const styles = await readFile(new URL('../web/judge.css',import.meta.url),'utf8');

test('optional walkthrough uses four real, discoverable application actions',()=>{
  assert.equal(GUIDE_STEPS.length,4);
  for(const step of GUIDE_STEPS){
    assert(step.title.length>7&&step.description.length>20);
    assert(step.description.length<190,'Do not turn a tour step into a text wall.');
    assert(step.selectors.length>=1);
    for(const selector of step.selectors){
      assert(selector.startsWith('#'),'Tour step must refer to an actual identified control.');
      assert(html.includes('id="'+selector.slice(1)+'"'),selector+' does not exist on the page.');
    }
  }
  assert.deepEqual(GUIDE_STEPS.at(-1).selectors,['#product-compare']);
  assert(!GUIDE_STEPS.some(step=>/PASS|FAIL|NASA-certified/i.test(step.description)));
});

test('tour is explicitly optional and its presentation supports closing and keyboard use',()=>{
  assert.match(html,/id="tour-start"[^>]*>Show me how/);
  assert.match(html,/src="\.\/guide\.mjs"/);
  assert.match(html,/href="\.\/judge\.css"/);
  assert.match(styles,/quick-tour\[hidden\]/);
  assert.match(styles,/quick-tour-target/);
  assert.match(styles,/prefers-reduced-motion/);
});

test('important comparison result precedes the individual option cards',()=>{
  assert(html.indexOf('id="comparison-difference"')<html.indexOf('id="option-comparison"'));
  assert.match(html,/Choose a place and time on the Moon/);
});
