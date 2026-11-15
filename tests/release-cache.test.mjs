import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('entry, onboarding and inspectors resolve one canonical versioned application',()=>{
  const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  const imports=JSON.parse(html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/)[1]).imports;
  const entry=html.match(/<script type="module" src="([^"]*app\.mjs[^"]*)"/)[1];
  assert.equal(imports['./app.mjs'],entry,'bare app imports must reuse the entry, not start a second planner');
  const revision=new URL(entry,'https://example.org/lunaris/').searchParams.get('v');
  assert(revision);
  for(const path of ['./scene3d.mjs','./surface-visuals.mjs']){
    assert.equal(new URL(imports[path],'https://example.org/lunaris/').searchParams.get('v'),revision);
  }
});
