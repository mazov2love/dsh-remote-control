import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { DshClient } from '../src/client.js';
import { RemoteOperations, completionAfter } from '../src/operations.js';
import { createToolDefinitions } from '../src/index.js';

async function fixture(t) {
  const requests = []; let mutations = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/?token=test-token') { res.writeHead(303, { 'set-cookie': 'dsh-test=authenticated; HttpOnly; Path=/', location: './' }); res.end(); return; }
    if (req.headers.cookie !== 'dsh-test=authenticated') { res.writeHead(401); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); requests.push(input);
    assert.equal(req.url, `/api/${input.method}`);
    if (input.method === 'test/drop') { mutations++; req.socket.destroy(); return; }
    const value = input.method === 'session/create' ? { sessionId: input.payload.args.request.sessionId } : { echoed: input.payload.args };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: input.method === 'test/bad-id' ? 'wrong' : input.rpcId, result: { ok: true, value } }));
  });
  const wsServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.cookie !== 'dsh-test=authenticated' || req.url !== '/api/remote.mux') { socket.destroy(); return; }
    wsServer.handleUpgrade(req, socket, head, ws => wsServer.emit('connection', ws));
  });
  wsServer.on('connection', ws => ws.on('message', bytes => {
    const frame = JSON.parse(bytes);
    if (frame.type !== 'open') return;
    if (frame.endpoint === 'test/hang') return;
    if (frame.endpoint === '$events') {
      ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId: 'client1' } }));
      ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'waterfall', event: 'approval/request', eventId: 'event1', agentId: 's1', request: { toolName: 'example' } } }));
      return;
    }
    ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'baseline', value: { items: [{ workspaceId: 'w1' }] } } }));
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  process.env.DSH_PLUGIN_TEST_TOKEN = 'test-token';
  const target = { id: 'test', url: `http://127.0.0.1:${server.address().port}`, tokenEnv: 'DSH_PLUGIN_TEST_TOKEN' };
  const client = new DshClient(target);
  t.after(async () => { client.close(); for (const ws of wsServer.clients) ws.terminate(); wsServer.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); delete process.env.DSH_PLUGIN_TEST_TOKEN; });
  return { client, target, requests, mutations: () => mutations };
}

test('token exchange, authenticated named-argument RPC and response correlation', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.rpc('test/echo', { request: { value: 42 } }), { echoed: { request: { value: 42 } } });
  assert.equal(f.requests[0].type, 'client-request');
  await assert.rejects(f.client.rpc('test/bad-id'), { code: 'protocol' });
});
test('authenticated WebSocket baseline and snapshot cleanup', async t => {
  const f = await fixture(t);
  const value = await f.client.first('workspace/follow');
  assert.equal(value.value.items[0].workspaceId, 'w1');
  assert.equal(f.client.streams.size, 0);
});
test('abort releases a waiting stream', async t => {
  const f = await fixture(t); const abort = new AbortController();
  const stream = await f.client.stream('test/hang', {}, abort.signal);
  const next = stream.next(); abort.abort(new Error('cancelled test'));
  await assert.rejects(next, /cancelled test/);
  assert.equal(f.client.streams.size, 0);
});
test('an uncertain write is never silently retried', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.rpc('test/drop'), { code: 'transport-uncertain' });
  assert.equal(f.mutations(), 1);
});
test('cross-origin credential URLs are rejected and instance roster contains no secrets', async t => {
  const f = await fixture(t);
  assert.throws(() => new DshClient({ id: 'x', url: `${f.target.url}/?token=secret` }), /plain HTTP/);
  const operations = new RemoteOperations([f.target]); t.after(() => operations.close());
  assert.deepEqual(operations.list(), [{ id: 'test', url: f.target.url }]);
  const tools = createToolDefinitions(operations);
  assert.equal(new Set(tools.map(x => x.name)).size, 6);
  const stub = { call: async (action) => ({ action }) };
  assert.deepEqual(await createToolDefinitions(stub)[0].execute({}, { signal: new AbortController().signal }), { data: { action: 'create' } });
});
test('create preserves caller session id for recoverable creation', async t => {
  const f = await fixture(t); const operations = new RemoteOperations([f.target]); t.after(() => operations.close());
  const result = await operations.call('create', { instance: 'test', sessionId: 'stable-id', workspaceId: 'w1', agentPreset: 'minimal' });
  assert.equal(result.sessionId, 'stable-id');
  assert.deepEqual(f.requests[0].payload.args.request, { sessionId: 'stable-id', workspaceId: 'w1', agentPreset: 'minimal' });
});
test('wait does not mistake a previous queued turn for the requested reply', () => {
  const records = [
    { event: { seq: 10, type: 'turn/end', data: {} } },
    { event: { seq: 12, type: 'user/message', data: { source: { rpcId: 'new' } } } },
  ];
  assert.equal(completionAfter(records, 'new', 8), false);
  records.push({ event: { seq: 15, type: 'turn/end', data: {} } });
  assert.equal(completionAfter(records, 'new', 8), true);
  assert.equal(completionAfter(records, 'different', 8), false);
});
test('interactions stay bound to their session and response uses active client correlation', async t => {
  const f = await fixture(t); const operations = new RemoteOperations([f.target]); t.after(() => operations.close());
  const pending = await operations.call('interactions', { instance: 'test', sessionId: 's1' });
  assert.equal(pending.items[0].eventId, 'event1');
  assert.deepEqual((await operations.call('interactions', { instance: 'test', sessionId: 'other' })).items, []);
  await assert.rejects(operations.call('respond', { instance: 'test', sessionId: 'other', eventId: 'event1', decision: 'allowed-once' }), /not found/);
  assert.deepEqual(await operations.call('respond', { instance: 'test', sessionId: 's1', eventId: 'event1', decision: 'rejected' }), { accepted: true });
  assert.deepEqual(f.requests.find(request => request.method === '$events/result').payload.args, { clientId: 'client1', eventId: 'event1', outcome: { kind: 'result', value: 'rejected' } });
  await assert.rejects(operations.call('respond', { instance: 'test', sessionId: 's1', eventId: 'event1', decision: 'allowed-once' }), /not found/);
});
