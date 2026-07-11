import path from 'node:path';
import crypto from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';

export type FilePermissionMode='read-only'|'plan'|'workspace-write'|'full-access'|'yolo';
const MAX_READ=2*1024*1024; const MAX_WRITE=2*1024*1024;

export async function readSessionTextFile(cwd:string,attachmentRoot:string,requestedPath:string,line=1,limit:number|null=null){
  const target=await resolveReadable(cwd,attachmentRoot,requestedPath);
  const info=await stat(target); if(!info.isFile())throw new Error('not a regular file'); if(info.size>MAX_READ)throw new Error('file exceeds read limit');
  const bytes=await readFile(target); if(bytes.subarray(0,8192).includes(0))throw new Error('binary file cannot be read as text');
  const lines=bytes.toString('utf8').split(/\r?\n/); const start=Math.max(0,line-1); return lines.slice(start,start+Math.min(limit||2000,2000)).join('\n');
}

export async function writeSessionTextFile(cwd:string,requestedPath:string,content:string,mode:FilePermissionMode){
  if(mode==='read-only'||mode==='plan')throw new Error('write denied by read-only session policy');
  if(Buffer.byteLength(content)>MAX_WRITE)throw new Error('content exceeds write limit');
  const root=await realpath(cwd); const target=path.resolve(cwd,requestedPath);
  if(mode!=='full-access'&&mode!=='yolo'&&!inside(root,target))throw new Error('path outside workspace');
  const parent=path.dirname(target); await createVerifiedParents(root,parent,mode==='full-access'||mode==='yolo');
  try{const existing=await lstat(target);if(existing.isSymbolicLink()||!existing.isFile())throw new Error('unsafe write target');}catch(error:any){if(error?.code!=='ENOENT')throw error;}
  const verifiedParent=await realpath(parent); if(mode!=='full-access'&&mode!=='yolo'&&!inside(root,verifiedParent))throw new Error('parent escaped workspace');
  const temp=path.join(verifiedParent,`.agentdeck-${process.pid}-${crypto.randomUUID()}.tmp`); const handle=await open(temp,'wx',0o600);
  try{await handle.writeFile(content,'utf8');await handle.sync();await handle.close();await rename(temp,target);}catch(error){await handle.close().catch(()=>{});await rm(temp,{force:true}).catch(()=>{});throw error;}
}

async function resolveReadable(cwd:string,attachmentRoot:string,requestedPath:string){
  const root=await realpath(cwd); const attachment=await realpath(attachmentRoot).catch(()=>null); const candidate=path.resolve(cwd,requestedPath); const target=await realpath(candidate);
  if(inside(root,target)||(attachment&&inside(attachment,target)))return target; throw new Error('path outside allowed session roots');
}
async function createVerifiedParents(root:string,parent:string,unrestricted:boolean){
  if(unrestricted){await mkdir(parent,{recursive:true});return;}
  if(!inside(root,parent))throw new Error('path outside workspace');
  const relative=path.relative(root,parent);let current=root;
  for(const part of relative.split(path.sep).filter(Boolean)){current=path.join(current,part);try{const info=await lstat(current);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('unsafe parent path');}catch(error:any){if(error?.code!=='ENOENT')throw error;await mkdir(current,{mode:0o755});}}
}
function inside(root:string,target:string){return target===root||target.startsWith(root+path.sep);}
