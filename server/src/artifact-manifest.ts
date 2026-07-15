import crypto from 'node:crypto';
import path from 'node:path';
import {readFile,readdir,stat} from 'node:fs/promises';
import {realpathSync} from 'node:fs';

export type ArtifactManifestEntry={path:string;relativePath:string;name:string;mime:string;size:number;contentHash?:string;modifiedAt:number};
export async function buildArtifactManifest(root:string,options:{types:Record<string,string>;skipDirs:Set<string>;isInternal:(relativePath:string)=>boolean;previous?:Record<string,ArtifactManifestEntry>;maxFiles?:number;maxBytes?:number;maxDepth?:number;includeAll?:boolean}){
  const out:ArtifactManifestEntry[]=[];await walk(root,root,out,options,0);return Object.fromEntries(out.map(file=>[file.relativePath,file]));
}
async function walk(root:string,dir:string,out:ArtifactManifestEntry[],options:any,depth:number){
  if(depth>(options.maxDepth??5)||out.length>=(options.maxFiles??200))return;let entries:any[]=[];try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}
  for(const entry of entries){if(out.length>=(options.maxFiles??200))break;if(entry.name.startsWith('.')&&entry.name!=='.codex')continue;if(entry.isDirectory()){if(!options.skipDirs.has(entry.name))await walk(root,path.join(dir,entry.name),out,options,depth+1);continue;}if(!entry.isFile())continue;
    const filePath=path.join(dir,entry.name),ext=artifactExt(filePath),mime=options.types[ext]||(options.includeAll?'application/octet-stream':'');if(!mime)continue;const relativePath=path.relative(root,filePath);if(options.isInternal(relativePath))continue;let fileStat;try{fileStat=await stat(filePath);}catch{continue;}if((!options.includeAll&&fileStat.size<=0)||fileStat.size>(options.maxBytes??25*1024*1024))continue;let realPath;try{realPath=realpathSync(filePath);}catch{continue;}if(!realPath.startsWith(root+path.sep))continue;
    const normalizedRelative=path.relative(root,realPath),modifiedAt=Math.floor(fileStat.mtimeMs),previous=options.previous?.[normalizedRelative];let contentHash=previous?.contentHash;
    if(!previous||previous.size!==fileStat.size||previous.modifiedAt!==modifiedAt||!contentHash)contentHash=crypto.createHash('sha256').update(await readFile(realPath)).digest('hex');
    out.push({path:realPath,relativePath:normalizedRelative,name:path.basename(realPath),mime,size:fileStat.size,contentHash,modifiedAt});
  }
}
function artifactExt(filePath:string){const lower=filePath.toLowerCase();return lower.endsWith('.tar.gz')?'.tar.gz':path.extname(lower);}

export function artifactContentChanged(previous:ArtifactManifestEntry,current:ArtifactManifestEntry){
  return previous.contentHash ? previous.contentHash!==current.contentHash : previous.size!==current.size;
}
export function artifactPathIsProjectFile(relativePath:string){const normalized=String(relativePath||'').split(path.sep).join('/'),base=path.posix.basename(normalized);return ['package.json','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','tsconfig.json','deploy-manifest.json','composer.json','pyproject.toml','Cargo.toml','go.mod','go.sum'].includes(base)||/^tsconfig\..+\.json$/i.test(base)||/^(vite|eslint)\.config\./i.test(base)||/^\.eslintrc/i.test(base);}
export function artifactEligibleForDownload(relativePath:string,operation:string){if(operation!=='created'||artifactPathIsProjectFile(relativePath))return false;const normalized=String(relativePath||'').split(path.sep).join('/'),ext=artifactExt(normalized);if(['.json','.txt','.log'].includes(ext))return /^(?:output|outputs|reports|artifacts)\//i.test(normalized);return ['.csv','.patch','.diff','.zip','.tar.gz','.conf','.png','.jpg','.jpeg','.webp'].includes(ext);}
export function workspaceCodeChanges(before:Record<string,ArtifactManifestEntry>,after:Record<string,ArtifactManifestEntry>){const changes:any[]=[];for(const relativePath of Object.keys(before)){const old=before[relativePath],next=after[relativePath];if(!next)changes.push({status:'D',path:relativePath,contentHash:old.contentHash});else if(artifactContentChanged(old,next))changes.push({status:'M',path:relativePath,contentHash:next.contentHash});}for(const relativePath of Object.keys(after))if(!before[relativePath])changes.push({status:'A',path:relativePath,contentHash:after[relativePath].contentHash});const deleted=changes.filter(change=>change.status==='D'),added=changes.filter(change=>change.status==='A');for(const from of deleted)for(const to of added)if(from.status==='D'&&to.status==='A'&&from.contentHash&&from.contentHash===to.contentHash){from.status='R';from.toPath=to.path;to.status='';break;}return changes.filter(change=>change.status).map(({contentHash,...change})=>change).sort((a,b)=>String(a.path).localeCompare(String(b.path)));}
export function workspaceCodeChangesForDisplay(before:Record<string,ArtifactManifestEntry>,after:Record<string,ArtifactManifestEntry>,downloadableCreatedPaths:Set<string>){return workspaceCodeChanges(before,after).filter((change:any)=>!(change.status==='A'&&downloadableCreatedPaths.has(String(change.path))));}

export function isArtifactTestAssetPath(relativePath:string){
  const normalized=String(relativePath||'').split(path.sep).filter(Boolean).join('/');
  return normalized==='client/public/test-assets'||normalized.startsWith('client/public/test-assets/')||normalized==='server/public/test-assets'||normalized.startsWith('server/public/test-assets/');
}
