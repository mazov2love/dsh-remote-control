import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apply } from '../src/skill.js';

test('bundled Skill catalog is compact and the body is available on demand', async () => {
  let provider;
  apply({ skills: { registerProvider(create) { provider = create(); } } });
  const [summary] = await provider.list();
  assert.equal(summary.name, 'dsh-remote-control');
  assert.equal(summary.source, 'bundled');
  assert.equal(summary.content, undefined);
  assert.ok(JSON.stringify(summary).length < 1000);
  const definition = await provider.get(summary);
  assert.ok(definition.content.startsWith('# 使用另一个 DSH'));
  assert.ok(definition.content.includes('config.targets'));
  assert.ok(definition.content.includes('accepted=unknown'));
  assert.equal(definition.resourceBase.kind, 'directory');
  assert.ok(!(await provider.list())[0].content);
});

test('installation includes the Skill component and has no required build lifecycle', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const patch = await readFile(new URL('../cordis.patch.yml',import.meta.url),'utf8');
  assert.equal(manifest.exports['./skill'], './src/skill.js');
  assert.ok(manifest.files.includes('skills'));
  assert.ok(patch.includes("name: '@mazov2love/dsh-remote-control/skill'"));
  assert.equal(manifest.scripts.prepare, undefined);
  assert.equal(manifest.scripts.prepack, undefined);
});
