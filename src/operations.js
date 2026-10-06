import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DshClient } from './client.js';

const text = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`); return value; };
const bound = (value, fallback, max) => { const n = value ?? fallback; if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Expected integer between 1 and ${max}.`); return n; };
const address = sessionId => ({ kind: 'session', sessionId: text(sessionId, 'sessionId') });

export function completionAfter(records, requestId, afterSeq) {
  const events = records.map(row => row.event).filter(Boolean);
  const message = events.find(event => event.type === 'user/message' && event.data?.source?.rpcId === requestId);
  // An exact request id also recovers a write whose receipt was lost. In that
  // case afterSeq may already be newer than the completed response.
  return Boolean(message && events.some(event => event.type === 'turn/end' && event.seq > message.seq));
}

/** Keep conversation content; full transport diagnostics remain opt-in. */
export function conversationView(snapshot) {
  return { ...snapshot, records: snapshot.records.flatMap(row => {
    const event = row.event;
    if (!event) return [];
    if (event.type === 'user/message' && event.data?.source?.kind !== 'user') return [];
    if (event.type === 'assistant/message' || event.type === 'tool/result') {
      const { stream, ...data } = event.data;
      const message = data.message;
      const source = message?.source;
      return [{ ...row, event: { ...event, data: { ...data, message: { ...message,
        content: message?.content?.filter(block => block.type !== 'reasoning'),
        ...(source ? { source: Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'replayState')) } : {}),
      } } } }];
    }
    return ['user/message','turn/start','turn/end','session/title','tool/call'].includes(event.type) ? [row] : [];
  }) };
}

/** Operations deliberately own no persona, planning policy or prompt rewriting. */
export class RemoteOperations {
  constructor(targets, options = {}) {
    this.clients = new Map(); this.events = new Map(); this.stopped = false;
    for (const target of targets) {
      if (this.clients.has(target.id)) throw new Error(`Duplicate target id: ${target.id}`);
      this.clients.set(target.id, new DshClient(target, options));
    }
  }
  client(id) { const client = this.clients.get(id); if (!client) throw new Error(`Unknown instance ${id}. Use dsh_instances.`); return client; }
  list() { return [...this.clients].map(([id, client]) => ({ id, url: client.target.url })); }
  async call(action, args, signal) {
    if (action === 'instances') return { instances: this.list() };
    const c = this.client(args.instance);
    switch (action) {
      case 'catalog': return { presets: await c.rpc('agentPresets/list', {}, signal), models: await c.rpc('session/modelCatalog', {}, signal) };
      case 'workspaces': {
        if (args.action === 'create') return c.rpc('workspace/create', { request: { path: text(args.path, 'path') } }, signal);
        const frame = await c.first('workspace/follow', {}, signal);
        if (frame.type !== 'baseline') throw new Error('Expected workspace baseline.');
        return frame.value;
      }
      case 'sessions': {
        const value = await c.rpc('session/list', { _request: {} }, signal);
        let items = value.items;
        if (args.workspaceId) {
          const workspaces = await this.call('workspaces', args, signal);
          const workspace = workspaces.items.find(w => w.workspaceId === args.workspaceId);
          if (!workspace) throw new Error('Workspace not found.');
          items = items.filter(item => workspace.sessionIds.includes(item.sessionId));
        }
        const limit = bound(args.limit, 30, 200);
        return { items: items.slice(0, limit), hasMore: items.length > limit };
      }
      case 'create': {
        const request = { sessionId: args.sessionId || randomUUID() };
        for (const key of ['workspaceId', 'cwd', 'agentPreset']) if (args[key]) request[key] = args[key];
        const result = await c.rpc('session/create', { request }, signal);
        if (args.title) await c.rpc('session/rename', { request: { sessionId: result.sessionId, title: args.title } }, signal);
        return result;
      }
      case 'read': {
        let snapshot;
        if (args.throughSeq !== undefined) snapshot = await c.rpc('session/page', { request: {
          address: address(args.sessionId), throughSeq: args.throughSeq, ...(args.beforeSeq === undefined ? {} : { beforeSeq: args.beforeSeq }),
          maxMessages: bound(args.maxMessages, 20, 100),
        } }, signal);
        else {
          snapshot = await c.first('session/follow', { request: { address: address(args.sessionId), maxMessages: bound(args.maxMessages, 20, 100) } }, signal);
          if (snapshot.type !== 'snapshot') throw new Error('Expected session snapshot.');
        }
        const seqs = snapshot.records.map(row => row.event?.seq).filter(Number.isInteger);
        snapshot = { ...snapshot, nextBeforeSeq: snapshot.hasMore && seqs.length ? Math.min(...seqs) : null };
        return args.raw ? snapshot : conversationView(snapshot);
      }
      case 'status': return c.rpc('session/projections', { request: { sessionId: text(args.sessionId, 'sessionId') } }, signal);
      case 'model': {
        const request = { sessionId: text(args.sessionId, 'sessionId'), provider: text(args.provider, 'provider'), model: text(args.model, 'model') };
        if (args.reasoningEffort) request.reasoningEffort = args.reasoningEffort;
        return c.rpc('session/selectModel', { request }, signal);
      }
      case 'send': {
        await this.ensureEvents(args.instance, signal, args.sessionId);
        const requestId = args.requestId || randomUUID();
        const sessionId = text(args.sessionId, 'sessionId');
        const before = await c.rpc('session/projections', { request: { sessionId } }, signal);
        const mode = args.mode ?? 'queue';
        if (!['queue', 'steer'].includes(mode)) throw new Error('mode must be queue or steer.');
        const result = await c.rpc('session/prompt', { request: { requestId, sessionId, mode, content: [{ type: 'text', text: text(args.message, 'message') }] } }, signal);
        return { ...result, requestId, sessionId, afterSeq: before?.asOfSeq ?? -1 };
      }
      case 'cancel': return c.rpc('session/cancel', { request: { sessionId: text(args.sessionId, 'sessionId') } }, signal);
      case 'wait': {
        const duration = bound(args.timeoutSeconds, 30, 60) * 1000;
        const deadline = Date.now() + duration;
        do {
          const snapshot = await this.call('read', { ...args, maxMessages: 30, raw: true }, signal);
          const pending = await this.call('interactions', args, signal);
          const requestId = text(args.requestId, 'requestId');
          let records = snapshot.records;
          let page = snapshot;
          // Long tool runs can push the original prompt out of the latest window.
          // Exact id matching must also work when recovering a lost send receipt.
          while (page.hasMore && !records.some(row => row.event?.type === 'user/message' && row.event.data?.source?.rpcId === requestId)) {
            signal?.throwIfAborted();
            if (Date.now() >= deadline) break;
            const beforeSeq = page.nextBeforeSeq;
            if (beforeSeq === null) break;
            page = await this.call('read', { ...args, throughSeq: snapshot.cursor, beforeSeq, maxMessages: 100, raw: true }, signal);
            if (!page.records.length || (page.nextBeforeSeq !== null && page.nextBeforeSeq >= beforeSeq)) break;
            records = [...page.records, ...records];
          }
          const completed = completionAfter(records, requestId, args.afterSeq);
          const view = conversationView(snapshot);
          if (pending.items.length || completed) return { state: pending.items.length ? 'needs-input' : 'completed', snapshot: view, interactions: pending.items };
          if (Date.now() >= deadline) return { state: 'waiting', snapshot: view, interactions: [] };
          await delay(Math.min(1000, Math.max(1, deadline - Date.now())), undefined, { signal });
        } while (true);
      }
      case 'interactions': {
        await this.ensureEvents(args.instance, signal, args.sessionId);
        const state = this.events.get(args.instance);
        const items = [...state.pending.values()].filter(item => !args.sessionId || item.agentId === args.sessionId);
        if (args.sessionId) {
          const projections = await c.rpc('session/projections', { request: { sessionId: args.sessionId } }, signal);
          for (const question of projections?.values?.userQuestions?.active ?? []) {
            if (!items.some(item => item.request?.wait?.callId === question.callId)) items.push({
              type: 'continued-question', event: 'user-questions/request', eventId: `continued:${question.callId}`,
              agentId: args.sessionId, request: { questions: question.questions, wait: { callId: question.callId } },
            });
          }
        }
        return { items };
      }
      case 'respond': {
        await this.ensureEvents(args.instance, signal, args.sessionId);
        const state = this.events.get(args.instance);
        if (args.eventId?.startsWith('continued:')) {
          if (!Array.isArray(args.answers)) throw new Error('answers must be an array.');
          const accepted = await c.rpc('userQuestions/answer', { agentId: text(args.sessionId, 'sessionId'), callId: args.eventId.slice(10), answer: { answers: args.answers } }, signal);
          return { accepted };
        }
        const item = state.pending.get(args.eventId);
        if (!item || item.agentId !== args.sessionId) throw new Error('Pending interaction not found for this session; refresh dsh_interactions.');
        let value;
        if (item.event === 'approval/request') {
          if (!['allowed-once', 'rejected', 'cancelled'].includes(args.decision)) throw new Error('Choose allowed-once, rejected or cancelled.');
          value = args.decision;
        } else if (item.event === 'user-questions/request') {
          if (!Array.isArray(args.answers)) throw new Error('answers must be an array of {id,selected,custom?}.');
          value = { answers: args.answers };
        } else throw new Error('Unsupported interaction type.');
        await c.rpc('$events/result', { clientId: state.clientId, eventId: item.eventId, outcome: { kind: 'result', value } }, signal);
        state.pending.delete(item.eventId);
        state.claims.get(item.eventId)?.close(); state.claims.delete(item.eventId);
        return { accepted: true };
      }
      default: throw new Error(`Unknown operation: ${action}`);
    }
  }
  async ensureEvents(id, signal, sessionId) {
    signal?.throwIfAborted();
    if (this.stopped) throw new Error('Remote operations have been disposed.');
    let state = this.events.get(id);
    if (state?.ready) { if (sessionId) state.watchedSessions.add(sessionId); return state.ready; }
    state = { pending: new Map(), claims: new Map(), watchedSessions: new Set(sessionId ? [sessionId] : []), abort: new AbortController(), clientId: null };
    this.events.set(id, state);
    const c = this.client(id);
    state.ready = (async () => {
      const stream = await c.stream('$events', {}, state.abort.signal);
      state.stream = stream;
      // Bound only opening. The ongoing listener survives individual tool calls.
      const readyTimer = new AbortController();
      let first;
      try {
        first = await Promise.race([stream.next(), delay(15000, undefined, { signal: readyTimer.signal }).then(() => { throw new Error('Event stream ready timeout.'); })]);
      } finally { readyTimer.abort(); }
      if (first.done || first.value?.type !== 'ready') throw new Error('Invalid event stream ready frame.');
      state.clientId = first.value.clientId;
      state.pump = (async () => {
        for await (const item of stream) {
          if (item.type === 'waterfall') {
            if (state.watchedSessions.has(item.agentId) && ['approval/request', 'user-questions/request'].includes(item.event)) {
              state.pending.set(item.eventId, item);
              if (item.request.wait?.timed && item.request.wait?.callId) {
                const claim = await c.stream('userQuestions/attachWait', { agentId: item.agentId, callId: item.request.wait.callId }, state.abort.signal);
                const clock = new AbortController();
                const release = { close() { clock.abort(); claim.close(); } };
                state.claims.set(item.eventId, release);
                void (async () => {
                  const first = await claim.next();
                  const remainingMs = first.value?.remainingMs;
                  if (first.done || !Number.isFinite(remainingMs) || remainingMs < 0 || remainingMs > 2147483647) return;
                  // DSH pauses its own timer while attached. Release at the
                  // supplied deadline so an unanswered question can time out.
                  await Promise.race([claim.next(), delay(remainingMs, undefined, { signal: clock.signal })]);
                })().catch(() => {}).finally(() => { release.close(); if (state.claims.get(item.eventId) === release) state.claims.delete(item.eventId); });
              }
            }
            else await c.rpc('$events/result', { clientId: state.clientId, eventId: item.eventId, outcome: { kind: 'next' } }, state.abort.signal);
          } else if (item.type === 'cancel') { state.pending.delete(item.eventId); state.claims.get(item.eventId)?.close(); state.claims.delete(item.eventId); }
        }
      })().catch(() => {}).finally(() => { stream.close(); state.abort.abort(); for (const claim of state.claims.values()) claim.close(); if (this.events.get(id) === state) this.events.delete(id); });
    })().catch(error => { state.stream?.close(); state.abort.abort(); if (this.events.get(id) === state) this.events.delete(id); throw error; });
    signal?.throwIfAborted();
    await state.ready;
  }
  close() { this.stopped = true; for (const state of this.events.values()) { state.abort.abort(); state.stream?.close(); for (const claim of state.claims.values()) claim.close(); } this.events.clear(); for (const client of this.clients.values()) client.close(); }
}
