import { randomUUID } from 'node:crypto';
import { RemoteOperations } from './operations.js';
import { LocalStore, ResultVault, sessionKey } from './store.js';

const required = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`); return value; };
const count = (value, fallback, max) => { const n = value ?? fallback; if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Expected integer 1..${max}.`); return n; };
const short = (text, n = 160) => typeof text === 'string' ? text.slice(0,n) : undefined;
const sessionSummary = item => ({ sessionId: item.sessionId, title: short(item.projections?.values?.title), cwd: item.cwd, running: item.running, updatedAt: item.updatedAt });
const workspaceSummary = item => ({ workspaceId: item.workspaceId, title: short(item.title), path: item.path, sessionCount: item.sessionIds?.length ?? 0 });
const refSummary = item => ({ ref: item.ref, kind: item.kind, name: short(item.name), instance: item.instance, purpose: short(item.purpose), updatedAt: item.updatedAt });
const page = (items, offset, limit) => {
  const start = offset ?? 0; if (!Number.isInteger(start) || start < 0) throw new Error('offset must be a non-negative integer.');
  return { items: items.slice(start,start+limit), total: items.length, nextOffset: start+limit < items.length ? start+limit : null };
};

// Detailed instructions are returned only when requested via dsh_other.
export const extraOperations = {
  instances: { description: 'List configured target ids and addresses.', parameters: {}, example: {} },
  catalog: { description: 'List presets and selectable provider/model/reasoning ids.', parameters: { instance: 'target id' }, example: { instance: 'technical' } },
  workspaces: { description: 'Search compact remote workspaces. Does not dump session ids.', parameters: { instance: 'target id', query: 'optional title/path match', offset: 'default 0', limit: 'default 10, max 50' }, example: { instance: 'technical', query: 'test' } },
  sessions: { description: 'List compact remote sessions, optionally filter workspace.', parameters: { instance: 'target id', workspaceId: 'optional', query: 'optional title/path/id match', offset: 'default 0', limit: 'default 10, max 50' }, example: { instance: 'technical', limit: 5 } },
  read_history: { description: 'Read a specific backwards history page without advancing the incremental read cursor. raw=true requests internal diagnostics.', parameters: { ref: 'saved session ref, or instance + sessionId', throughSeq: 'snapshot cursor, optional', beforeSeq: 'backwards cursor, optional', maxMessages: '1..100', raw: 'default false' }, example: { ref: 'saved-ref', maxMessages: 5 } },
  wait: { description: 'Optional explicit wait, 1..60 seconds. Returns status only, no conversation body. requestId/afterSeq come from send receipt; omitted values use the saved last receipt.', parameters: { ref: 'session ref or instance + sessionId', requestId: 'optional', afterSeq: 'optional', timeoutSeconds: 'default 15, max 60' }, example: { ref: 'saved-ref', timeoutSeconds: 15 } },
  cancel: { description: 'Cancel the active turn, preserving the remote pending inbox.', parameters: { ref: 'session ref or instance + sessionId' }, example: { ref: 'saved-ref' } },
  interactions: { description: 'Read questions and single-use approval events for this session.', parameters: { ref: 'session ref or instance + sessionId' }, example: { ref: 'saved-ref' } },
  respond: { description: 'Respond to an event from interactions. decision: allowed-once/rejected/cancelled. Question answers: [{id,selected:[labels],custom?}].', parameters: { ref: 'session ref or instance + sessionId', eventId: 'required', decision: 'approval decision', answers: 'question answers' }, example: { ref: 'saved-ref', eventId: 'event-id', answers: [{ id: 'choice', selected: ['A'] }] } },
  settings: { description: 'Change an idle session model and/or permission preset. Changes persist on the session; DSH may also save the model as its deployment default. No message is sent. Returns verified settings.', parameters: { ref: 'session ref or instance + sessionId', provider: 'with model', model: 'with provider', reasoningEffort: 'optional with model', permissionPreset: 'explicit id from permission_catalog' }, example: { ref: 'saved-ref', provider: 'deepseek-official', model: 'deepseek-flash' } },
  permission_catalog: { description: 'Read available permission presets without changing anything.', parameters: { instance: 'target id' }, example: { instance: 'technical' } },
  search_content: { description: 'Use the target DSH bounded message-content search. Search snippets are returned only by this explicitly requested operation.', parameters: { instance: 'target id', query: 'required literal query', limit: '1..20' }, example: { instance: 'technical', query: 'token usage' } },
  reset_read: { description: 'Explicitly reset incremental cursor for this remote session (shared by its saved references). Does not change remote history.', parameters: { ref: 'session ref or instance + sessionId', afterSeq: 'integer >= -1, default -1' }, example: { ref: 'saved-ref', afterSeq: -1 } },
  result: { description: 'Retrieve a held oversized result. Chunks contain JSON text. Read sequentially from offset 0, passing nextOffset. Cursor advances only after contiguous complete delivery; full=true requests the original object. Set the outer dsh_other maxChars budget explicitly for large returns (max 100000).', parameters: { resultId: 'held result id', offset: 'default 0', maxChars: 'chunk length, default 4000', full: 'default false' }, example: { resultId: 'result-id', offset: 0, maxChars: 3000 } },
};

export class RemoteController {
  constructor(targets, { stateFile, returnBudgetChars = 6000, maxReturnChars = 100000, maxHistoryPages = 20, remote, store } = {}) {
    this.remote = remote ?? new RemoteOperations(targets);
    this.store = store ?? new LocalStore(required(stateFile, 'stateFile'));
    this.vault = new ResultVault(this.store);
    this.budget = count(returnBudgetChars,6000,100000); this.maximum = count(maxReturnChars,100000,1000000);
    if (this.budget < 1000 || this.maximum < this.budget) throw new Error('Return budgets require default >= 1000 and maximum >= default.');
    this.maxHistoryPages = count(maxHistoryPages,20,200); this.locks = new Map();
  }
  async resolve(args, kind = 'session') {
    let stored;
    if (args.ref) { stored = (await this.store.read()).refs[args.ref]; if (!stored) throw new Error('Saved reference not found. Use dsh_refs.'); }
    if (stored && stored.kind !== kind) throw new Error(`Expected a ${kind} reference.`);
    let instance = stored?.instance ?? args.instance;
    if (!instance && this.remote.list().length === 1) instance = this.remote.list()[0].id;
    required(instance,'instance'); const client = this.remote.client(instance);
    if (stored?.origin && stored.origin !== client.target.url) throw new Error('Saved reference belongs to a different target origin; update or recreate it explicitly.');
    for (const field of ['instance','sessionId','workspaceId']) if (stored?.[field] && args[field] && stored[field] !== args[field]) throw new Error(`Reference conflicts with supplied ${field}.`);
    return { ...args, instance, origin: client.target.url, sessionId: stored?.sessionId ?? args.sessionId, workspaceId: stored?.workspaceId ?? args.workspaceId };
  }
  key(args) { return sessionKey(args.instance,args.origin,required(args.sessionId,'sessionId')); }
  serialize(key, action) {
    const previous = this.locks.get(key) ?? Promise.resolve(); const result = previous.then(action,action);
    const tail = result.catch(() => {}); this.locks.set(key,tail);
    void tail.finally(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return result;
  }
  async fit(value, budget, ack, signal) {
    if (JSON.stringify({ data: value }).length > budget) return this.vault.hold(value,ack,signal);
    if (ack) await this.store.cursor(ack.key,ack.seq,signal,ack.epoch);
    return value;
  }
  async call(action, args = {}, signal) {
    signal?.throwIfAborted(); const budget = count(args.maxChars,this.budget,this.maximum);
    if (budget < 1000) throw new Error('maxChars return budget must be at least 1000.');
    if (action === 'status' && args.view && args.view !== 'state') {
      const target = await this.resolve(args); const key = this.key(target);
      return this.serialize(key,async () => {
        const { value, ack } = await this.readNew(target,signal);
        return this.fit(value,budget,ack,signal);
      });
    }
    let value;
    switch (action) {
      case 'create': value = await this.create(args,signal); break;
      case 'refs': value = await this.references(args,signal); break;
      case 'send': {
        const target = await this.resolve(args); value = await this.serialize(this.key(target),() => this.send(target,signal)); break;
      }
      case 'status': value = await this.state(await this.resolve(args),signal); break;
      case 'search': value = await this.search(args,signal); break;
      case 'other': value = await this.other(args,budget,signal); break;
      default: throw new Error('Unknown remote-control operation.');
    }
    return this.fit(value,budget,undefined,signal);
  }
  async saveRef(input,signal) {
    const client = this.remote.client(required(input.instance,'instance'));
    const kind = input.kind ?? (input.sessionId ? 'session' : 'workspace');
    if (!['session','workspace'].includes(kind)) throw new Error('kind must be session or workspace.');
    required(kind === 'session' ? input.sessionId : input.workspaceId,`${kind}Id`);
    for (const field of ['name','purpose','notes']) if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > 4000)) throw new Error(`${field} must be a string of at most 4000 characters.`);
    return this.store.transact(state => {
      const existing = Object.values(state.refs).find(r => r.instance === input.instance && r.origin === client.target.url && r.kind === kind && (kind === 'session' ? r.sessionId === input.sessionId : r.workspaceId === input.workspaceId));
      const ref = input.ref ?? existing?.ref ?? randomUUID(); const old = state.refs[ref];
      if (old && (old.instance !== input.instance || old.origin !== client.target.url || old.kind !== kind || old.sessionId !== input.sessionId || (input.workspaceId && old.workspaceId && old.workspaceId !== input.workspaceId))) throw new Error('A saved reference cannot be retargeted. Remove it or create another reference.');
      const entry = { ...old, ref, kind, instance: input.instance, origin: client.target.url, sessionId: input.sessionId, workspaceId: input.workspaceId ?? old?.workspaceId, name: input.name ?? old?.name ?? input.sessionId ?? input.workspaceId, purpose: input.purpose ?? old?.purpose ?? '', notes: input.notes ?? old?.notes ?? '', updatedAt: new Date().toISOString() };
      state.refs[ref] = entry; return entry;
    },signal);
  }
  async create(args,signal) {
    const kind = args.kind ?? 'session'; if (!['session','workspace'].includes(kind)) throw new Error('kind must be session or workspace.');
    let target;
    if (args.workspaceRef) target = await this.resolve({ ...args,ref:args.workspaceRef },'workspace');
    else target = await this.resolve(args,kind);
    for (const field of ['name','purpose','notes']) if (args[field] !== undefined && (typeof args[field] !== 'string' || args[field].length > 4000)) throw new Error(`${field} must be <= 4000 characters.`);
    delete target.ref;
    if (kind === 'workspace' || args.path) {
      const registered = await this.remote.call('workspaces',{ ...target,action:'create',path:required(args.path,'path') },signal);
      target.workspaceId = registered.workspace.workspaceId;
      if (kind === 'workspace') {
        const saved = await this.saveRef({ ...target,kind,name:args.name ?? registered.workspace.title,purpose:args.purpose,notes:args.notes },signal);
        return { ref:saved.ref,instance:target.instance,kind,workspace:workspaceSummary(registered.workspace),created:registered.created };
      }
    }
    target.sessionId = args.sessionId ?? randomUUID();
    const created = await this.remote.call('create',{ ...target,agentPreset:args.agentPreset,title:args.name },signal);
    try {
      const saved = await this.saveRef({ ...target,sessionId:created.sessionId,kind:'session',name:args.name,purpose:args.purpose,notes:args.notes },signal);
      return { ref:saved.ref,instance:target.instance,sessionId:created.sessionId,workspaceId:target.workspaceId,agentPreset:created.agentPreset };
    } catch { return { state:'created-without-reference',instance:target.instance,sessionId:created.sessionId,next:'Session was created but the local reference could not be saved. Use dsh_refs action=save.' }; }
  }
  async references(args,signal) {
    const action = args.action ?? 'list';
    if (action === 'save') return this.saveRef(await this.resolve(args,args.kind ?? (args.sessionId ? 'session' : 'workspace')),signal);
    if (['update','remove'].includes(action)) return this.store.transact(state => {
      const entry = state.refs[required(args.ref,'ref')]; if (!entry) throw new Error('Saved reference not found.');
      if (action === 'remove') { delete state.refs[args.ref]; return { removed:true,ref:args.ref }; }
      for (const field of ['name','purpose','notes']) if (args[field] !== undefined) { if (typeof args[field] !== 'string' || args[field].length > 4000) throw new Error(`${field} must be <= 4000 characters.`); entry[field] = args[field]; }
      entry.updatedAt = new Date().toISOString(); return entry;
    },signal);
    const state = await this.store.read();
    if (action === 'get') { const entry = state.refs[required(args.ref,'ref')]; if (!entry) throw new Error('Saved reference not found.'); return entry; }
    if (action !== 'list') throw new Error('Unknown reference action.');
    const query = (args.query ?? '').toLowerCase();
    const entries = Object.values(state.refs).filter(r => (!args.instance || r.instance === args.instance) && `${r.ref} ${r.name} ${r.purpose} ${r.notes}`.toLowerCase().includes(query)).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    return page(entries.map(refSummary),args.offset,count(args.limit,10,50));
  }
  async send(args,signal) {
    required(args.message,'message'); const key = this.key(args);
    const settings = await this.configure(args,signal);
    const requestId = args.requestId ?? randomUUID();
    await this.store.transact(state => { state.sessions[key] ??= {readSeq:-1}; state.sessions[key].lastReceipt = {requestId,sessionId:args.sessionId,accepted:'unknown'}; },signal);
    let receipt;
    try { receipt = await this.remote.call('send',{...args,requestId},signal); }
    catch (error) { if (error.code === 'transport-uncertain') return {accepted:'unknown',instance:args.instance,sessionId:args.sessionId,requestId,next:'Inspect this session before retrying; reuse this requestId if resending.'}; throw error; }
    let receiptSaved = true;
    try { await this.store.transact(state => { state.sessions[key].lastReceipt = receipt; },signal); }
    catch { receiptSaved = false; }
    return { ...receipt,instance:args.instance,settings,remoteWorkContinues:true,receiptSaved };
  }
  async configure(args,signal) {
    if (!args.provider && !args.model && !args.reasoningEffort && !args.permissionPreset) return undefined;
    if (Boolean(args.provider) !== Boolean(args.model) || (args.reasoningEffort && !args.model)) throw new Error('provider and model must be supplied together; reasoningEffort requires a model.');
    const client = this.remote.client(args.instance);
    const listing = await client.rpc('session/list',{_request:{}},signal); const current = listing.items.find(x => x.sessionId === args.sessionId);
    if (!current) throw new Error('Remote session not found.');
    if (current.running) throw new Error('Cannot change settings on a running session. Send without settings or wait until it is idle.');
    if (args.permissionPreset) {
      if (!/^[a-zA-Z0-9_-]+$/.test(args.permissionPreset)) throw new Error('Invalid permission preset id.');
      const permissions = await client.rpc('permissionPresets/catalog',{},signal);
      if (!permissions.options.some(x => x.value === args.permissionPreset)) throw new Error('Unknown permissionPreset; query permission_catalog.');
    }
    if (args.model) await this.remote.call('model',args,signal);
    if (args.permissionPreset) {
      await this.remote.call('read',{...args,maxMessages:1},signal);
      const execution = await client.rpc('commands/execute',{agentId:args.sessionId,line:`/permission ${args.permissionPreset}`,submittedAttachments:[]},signal);
      if (!execution || execution.result?.kind !== 'success') throw new Error('Permission change was not accepted. No message was sent; inspect settings before retrying.');
    }
    const projections = await this.remote.call('status',args,signal); const values = projections?.values;
    if (args.permissionPreset && values?.permissions?.currentValue !== args.permissionPreset) throw new Error('Permission setting could not be verified. No message was sent.');
    const model = values?.modelSelection?.next;
    if (args.model && (!model || model.provider !== args.provider || model.model !== args.model || (args.reasoningEffort && model.reasoningEffort !== args.reasoningEffort))) throw new Error('Model setting could not be verified. No message was sent.');
    return {model,permissionPreset:values?.permissions?.currentValue,scope:'persistent-session',modelMayChangeDeploymentDefault:Boolean(args.model)};
  }
  async state(args,signal) {
    const client = this.remote.client(args.instance); const projections = await this.remote.call('status',args,signal);
    if (!projections) throw new Error('Remote session not found.');
    const listing = await client.rpc('session/list',{_request:{}},signal); const summary = listing.items.find(item => item.sessionId === args.sessionId);
    const pending = await this.remote.call('interactions',args,signal);
    const values = projections.values ?? {}; const saved = (await this.store.read()).sessions[this.key(args)];
    const queuedMessages = (values.inbox?.['next-turn']?.length ?? 0)+(values.inbox?.['next-step']?.length ?? 0);
    return { instance:args.instance,sessionId:args.sessionId,state:pending.items.length ? 'needs-input' : summary?.running ? 'running' : queuedMessages ? 'queued' : summary ? 'idle' : 'unknown',
      running:summary?.running ?? null,title:short(values.title),cursor:projections.asOfSeq,readSeq:saved?.readSeq ?? -1,unreadEvents:Math.max(0,projections.asOfSeq-(saved?.readSeq??-1)),
      pendingInteractions:pending.items.length,queuedMessages,
      model:values.modelSelection?.next,permissionPreset:values.permissions?.currentValue,lastReceipt:saved?.lastReceipt };
  }
  async readNew(args,signal) {
    if (!['new','final'].includes(args.view)) throw new Error('view must be state, new or final.');
    const key = this.key(args); const stored = (await this.store.read()).sessions[key];
    const afterSeq = args.afterSeq ?? (args.view==='final' ? -1 : stored?.readSeq ?? -1);
    if (!Number.isInteger(afterSeq) || afterSeq < -1) throw new Error('afterSeq must be an integer >= -1.');
    const projections = await this.remote.call('status',args,signal); if (!projections) throw new Error('Remote session not found.');
    const throughSeq = args.throughSeq ?? projections.asOfSeq;
    if (!Number.isInteger(throughSeq) || throughSeq < -1 || throughSeq > projections.asOfSeq || afterSeq > throughSeq) throw new Error('Invalid history cut or cursor. Use reset_read explicitly if remote history changed.');
    if (afterSeq === throughSeq) return {value:{instance:args.instance,sessionId:args.sessionId,afterSeq,throughSeq,messages:[],hasMore:false}};
    let beforeSeq,rows=[];
    for (let index=0;index<this.maxHistoryPages;index++) {
      const batch = await this.remote.call('read',{...args,throughSeq,beforeSeq,maxMessages:100,raw:true},signal);
      const oldest = Math.min(...batch.records.map(r=>r.event?.seq).filter(Number.isInteger));
      rows = [...batch.records.filter(r=>r.event?.seq>afterSeq),...rows];
      if (args.view==='final' && rows.some(r=>r.event?.type==='assistant/message' && r.event.data.message?.content?.some(b=>b.type==='text'))) break;
      if (!batch.hasMore || oldest <= afterSeq+1) break;
      if (!Number.isFinite(oldest) || (beforeSeq!==undefined && oldest>=beforeSeq)) throw new Error('Remote history pagination did not advance. Cursor unchanged.');
      beforeSeq=oldest;
      if (index===this.maxHistoryPages-1) return {value:{state:'history-scan-limit',omitted:true,afterSeq,throughSeq,cursorUnchanged:true,next:'Choose an explicit later afterSeq, use read_history pages, or increase configured maxHistoryPages.'}};
    }
    let messages=rows.flatMap(row=>{
      const event=row.event;
      if (event.type==='assistant/message') {
        const content=event.data.message?.content?.filter(b=>b.type==='text') ?? [];
        return content.length ? [{seq:event.seq,role:'assistant',content}] : [];
      }
      if (args.includeTools && event.type==='tool/result') return [{seq:event.seq,role:'tool',content:event.data.message?.content,isError:event.data.message?.isError}];
      if (args.includeUser && event.type==='user/message' && event.data?.source?.kind==='user') return [{seq:event.seq,role:'user',content:event.data.content}];
      return [];
    });
    if (args.view==='final') messages=messages.filter(m=>m.role==='assistant').slice(-1);
    return {value:{instance:args.instance,sessionId:args.sessionId,afterSeq,throughSeq,messages,hasMore:false,consumesUnread:args.view==='new'&&args.afterSeq===undefined},
      ack:args.view==='new'&&args.afterSeq===undefined?{key,seq:throughSeq,epoch:stored?.readEpoch??0}:undefined};
  }
  async search(args,signal) {
    const scope=args.scope??'saved';
    if(scope==='saved')return this.references({...args,action:'list'},signal);
    if(!['sessions','workspaces'].includes(scope))throw new Error('scope must be saved, sessions or workspaces.');
    const target=await this.resolve(args,scope==='workspaces'?'workspace':'session');
    const query=(args.query??'').toLowerCase();let items;
    if(scope==='workspaces')items=(await this.remote.call('workspaces',target,signal)).items.map(workspaceSummary);
    else {
      items=(await this.remote.client(target.instance).rpc('session/list',{_request:{}},signal)).items;
      if(args.workspaceId){const ws=(await this.remote.call('workspaces',target,signal)).items.find(w=>w.workspaceId===args.workspaceId);if(!ws)throw new Error('Workspace not found.');items=items.filter(s=>ws.sessionIds.includes(s.sessionId));}
      items=items.map(sessionSummary);
    }
    items=items.filter(item=>JSON.stringify(item).toLowerCase().includes(query));
    return {instance:target.instance,...page(items,args.offset,count(args.limit,10,50))};
  }
  async other(args,budget,signal) {
    const action=args.action??'help';
    if(action==='list'||!args.operation)return {operations:Object.entries(extraOperations).map(([operation,detail])=>({operation,description:detail.description}))};
    const help=extraOperations[args.operation];if(!help)throw new Error('Unknown operation; use dsh_other action=list.');
    if(action==='help')return {operation:args.operation,...help};
    if(action!=='execute')throw new Error('action must be list, help or execute.');
    let input;try{input=JSON.parse(args.args??'{}');}catch{throw new Error('args must be a JSON object string.');}
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('args must be a JSON object string.');
    if(args.operation==='result')return this.vault.retrieve(input,budget,signal);
    if(args.operation==='instances')return {instances:this.remote.list()};
    const target=await this.resolve(input);const client=this.remote.client(target.instance);
    switch(args.operation){
      case 'workspaces':case 'sessions':return this.search({...target,scope:args.operation},signal);
      case 'catalog':return this.remote.call('catalog',target,signal);
      case 'permission_catalog':return client.rpc('permissionPresets/catalog',{},signal);
      case 'search_content':{const result=await client.rpc('session/search',{request:{query:required(input.query,'query')}},signal);return {...result,items:result.items.slice(0,count(input.limit,10,20))};}
      case 'read_history':return this.remote.call('read',target,signal);
      case 'cancel':case 'interactions':case 'respond':return this.remote.call(args.operation,target,signal);
      case 'settings':return this.serialize(this.key(target),()=>this.configure(target,signal));
      case 'reset_read':{const seq=input.afterSeq??-1;if(!Number.isInteger(seq)||seq < -1)throw new Error('afterSeq must be >= -1.');return this.serialize(this.key(target),()=>this.store.transact(state=>{const key=this.key(target);state.sessions[key]??={};state.sessions[key].readSeq=seq;state.sessions[key].readEpoch=(state.sessions[key].readEpoch??0)+1;return {readSeq:seq};},signal));}
      case 'wait':{
        const receipt=(await this.store.read()).sessions[this.key(target)]?.lastReceipt;
        const result=await this.remote.call('wait',{...target,requestId:input.requestId??receipt?.requestId,afterSeq:input.afterSeq??receipt?.afterSeq??-1,timeoutSeconds:input.timeoutSeconds??15},signal);
        return {state:result.state,sessionId:target.sessionId,cursor:result.snapshot.cursor,pendingInteractions:result.interactions.length};
      }
      default:throw new Error('Operation has no implementation.');
    }
  }
  close(){this.remote.close();}
}
