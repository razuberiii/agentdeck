import path from 'node:path';
import { constants, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';

export const ANTIGRAVITY_CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT = '2h';

export type AntigravityCliOptions={prompt:string;model?:string|null;mode?:string|null;yolo?:boolean;conversationId?:string|null;logFile:string;printTimeout?:string;addDirs?:string[]};

export function buildAntigravityArgs(options:AntigravityCliOptions) {
  const args:string[]=[];
  if(options.model)args.push('--model',String(options.model));
  args.push('--mode',options.mode==='plan'?'plan':'accept-edits');
  if(options.yolo&&options.mode!=='plan')args.push('--dangerously-skip-permissions');
  if(options.conversationId){
    if(!ANTIGRAVITY_CONVERSATION_ID.test(options.conversationId))throw new Error('invalid Antigravity conversation id');
    args.push('--conversation',options.conversationId);
  }
  for(const dir of [...new Set(options.addDirs||[])])args.push('--add-dir',dir);
  args.push('--log-file',options.logFile,'--print-timeout',options.printTimeout||DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT,'--print',options.prompt);
  return args;
}

export async function resolveAntigravityBinary(options:{configured?:string;dataDir:string;homeDir?:string;pathEnv?:string}){
  const names=[options.configured,path.join(options.dataDir,'provider-tools','bin','agy'),options.homeDir?path.join(options.homeDir,'.local','bin','agy'):'','agy'].filter(Boolean) as string[];
  for(const name of names){
    const candidates=name.includes(path.sep)?[name]:String(options.pathEnv||process.env.PATH||'').split(path.delimiter).filter(Boolean).map(dir=>path.join(dir,name));
    for(const candidate of candidates)try{await access(candidate,constants.X_OK);return candidate;}catch{}
  }
  throw new Error('provider_binary_not_found: Antigravity binary was not found');
}

export function parseAntigravityConversation(log:string) {
  const matches=[...String(log||'').matchAll(/(?:Created conversation|Print mode:\s*conversation=)([0-9a-f-]{36})/ig)];
  const id=matches.at(-1)?.[1]||null;
  return id&&ANTIGRAVITY_CONVERSATION_ID.test(id)?id:null;
}

export function antigravityConversationExists(homeDir:string,id:string) {
  return ANTIGRAVITY_CONVERSATION_ID.test(id)&&existsSync(path.join(homeDir,'.gemini','antigravity-cli','conversations',`${id}.db`));
}

export function antigravityResumeOutcome(requested:string|null,actual:string|null) {
  if(!actual)return {ok:false,recreated:false,reason:'conversation_id_not_observed'};
  if(!requested)return {ok:true,recreated:false,reason:null};
  if(requested===actual)return {ok:true,recreated:false,reason:null};
  return {ok:false,recreated:true,reason:'requested_conversation_not_resumed'};
}

export function antigravityMetadata(raw:any,patch:Record<string,any>={}){
  let current:any={};
  try{current=typeof raw==='string'?JSON.parse(raw):raw||{};}catch{current={metadataCorrupt:true};}
  return {...current,...patch,provider:'antigravity'};
}
