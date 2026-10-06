import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RemoteController } from './controller.js';
export const name = 'remote-dsh-control';
export const inject = ['tools'];

const str = description => ({ type:'string',description });
const integer = description => ({ type:'integer',description });
const choice = values => ({ type:'string',enum:values });
const instance = str('Target id; omit when only one target is configured.');
const ref = str('Saved reference id. Reuse without listing remote sessions.');
const sessionId = str('Remote session id, used with instance instead of ref.');
const maxChars = integer('Return budget override, default 6000, max 100000 characters.');
const selection = { provider:str('With model; persists on session.'),model:str('With provider; DSH may also save its default.'),reasoningEffort:str('With model.'),permissionPreset:str('Explicit persistent session permission preset.') };
const specifications = [
  ['create','dsh_create','Create a remote session or register an existing workspace directory. Save its reference. No message is sent.',{ kind:choice(['session','workspace']),instance,workspaceRef:str('Saved workspace reference.'),workspaceId:str('Remote workspace id.'),path:str('Existing absolute directory on target host.'),sessionId,agentPreset:str('Optional preset id.'),name:str('Reference name and session title.'),purpose:str('Intent.'),notes:str('Notes.'),maxChars },[]],
  ['refs','dsh_refs','Read or maintain persistent local references and notes. Lists are compact and paginated; get returns details.',{ action:choice(['list','get','save','update','remove']),ref,instance,kind:choice(['session','workspace']),sessionId,workspaceId:str('For saving a workspace reference.'),name:str('Name.'),purpose:str('Intent.'),notes:str('Notes.'),query:str('Search local references.'),offset:integer('Page offset.'),limit:integer('Default 10, max 50.'),maxChars },[]],
  ['send','dsh_send','Send to another DSH; return its receipt immediately. Remote work continues independently. Optional settings persist; failed settings prevent sending.',{ ref,instance,sessionId,message:str('Message to send.'),mode:choice(['queue','steer']),requestId:str('Optional recovery id.'),...selection,maxChars },['message']],
  ['status','dsh_status','Default: status only, no reply body or wait. new reads unseen replies; final previews latest reply without consuming unread history. Oversized content is held.',{ ref,instance,sessionId,view:choice(['state','new','final']),includeTools:{ type:'boolean',description:'Include tool results, default false.' },includeUser:{ type:'boolean',description:'Include user messages, default false.' },afterSeq:integer('Explicit read cursor; saved cursor unchanged.'),throughSeq:integer('Optional fixed history cut.'),maxChars },[]],
  ['search','dsh_search','Search saved references by default; opt into remote session titles/paths or workspace names. Compact paginated rows.',{ query:str('Search text.'),scope:choice(['saved','sessions','workspaces']),instance,workspaceId:str('Optional remote session filter.'),offset:integer('Page offset.'),limit:integer('Default 10, max 50.'),maxChars },[]],
  ['other','dsh_other','Discover other operations on demand. Default help; execute runs operation with args as a JSON object string. Includes target catalog, history, optional wait, cancel, questions, settings and held results.',{ action:choice(['list','help','execute']),operation:str('Operation name; omit to list.'),args:str('JSON object string for execute; follow operation help.'),maxChars },[]],
];

export function createToolDefinitions(controller) {
  return specifications.map(([action,name,description,properties,required]) => ({
    name,description,parameters:{ type:'object',properties,required,additionalProperties:false },
    output:{ schema:{ type:'object',additionalProperties:true },render:(_args,value) => [{ type:'text',text:JSON.stringify(value) }] },
    async execute(args,exec) {
      // Omit absent optional fields before DSH's lossless-JSON validation.
      return JSON.parse(JSON.stringify({ data:(await controller.call(action,args,exec.signal)) ?? null }));
    },
  }));
}

export async function apply(ctx,config={}) {
  const directory=join(process.env.DSH_HOME || join(homedir(),'.dsh'),'remote-control');
  let targets=config.targets;
  if (!targets) {
    try { targets=JSON.parse((await readFile(config.connectionsFile ?? join(directory,'connections.json'),'utf8')).replace(/^\uFEFF/,'')).targets; }
    catch(error) { if (error.code==='ENOENT') targets=[]; else throw error; }
  }
  if (!Array.isArray(targets)) throw new Error('remote-dsh-control: targets must be an array.');
  const controller=new RemoteController(targets,{ stateFile:config.stateFile ?? join(directory,'state.json'),returnBudgetChars:config.returnBudgetChars,maxReturnChars:config.maxReturnChars,maxHistoryPages:config.maxHistoryPages });
  ctx.effect(() => () => controller.close(),'remote-dsh-control.connections');
  for (const tool of createToolDefinitions(controller)) ctx.tools.register(tool);
}
