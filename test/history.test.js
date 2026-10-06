import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteOperations, completionAfter, conversationView } from '../src/operations.js';

const row = (seq,type,data={}) => ({type:'event',event:{seq,type,data}});
test('recovering an accepted request keeps its completed result despite a newer receipt cursor', () => {
  assert.equal(completionAfter([row(10,'user/message',{source:{kind:'user',rpcId:'same'}}),row(20,'turn/end')], 'same', 25), true);
});
test('default conversation view retains usable content without provider and prompt duplication', () => {
  const snapshot={cursor:9,hasMore:false,records:[
    row(0,'system/message',{message:'internal'}),row(1,'request/header',{tools:['full schemas']}),
    row(2,'user/message',{source:{kind:'runtime-context'},content:[]}),
    row(3,'user/message',{source:{kind:'user',rpcId:'a'},content:[{type:'text',text:'question'}]}),
    row(4,'assistant/message',{stream:['duplicate'],message:{source:{kind:'model',replayState:{large:true}},content:[{type:'reasoning',text:'private chain'},{type:'text',text:'answer'}]}}),
    row(9,'turn/end',{reason:{kind:'completed'}}),
  ]};
  const view=conversationView(snapshot);
  assert.deepEqual(view.records.map(r=>r.event.seq),[3,4,9]);
  assert.deepEqual(view.records[1].event.data.message.content,[{type:'text',text:'answer'}]);
  assert.equal(view.records[1].event.data.stream,undefined);
  assert.equal(view.records[1].event.data.message.source.replayState,undefined);
  assert.equal(snapshot.records.length,6);
});
test('wait finds the matching prompt beyond the latest page of a long tool run', async t => {
  const operations=new RemoteOperations([]); t.after(()=>operations.close());
  let requestedPage;
  const client={
    first: async () => ({type:'snapshot',cursor:200,hasMore:true,records:[row(150,'assistant/message',{message:{content:[]}}),row(200,'turn/end')]}),
    rpc: async (endpoint,args) => {
      assert.equal(endpoint,'session/page'); requestedPage=args.request;
      return {hasMore:false,records:[row(5,'user/message',{source:{kind:'user',rpcId:'long'}})]};
    }, close() {},
  };
  operations.clients.set('test',client);
  const original=operations.call.bind(operations);
  operations.call=(action,args,signal)=>action==='interactions'?Promise.resolve({items:[]}):original(action,args,signal);
  const result=await operations.call('wait',{instance:'test',sessionId:'s',requestId:'long',afterSeq:0,timeoutSeconds:1});
  assert.equal(result.state,'completed');
  assert.equal(requestedPage.beforeSeq,150);
  assert.equal(requestedPage.throughSeq,200);
});
