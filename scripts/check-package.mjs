import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

if (!process.env.npm_execpath) throw new Error('Run this check with npm run check:package.');
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr || 'npm pack validation failed.');
const [packed] = JSON.parse(result.stdout);
const paths = packed.files.map(file => file.path);
const documents = ['package.json','cordis.patch.yml','README.md','AGENTS.md','ARCHITECTURE.md','COMPATIBILITY.md','CONTRIBUTING.md','CHANGELOG.md','TESTING.md','LICENSE'];
for (const path of paths) {
  assert.ok(documents.includes(path) || ['src/','skills/','examples/'].some(root => path.startsWith(root)), `Unexpected packed path: ${path}`);
  assert.ok(!/(?:^|\/)(?:\.local|node_modules|\.env)(?:\/|$)|\.local(?:\.|$)|\.auth\.json$|\.tgz$/.test(path), `Private packed path: ${path}`);
}
for (const path of ['src/index.js','src/skill.js','skills/dsh-remote-control/SKILL.md','cordis.patch.yml']) assert.ok(paths.includes(path), `Missing runtime resource: ${path}`);
const manifest = JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
assert.equal(packed.version, manifest.version);
for (const hook of ['prepare','prepack','install','postinstall','preinstall']) assert.equal(manifest.scripts?.[hook], undefined, `Installation must not require lifecycle script: ${hook}`);
console.log(`Validated package ${packed.name}@${packed.version}: ${paths.length} runtime/document files; bundled Skill included.`);
