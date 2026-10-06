// Read-only schema validation against an explicit installed/source DSH checkout.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createToolDefinitions } from '../src/index.js';
import * as bundledSkill from '../src/skill.js';
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/verify-host-contract.mjs <DSH source root>');
const { assertSupportedJsonSchema } = await import(pathToFileURL(resolve(source, 'packages/core/tools/lib/types/json-schema.js')));
const tools = createToolDefinitions({ call() {} });
for (const tool of tools) { assertSupportedJsonSchema(tool.parameters); assertSupportedJsonSchema(tool.output.schema); }
const required = {
  'session/create': ['request'], 'session/list': ['_request'], 'session/prompt': ['request'],
  'session/follow': ['request'], 'session/projections': ['request'], 'session/page': ['request'],
  'session/cancel': ['request'], 'session/modelCatalog': [], 'session/selectModel': ['request'],
  'workspace/follow': [], 'workspace/create': ['request'], 'agentPresets/list': [],
  'userQuestions/answer': ['agentId', 'callId', 'answer'], 'userQuestions/attachWait': ['agentId', 'callId'],
  'session/rename': ['request'], 'session/search': ['request'], 'permissionPresets/catalog': [],
  'commands/execute': ['agentId', 'line', 'submittedAttachments'],
};
const found = new Map();
for (const pkg of ['api/session-controller', 'api/workspace-controller', 'preset/agent-preset-registry', 'interaction/user-questions', 'interaction/permission-presets', 'interaction/commands']) {
  const { TYPERT_REMOTE } = await import(pathToFileURL(resolve(source, `packages/${pkg}/lib/typert.remote-client.js`)));
  for (const descriptor of TYPERT_REMOTE.descriptors) found.set(`${descriptor.namespace}/${descriptor.method}`, descriptor.parameters.map(p => p.wire));
}
for (const [endpoint, args] of Object.entries(required)) assert.deepEqual(found.get(endpoint), args, endpoint);
// Exercise discovery/load/disposal through the real installed SkillRegistry.
const { default: SkillRegistry } = await import(pathToFileURL(resolve(source, 'packages/skill/skill/lib/index.js')));
const { createRequire } = await import('node:module');
const hostRequire = createRequire(resolve(source, 'packages/skill/skill/package.json'));
const { Context } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')));
const ctx = new Context();
const serviceFiber = await ctx.plugin(SkillRegistry);
let skillFiber;
try {
  const registry = ctx.get('skills');
  skillFiber = await ctx.plugin(bundledSkill);
  const summaries = await registry.list();
  const summary = summaries.find(skill => skill.name === 'dsh-remote-control');
  assert.ok(summary, 'Bundled Skill must be discoverable.');
  assert.equal(summary.content, undefined);
  assert.ok((await registry.get(summary.name)).content.startsWith('# 使用另一个 DSH'));
  await skillFiber.dispose();
  assert.equal((await registry.list()).some(skill => skill.name === summary.name), false);
} finally { await skillFiber?.dispose(); await serviceFiber.dispose(); }
console.log(`Validated ${tools.length} tool schemas, ${Object.keys(required).length} DSH Remote signatures, and bundled Skill discovery/load/disposal.`);
