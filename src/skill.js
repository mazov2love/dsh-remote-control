import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const name = 'remote-dsh-control-skill';
export const inject = ['skills'];

const bodyUrl = new URL('../skills/dsh-remote-control/SKILL.md', import.meta.url);
const candidate = {
  name: 'dsh-remote-control',
  description: '使用另一个 DSH 实例。用户要求连接、配置或启动目标 DSH，或需要了解远程会话、发送、状态与增量读取时，加载本 Skill。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: 'remote-dsh-control',
  source: 'bundled',
  rank: 600,
  resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../skills/dsh-remote-control/', import.meta.url)) },
  locator: bodyUrl,
};

/** A separate bundle component: missing Skill services do not disable the tools. */
export function apply(ctx) {
  ctx.skills.registerProvider(() => ({
    name: candidate.provider,
    async list() { return [{ ...candidate, invocation: { ...candidate.invocation }, resourceBase: { ...candidate.resourceBase } }]; },
    async get() {
      const text = await readFile(bodyUrl, 'utf8');
      const content = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
      return { ...candidate, content };
    },
  }));
}
