import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import WebSocket from 'ws';

export class RemoteDshError extends Error {
  constructor(code, message) { super(message); this.name = 'RemoteDshError'; this.code = code; }
}
const problem = (code, message) => new RemoteDshError(code, message);
const lifetime = (signal, ms) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(ms)]);

/** One configured, authenticated DSH origin. No browser or DSH internals are used. */
export class DshClient {
  constructor(target, { fetchImpl = fetch, WebSocketImpl = WebSocket } = {}) {
    const url = new URL(target.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw problem('configuration', 'Target url must be a plain HTTP(S) origin without credentials, query or path.');
    }
    if (!target.id || !/^[a-zA-Z0-9_-]+$/.test(target.id)) throw problem('configuration', 'Target id must contain letters, numbers, underscores or hyphens.');
    this.target = { ...target, url: url.origin };
    this.fetch = fetchImpl; this.WebSocket = WebSocketImpl;
    this.cookie = ''; this.authFlight = null; this.streams = new Set(); this.closed = false;
    this.abort = new AbortController();
  }
  signal(signal) { return signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal; }
  async credential() {
    if (this.target.authFile) {
      let value;
      try { value = JSON.parse((await readFile(this.target.authFile, 'utf8')).replace(/^\uFEFF/, '')); }
      catch { throw problem('credentials', `Cannot read credentials for ${this.target.id}; check authFile.`); }
      if (value.origin && value.origin !== this.target.url) throw problem('credentials', 'Credential origin does not match target.');
      return value;
    }
    const token = this.target.tokenEnv ? process.env[this.target.tokenEnv] : undefined;
    return { token };
  }
  async authenticate(signal, force = false) {
    signal = this.signal(signal);
    signal.throwIfAborted();
    if (this.closed) throw problem('disposed', 'Remote DSH client has been disposed.');
    if (this.cookie && !force) return;
    if (this.authFlight) return this.authFlight;
    const work = async () => {
      const auth = await this.credential();
      signal.throwIfAborted();
      if (!force && typeof auth.cookie === 'string' && auth.cookie) { this.cookie = auth.cookie; return; }
      if (typeof auth.token !== 'string' || !auth.token) throw problem('authentication', `Target ${this.target.id} needs its launch token in authFile or tokenEnv.`);
      const url = new URL(this.target.url); url.searchParams.set('token', auth.token);
      let response;
      try { response = await this.fetch(url, { redirect: 'manual', signal: lifetime(signal, 15000) }); }
      catch { signal.throwIfAborted(); throw problem('connection', `Cannot authenticate target ${this.target.id}. Check that it is running.`); }
      signal.throwIfAborted();
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (response.status !== 303 || !cookie) throw problem('authentication', `Target ${this.target.id} rejected the token; obtain its current launch URL.`);
      this.cookie = cookie;
      if (this.target.authFile) {
        await mkdir(dirname(this.target.authFile), { recursive: true });
        signal.throwIfAborted();
        await writeFile(this.target.authFile, JSON.stringify({ origin: this.target.url, token: auth.token, cookie }) + '\n', { mode: 0o600, signal });
      }
    };
    this.authFlight = work();
    try { await this.authFlight; } finally { this.authFlight = null; }
  }
  async rpc(endpoint, args = {}, signal) {
    signal = this.signal(signal);
    if (!/^[\w$.-]+\/[\w$.-]+$/.test(endpoint)) throw problem('protocol', 'Invalid RPC endpoint.');
    await this.authenticate(signal);
    signal.throwIfAborted();
    const rpcId = randomUUID();
    const send = () => this.fetch(`${this.target.url}/api/${endpoint}`, {
      method: 'POST', redirect: 'error', signal: lifetime(signal, 30000),
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    });
    let response;
    try {
      response = await send();
      if (response.status === 401) { await this.authenticate(signal, true); response = await send(); }
    } catch (error) {
      if (error instanceof RemoteDshError) throw error;
      if (signal?.aborted) throw signal.reason;
      throw problem('transport-uncertain', `RPC ${endpoint} did not complete. A write might have been accepted; inspect state before retrying.`);
    }
    if (!response.ok) throw problem('http', `RPC ${endpoint}: HTTP ${response.status}.`);
    let envelope;
    try { envelope = await response.json(); } catch { throw problem('protocol', 'DSH returned a non-JSON RPC response.'); }
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || typeof envelope.result?.ok !== 'boolean') throw problem('protocol', 'Invalid DSH RPC response or correlation id.');
    if (!envelope.result.ok) {
      // Avoid reflecting arbitrary remote messages which could contain connection secrets.
      throw problem(envelope.result.error?.code ?? 'remote', `Remote operation ${endpoint} failed (${envelope.result.error?.code ?? 'unknown'}).`);
    }
    return envelope.result.value ?? null;
  }
  /** A bounded-lifetime logical stream. Caller must close it, including after first(). */
  async stream(endpoint, args = {}, signal) {
    signal = this.signal(signal);
    await this.authenticate(signal);
    signal?.throwIfAborted();
    const url = new URL('/api/remote.mux', this.target.url); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws; let generation = 0; let refreshed = false;
    const streamId = randomUUID(); const queue = []; let wake; let failure; let ended = false; let released = false;
    const notify = () => { wake?.(); wake = undefined; };
    const close = () => {
      if (released) return; released = true; ended = true;
      signal?.removeEventListener('abort', onAbort);
      this.streams.delete(close);
      if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'cancel', streamId })); ws.close(); }
      else if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
      notify();
    };
    const onAbort = () => { failure = signal.reason; close(); };
    this.streams.add(close); signal?.addEventListener('abort', onAbort, { once: true });
    const connect = () => {
      if (released) return;
      const current = new this.WebSocket(url, { headers: { cookie: this.cookie }, handshakeTimeout: 15000, maxPayload: 16 * 1024 * 1024 });
      ws = current; const ownGeneration = ++generation;
      const active = () => ownGeneration === generation && !released;
      current.on('unexpected-response', (_request, response) => {
        response.resume();
        if (!active()) return;
        // A rejected handshake cannot have dispatched a logical stream, so one
        // credential refresh is safe; never replay a stream after it opened.
        if (response.statusCode === 401 && !refreshed) {
          refreshed = true; generation++; current.terminate();
          void this.authenticate(signal, true).then(connect).catch(error => { failure = error; close(); });
        } else { failure = problem('stream-authentication', `Stream handshake to ${this.target.id} failed (HTTP ${response.statusCode}).`); close(); }
      });
      current.on('error', () => { if (!active()) return; failure ??= problem('stream-connection', `Stream to ${this.target.id} failed; reconnect by invoking the operation again.`); close(); });
      current.on('close', () => { if (!active()) return; if (!ended) failure = problem('stream-closed', 'Remote DSH stream disconnected.'); close(); });
      current.on('open', () => { if (!active()) return; current.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })); });
      current.on('message', (bytes) => {
      if (!active()) return;
      try {
        const frame = JSON.parse(bytes.toString());
        if (frame.streamId !== streamId) throw problem('protocol', 'Unexpected stream correlation id.');
        if (frame.type === 'item') { if (queue.length >= 1024) throw problem('overflow', 'Remote stream consumer is too slow.'); queue.push(frame.value); }
        else if (frame.type === 'error') { failure = problem(frame.error?.code ?? 'remote', `Remote stream ${endpoint} failed (${frame.error?.code ?? 'unknown'}).`); close(); }
        else if (frame.type === 'end') close();
        else throw problem('protocol', 'Unknown remote stream frame.');
      } catch (error) { failure = error; close(); }
      notify();
      });
    };
    connect();
    return {
      close,
      async next() {
        while (!queue.length && !ended) await new Promise(resolve => { wake = resolve; });
        if (failure) throw failure;
        if (queue.length) return { value: queue.shift(), done: false };
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() { return this; },
      async return() { close(); return { done: true }; },
    };
  }
  async first(endpoint, args = {}, signal) {
    const stream = await this.stream(endpoint, args, lifetime(signal, 20000));
    try { const item = await stream.next(); if (item.done) throw problem('protocol', 'Remote stream ended before its snapshot.'); return item.value; }
    finally { stream.close(); }
  }
  close() { this.closed = true; this.abort.abort(problem('disposed', 'Remote DSH client has been disposed.')); for (const close of [...this.streams]) close(); this.cookie = ''; }
}
