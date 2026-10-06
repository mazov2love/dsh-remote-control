import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const empty = () => ({ version: 1, refs: {}, sessions: {}, results: {} });
export const sessionKey = (instance, origin, sessionId) => JSON.stringify([instance, origin, sessionId]);

/** Atomic local state, serialized across calls and cooperating plugin processes. */
export class LocalStore {
  constructor(path) { this.path = path; this.tail = Promise.resolve(); }
  async read() {
    try {
      const state = JSON.parse((await readFile(this.path, 'utf8')).replace(/^\uFEFF/, ''));
      if (state.version !== 1 || !state.refs || !state.sessions || !state.results) throw new Error('Invalid remote-control state format.');
      return state;
    } catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
  }
  async acquire(signal) {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = this.path + '.lock'; const deadline = Date.now() + 5000;
    while (true) {
      signal?.throwIfAborted();
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() })); }
        catch (error) { await handle.close(); await unlink(lockPath); throw error; }
        return async () => { await handle.close(); await unlink(lockPath); };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Recover only a demonstrably dead owner, not a slow live writer.
        let stale = false;
        try {
          const owner = JSON.parse(await readFile(lockPath, 'utf8'));
          if (Number.isInteger(owner.pid) && Date.now() - owner.createdAt > 5000) {
            try { process.kill(owner.pid, 0); } catch (probe) { stale = probe.code === 'ESRCH'; }
          }
        } catch { /* another process may still be creating the lock */ }
        if (stale) { await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); continue; }
        if (Date.now() >= deadline) throw new Error('Remote-control state is locked by another process. Retry later.');
        await delay(40, undefined, { signal });
      }
    }
  }
  transact(change, signal) {
    const run = async () => {
      const release = await this.acquire(signal); let temporary;
      try {
        const state = await this.read(); const result = await change(state);
        signal?.throwIfAborted();
        temporary = this.path + '.' + randomUUID() + '.tmp';
        await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
        await rename(temporary, this.path); temporary = undefined;
        return result;
      } finally { if (temporary) await unlink(temporary).catch(() => {}); await release(); }
    };
    const promise = this.tail.then(run, run); this.tail = promise.catch(() => {}); return promise;
  }
  cursor(key, seq, signal, epoch) {
    return this.transact(state => {
      state.sessions[key] ??= { readSeq: -1 };
      if (epoch !== undefined && (state.sessions[key].readEpoch ?? 0) !== epoch) return;
      state.sessions[key].readSeq = Math.max(state.sessions[key].readSeq ?? -1, seq);
    }, signal);
  }
}

/** Held results are private local files, never automatically injected into a prompt. */
export class ResultVault {
  constructor(store, { maxResults = 50, ttlMs = 86400000 } = {}) { this.store = store; this.directory = join(dirname(store.path), 'results'); this.maxResults = maxResults; this.ttlMs = ttlMs; }
  path(id) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid resultId.'); return join(this.directory, id + '.json'); }
  async hold(value, ack, signal) {
    const resultId = randomUUID(); const text = JSON.stringify(value); const createdAt = Date.now();
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.path(resultId), text, { mode: 0o600, signal });
    try {
      await this.store.transact(async state => {
        for (const [id, result] of Object.entries(state.results)) {
          if (createdAt - result.createdAt > this.ttlMs) { delete state.results[id]; await unlink(this.path(id)).catch(() => {}); }
        }
        const previous = Object.entries(state.results).sort((a,b) => a[1].createdAt - b[1].createdAt);
        while (previous.length >= this.maxResults) { const [id] = previous.shift(); delete state.results[id]; await unlink(this.path(id)).catch(() => {}); }
        state.results[resultId] = { createdAt, totalChars: text.length, deliveredThrough: 0, ack };
      }, signal);
    } catch (error) { await unlink(this.path(resultId)).catch(() => {}); throw error; }
    return { state: 'oversized', omitted: true, resultId, totalChars: text.length, expiresInSeconds: this.ttlMs / 1000,
      next: 'Use dsh_other operation=result action=execute with args {resultId,offset,maxChars} for chunks, or {resultId,full:true,maxChars} for an explicitly larger return. Read cursor has not advanced.' };
  }
  async retrieve({ resultId, offset = 0, maxChars, full = false }, budget, signal) {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer.');
    maxChars ??= Math.min(4000,budget - 400);
    if (!full && (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > budget - 400)) throw new Error(`Chunk maxChars must be 1..${budget - 400}. Raise the outer maxChars budget for larger chunks.`);
    const state = await this.store.read(); const meta = state.results[resultId];
    if (!meta || Date.now() - meta.createdAt > this.ttlMs) throw new Error('Result expired or was evicted; fetch it again. Read cursor is unchanged.');
    const text = await readFile(this.path(resultId), 'utf8');
    if (full) {
      if (text.length + 9 > budget) return { state: 'oversized', omitted: true, resultId, totalChars: text.length, maxChars: budget, next: 'Raise the outer maxChars budget or retrieve chunks. Read cursor has not advanced.' };
      await this.ack(resultId, 0, text.length, signal);
      return JSON.parse(text);
    }
    if (offset > text.length) throw new Error('offset is past the result length.');
    let end = Math.min(text.length, offset + maxChars);
    // JSON escaping may expand a text chunk; fit the rendered envelope too.
    const chunk = () => ({ resultId, format: 'json', offset, nextOffset: end, totalChars: text.length, complete: end === text.length, text: text.slice(offset, end) });
    while (JSON.stringify({data:chunk()}).length > budget && end > offset) end = offset + Math.floor((end - offset) * 0.75);
    if (end === offset && offset < text.length) throw new Error('Return budget too small for a result chunk.');
    await this.ack(resultId, offset, end, signal);
    return chunk();
  }
  async ack(id, offset, end, signal) {
    await this.store.transact(state => {
      const meta = state.results[id]; if (!meta) throw new Error('Result expired during retrieval.');
      if (offset <= meta.deliveredThrough) meta.deliveredThrough = Math.max(meta.deliveredThrough, end);
      if (meta.deliveredThrough === meta.totalChars && meta.ack) {
        const { key, seq, epoch } = meta.ack; state.sessions[key] ??= { readSeq: -1 };
        if (epoch === undefined || (state.sessions[key].readEpoch ?? 0) === epoch) state.sessions[key].readSeq = Math.max(state.sessions[key].readSeq ?? -1, seq);
      }
    }, signal);
  }
}
