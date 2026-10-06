import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {DshClient} from '../src/client.js';
import {RemoteOperations} from '../src/operations.js';

test('disposing client aborts authentication in flight', async () => {
  let started;
  const ready=new Promise(resolve=>{started=resolve});
  process.env.DSH_LIFECYCLE_TOKEN='test';
  const client=new DshClient({id:'test',url:'http://127.0.0.1:9999',tokenEnv:'DSH_LIFECYCLE_TOKEN'}, {
    fetchImpl:async (_url,{signal})=>{started(); await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},
  });
  try {
    const request=client.rpc('test/echo'); await ready; client.close();
    await assert.rejects(request,{code:'disposed'});
    assert.equal(client.cookie,'');
  } finally {client.close(); delete process.env.DSH_LIFECYCLE_TOKEN;}
});

test('stream handshake 401 refreshes stale cookie once before opening', async t => {
  let exchanges=0,opens=0;
  const server=createServer((req,res)=>{
    exchanges++; res.writeHead(303,{'set-cookie':'dsh-test=fresh; Path=/'}); res.end();
  });
  const wsServer=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>{
    if(req.headers.cookie!=='dsh-test=fresh'){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
    wsServer.handleUpgrade(req,socket,head,ws=>wsServer.emit('connection',ws));
  });
  wsServer.on('connection',ws=>ws.on('message',bytes=>{
    const frame=JSON.parse(bytes);
    if(frame.type==='open'){opens++;ws.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{type:'baseline'}}));}
  }));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  process.env.DSH_LIFECYCLE_TOKEN='test';
  const client=new DshClient({id:'test',url:`http://127.0.0.1:${server.address().port}`,tokenEnv:'DSH_LIFECYCLE_TOKEN'});
  t.after(async()=>{client.close();for(const ws of wsServer.clients)ws.terminate();wsServer.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));delete process.env.DSH_LIFECYCLE_TOKEN;});
  client.cookie='dsh-test=stale';
  assert.equal((await client.first('workspace/follow')).type,'baseline');
  assert.equal(exchanges,1);assert.equal(opens,1);
});

function stream(items){
  let resolve,closed=false;
  return {
    async next(){if(items.length)return {value:items.shift(),done:false};if(closed)return {done:true};return new Promise(r=>{resolve=r});},
    close(){closed=true;resolve?.({done:true});},
    [Symbol.asyncIterator](){return this},
    async return(){this.close();return {done:true}},
  };
}
test('timed question claim expires and unrelated sessions are delegated', async t=>{
  const ops=new RemoteOperations([]);t.after(()=>ops.close());
  const event=(eventId,agentId)=>({type:'waterfall',event:'user-questions/request',eventId,agentId,request:{questions:[],wait:{timed:true,callId:eventId}}});
  const events=stream([{type:'ready',clientId:'c'},event('unrelated','other'),event('owned','s')]);
  const claim=stream([{remainingMs:15}]);let releases=0;const close=claim.close.bind(claim);claim.close=()=>{releases++;close()};
  const responses=[];
  ops.clients.set('test',{
    stream:async(endpoint)=>endpoint==='$events'?events:claim,
    rpc:async(endpoint,args)=>{responses.push({endpoint,args});return null},close(){events.close();claim.close()},
  });
  await ops.ensureEvents('test',undefined,'s');
  await delay(50);
  assert.equal(ops.events.get('test').pending.has('unrelated'),false);
  assert.deepEqual(responses[0].args.outcome,{kind:'next'});
  assert.equal(releases,1);
  assert.equal(ops.events.get('test').claims.size,0);
});
