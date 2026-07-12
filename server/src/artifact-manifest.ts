import crypto from 'node:crypto';
import path from 'node:path';
import {readFile,readdir,stat} from 'node:fs/promises';
import {realpathSync} from 'node:fs';

export type ArtifactManifestEntry={path:string;relativePath:string;name:string;mime:string;size:number;contentHash?:string;modifiedAt:number};
export async function buildArtifactManifest(root:string,options:{types:Record<string,string>;skipDirs:Set<string>;isInternal:(relativePath:string)=>boolean;previous?:Record<string,ArtifactManifestEntry>;maxFiles?:number;maxBytes?:number;maxDepth?:number}){
  const out:ArtifactManifestEntry[]=[];await walk(root,root,out,options,0);return Object.fromEntries(out.map(file=>[file.relativePath,file]));
}
async function walk(root:string,dir:string,out:ArtifactManifestEntry[],options:any,depth:number){
  if(depth>(options.maxDepth??5)||out.length>=(options.maxFiles??200))return;let entries:any[]=[];try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}
  for(const entry of entries){if(out.length>=(options.maxFiles??200))break;if(entry.name.startsWith('.')&&entry.name!=='.codex')continue;if(entry.isDirectory()){if(!options.skipDirs.has(entry.name))await walk(root,path.join(dir,entry.name),out,options,depth+1);continue;}if(!entry.isFile())continue;
    const filePath=path.join(dir,entry.name),ext=artifactExt(filePath),mime=options.types[ext];if(!mime)continue;const relativePath=path.relative(root,filePath);if(options.isInternal(relativePath))continue;let fileStat;try{fileStat=await stat(filePath);}catch{continue;}if(fileStat.size<=0||fileStat.size>(options.maxBytes??25*1024*1024))continue;let realPath;try{realPath=realpathSync(filePath);}catch{continue;}if(!realPath.startsWith(root+path.sep))continue;
    const normalizedRelative=path.relative(root,realPath),modifiedAt=Math.floor(fileStat.mtimeMs),previous=options.previous?.[normalizedRelative];let contentHash=previous?.contentHash;
    if(!previous||previous.size!==fileStat.size||previous.modifiedAt!==modifiedAt||!contentHash)contentHash=crypto.createHash('sha256').update(await readFile(realPath)).digest('hex');
    out.push({path:realPath,relativePath:normalizedRelative,name:path.basename(realPath),mime,size:fileStat.size,contentHash,modifiedAt});
  }
}
function artifactExt(filePath:string){const lower=filePath.toLowerCase();return lower.endsWith('.tar.gz')?'.tar.gz':path.extname(lower);}

export function artifactContentChanged(previous:ArtifactManifestEntry,current:ArtifactManifestEntry){
  return previous.contentHash ? previous.contentHash!==current.contentHash : previous.size!==current.size;
}

export function isArtifactTestAssetPath(relativePath:string){
  const normalized=String(relativePath||'').split(path.sep).filter(Boolean).join('/');
  return normalized==='client/public/test-assets'||normalized.startsWith('client/public/test-assets/')||normalized==='server/public/test-assets'||normalized.startsWith('server/public/test-assets/');
}
