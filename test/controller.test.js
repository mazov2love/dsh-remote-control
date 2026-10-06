import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RemoteController } from '../src/controller.js';
import { LocalStore, sessionKey } from '../src/store.js';
import { createToolDefinitions, apply } from '../src/index.js';

const row=(seq,text)=>({type:'event',event:{seq,type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'hidden'},{type:'text',text}]},stream:['duplicate']}}});
async function fixture(t,options={}) {
  const directory=await mkdtemp(join(tmpdir(),'dsh-remote-test-'));
  t.after(async()=>{if(!resolve(directory).startsWith(resolve(tmpdir())+'\\dsh-remote-test-')&&!resolve(directory).startsWith(resolve(tmpdir())+'/dsh-remote-test-'))throw new Error('Unexpected cleanup directory');await rm(directory,{recursive:true,force:true});});
  const calls=[];
  const state={cursor:5,rows:[row(3,'first reply')],running:false,model:{provider:'p',model:'m'},permission:'workspace-write',failPermission:false,pageSize:100};
  const client={target:{url:'http://127.0.0.1:3080'},async rpc(endpoint,args){
    calls.push({endpoint,args});
    if(endpoint==='session/list')return {items:Array.from({length:75},(_,i)=>({sessionId:i===0?'s':`other-${i}`,running:state.running,cwd:'C:/test',projections:{values:{title:i===0?'test session':`session ${i}`,todos:'large internal data'.repeat(1000)}}}))};
    if(endpoint==='permissionPresets/catalog')return {options:[{value:'workspace-write'},{value:'read-only'}]};
    if(endpoint==='commands/execute'){if(state.failPermission)return {result:{kind:'error'}};state.permission=args.line.split(' ')[1];return {result:{kind:'success'}};}
    if(endpoint==='session/search')return {items:[{sessionId:'s',snippet:'matching content'}],hasMore:false};
    throw new Error('Unexpected RPC '+endpoint);
  }};
  const remote={
    list:()=>[{id:'technical',url:client.target.url}],client:()=>client,close(){},
    async call(action,args){
      calls.push({action,args});
      if(action==='create')return {sessionId:args.sessionId,agentPreset:args.agentPreset??'standard'};
      if(action==='workspaces')return args.action==='create'?{workspace:{workspaceId:'w',title:'test',path:args.path,sessionIds:Array(500).fill('not returned')},created:true}:{items:[{workspaceId:'w',title:'test',path:'C:/test',sessionIds:['s']}]};
      if(action==='send')return {accepted:true,sessionId:args.sessionId,requestId:args.requestId,afterSeq:state.cursor};
      if(action==='status')return {asOfSeq:state.cursor,values:{title:'test',modelSelection:{next:state.model},permissions:{currentValue:state.permission},inbox:{'next-turn':[]},turnOutline:'DO NOT RETURN'.repeat(500)}};
      if(action==='interactions')return {items:[]};
      if(action==='model'){state.model={provider:args.provider,model:args.model};return {selected:state.model};}
      if(action==='read'){
        const eligible=state.rows.filter(r=>r.event.seq<=(args.throughSeq??state.cursor)&&(args.beforeSeq===undefined||r.event.seq<args.beforeSeq));
        const records=eligible.slice(-state.pageSize);
        return {cursor:state.cursor,records,hasMore:eligible.length>records.length};
      }
      if(action==='wait')return {state:'completed',snapshot:{cursor:state.cursor,records:state.rows},interactions:[]};
      throw new Error('Unexpected operation '+action);
    },
  };
  const controller=new RemoteController([],{stateFile:join(directory,'state.json'),remote,...options});
  t.after(()=>controller.close());
  return {controller,state,calls,client,directory,key:sessionKey('technical',client.target.url,'s')};
}

test('only six documented base tools register without advanced schema injection',async t=>{
  const f=await fixture(t);const registered=[];
  await apply({effect(){},tools:{register:tool=>registered.push(tool)}},{targets:[],stateFile:join(f.directory,'host.json')});
  assert.deepEqual(registered.map(t=>t.name),['dsh_create','dsh_refs','dsh_send','dsh_status','dsh_search','dsh_other']);
  assert.equal(createToolDefinitions(f.controller).length,6);
});
test('workspace/session creation saves durable purpose and notes without a list lookup',async t=>{
  const f=await fixture(t);
  const workspace=await f.controller.call('create',{kind:'workspace',path:'C:/test',name:'workspace'});
  const session=await f.controller.call('create',{workspaceRef:workspace.ref,name:'drawing',purpose:'charts',notes:'use the chart plugin'});
  assert.ok(session.ref);assert.notEqual(session.ref,workspace.ref);
  await f.controller.call('refs',{action:'update',ref:session.ref,notes:'verified'});
  const reloaded=new RemoteController([],{stateFile:join(f.directory,'state.json'),remote:f.controller.remote});
  const found=await reloaded.call('refs',{action:'get',ref:session.ref});
  assert.equal(found.purpose,'charts');assert.equal(found.notes,'verified');assert.equal(found.workspaceId,'w');
  assert.equal(f.calls.some(c=>c.endpoint==='session/list'),false);
});
test('reference lookup refuses reuse at a changed target origin',async t=>{
  const f=await fixture(t);const saved=await f.controller.call('refs',{action:'save',sessionId:'s',name:'original'});
  f.client.target.url='http://127.0.0.1:9090';
  await assert.rejects(f.controller.call('send',{ref:saved.ref,message:'hello'}),/different target origin/);
  assert.equal(f.calls.some(c=>c.action==='send'),false);
});
test('sending returns a durable receipt without waiting or reading a reply',async t=>{
  const f=await fixture(t);const result=await f.controller.call('send',{sessionId:'s',message:'work on this'});
  assert.equal(result.accepted,true);assert.equal(result.remoteWorkContinues,true);
  assert.deepEqual(f.calls.map(c=>c.action),['send']);
  assert.equal((await f.controller.store.read()).sessions[f.key].lastReceipt.requestId,result.requestId);
});
test('uncertain send preserves its correlation id without automatically retrying',async t=>{
  const f=await fixture(t);let sends=0;
  const original=f.controller.remote.call;
  f.controller.remote.call=async(action,args)=>{if(action==='send'){sends++;throw Object.assign(new Error('uncertain'),{code:'transport-uncertain'});}return original(action,args)};
  const result=await f.controller.call('send',{sessionId:'s',message:'hello'});
  assert.equal(result.accepted,'unknown');assert.equal(sends,1);
  assert.equal((await f.controller.store.read()).sessions[f.key].lastReceipt.requestId,result.requestId);
});
test('permission failure and running session both stop sending',async t=>{
  const f=await fixture(t);f.state.failPermission=true;
  await assert.rejects(f.controller.call('send',{sessionId:'s',message:'hello',permissionPreset:'read-only'}),/No message was sent/);
  f.state.running=true;
  await assert.rejects(f.controller.call('send',{sessionId:'s',message:'hello',provider:'p',model:'m'}),/running session/);
  assert.equal(f.calls.some(c=>c.action==='send'),false);
});
test('combined settings are explicitly changed and verified before the message',async t=>{
  const f=await fixture(t);const result=await f.controller.call('send',{sessionId:'s',message:'hello',provider:'p',model:'new',permissionPreset:'read-only'});
  assert.equal(result.settings.model.model,'new');assert.equal(result.settings.permissionPreset,'read-only');
  const command=f.calls.find(c=>c.endpoint==='commands/execute');
  assert.deepEqual(command.args,{agentId:'s',line:'/permission read-only',submittedAttachments:[]});
  assert.equal(f.calls.at(-1).action,'send');
});
test('status, search and saved lists stay compact even with a large remote roster',async t=>{
  const f=await fixture(t);const status=await f.controller.call('status',{sessionId:'s'});
  assert.equal(status.state,'idle');assert.equal(JSON.stringify(status).includes('DO NOT RETURN'),false);
  const search=await f.controller.call('search',{scope:'sessions',query:'session',limit:3});
  assert.equal(search.items.length,3);assert.equal(search.nextOffset,3);assert.equal(search.total,75);
  assert.equal(JSON.stringify(search).includes('todos'),false);
});
test('incremental read delivers new messages once; final preview leaves cursor unchanged',async t=>{
  const f=await fixture(t);const first=await f.controller.call('status',{sessionId:'s',view:'new'});
  assert.equal(first.messages[0].content[0].text,'first reply');
  assert.equal((await f.controller.call('status',{sessionId:'s',view:'new'})).messages.length,0);
  const final=await f.controller.call('status',{sessionId:'s',view:'final'});
  assert.equal(final.messages[0].content[0].text,'first reply');
  f.state.cursor=10;f.state.rows.push(row(9,'second reply'));
  const second=await f.controller.call('status',{sessionId:'s',view:'new'});
  assert.equal(second.messages.length,1);assert.equal(second.messages[0].content[0].text,'second reply');
  assert.equal((await f.controller.store.read()).sessions[f.key].readSeq,10);
});
test('long history is delivered in order; exhausted scan budget does not skip messages',async t=>{
  const f=await fixture(t,{maxHistoryPages:2});f.state.rows=[row(0,'a'),row(1,'b'),row(2,'c')];f.state.pageSize=1;
  const limited=await f.controller.call('status',{sessionId:'s',view:'new'});
  assert.equal(limited.state,'history-scan-limit');assert.equal((await f.controller.store.read()).sessions[f.key],undefined);
  f.controller.maxHistoryPages=5;
  const result=await f.controller.call('status',{sessionId:'s',view:'new'});
  assert.deepEqual(result.messages.map(m=>m.content[0].text),['a','b','c']);
});
test('oversized read is held; cursor advances only after all sequential chunks arrive',async t=>{
  const f=await fixture(t);f.state.rows=[row(3,'LONG_'.repeat(2500))];
  const held=await f.controller.call('status',{sessionId:'s',view:'new'});
  assert.equal(held.state,'oversized');assert.equal(JSON.stringify(held).includes('LONG_'),false);
  assert.equal((await f.controller.store.read()).sessions[f.key],undefined);
  let offset=0,text='';
  while(true){
    const chunk=await f.controller.call('other',{action:'execute',operation:'result',args:JSON.stringify({resultId:held.resultId,offset,maxChars:2000})});
    assert.ok(JSON.stringify({data:chunk}).length<=6000);text+=chunk.text;offset=chunk.nextOffset;
    if(chunk.complete)break;
    assert.equal((await f.controller.store.read()).sessions[f.key],undefined);
  }
  assert.equal(JSON.parse(text).messages[0].content[0].text,'LONG_'.repeat(2500));
  assert.equal((await f.controller.store.read()).sessions[f.key].readSeq,5);
});
test('explicit cursor reset invalidates pending result acknowledgements',async t=>{
  const f=await fixture(t);f.state.rows=[row(3,'x'.repeat(10000))];
  const held=await f.controller.call('status',{sessionId:'s',view:'new'});
  await f.controller.call('other',{action:'execute',operation:'reset_read',args:JSON.stringify({sessionId:'s',afterSeq:1})});
  await f.controller.call('other',{action:'execute',operation:'result',maxChars:20000,args:JSON.stringify({resultId:held.resultId,full:true})});
  assert.equal((await f.controller.store.read()).sessions[f.key].readSeq,1);
});
test('full large retrieval needs an explicit outer budget; metadata help never executes remote operations',async t=>{
  const f=await fixture(t);f.state.rows=[row(3,'x'.repeat(10000))];
  const held=await f.controller.call('status',{sessionId:'s',view:'new'});
  const stillHeld=await f.controller.call('other',{action:'execute',operation:'result',args:JSON.stringify({resultId:held.resultId,full:true})});
  assert.equal(stillHeld.state,'oversized');
  const before=f.calls.length;
  const help=await f.controller.call('other',{operation:'respond'});assert.ok(help.parameters.answers);assert.equal(f.calls.length,before);
  const full=await f.controller.call('other',{action:'execute',operation:'result',maxChars:20000,args:JSON.stringify({resultId:held.resultId,full:true})});
  assert.equal(full.messages[0].content[0].text.length,10000);
});
test('two state store writers preserve concurrent updates without overwriting each other',async t=>{
  const f=await fixture(t);const other=new LocalStore(f.controller.store.path);
  await Promise.all(Array.from({length:10},(_,i)=>(i%2?other:f.controller.store).transact(state=>{state.sessions.count=(state.sessions.count??0)+1})));
  assert.equal((await other.read()).sessions.count,10);
});
