import { realpath, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export type Project = { name:string; path:string; branch:string|null; updatedAt:number };
export async function existingRoots(list: string[]) { const out:string[]=[]; for (const p of list) { try { const s=await stat(p); if (s.isDirectory()) out.push(await realpath(p)); } catch {} } return out; }
export async function validateProject(input:string, roots:string[]) { const rp = await realpath(input); if (!roots.some(r => rp === r || rp.startsWith(r + path.sep))) throw new Error('project path is outside allowed workspace roots'); return rp; }
export async function scanProjects(roots:string[], limit=80): Promise<Project[]> {
  const found:Project[]=[];
  for (const root of roots) await walk(root, 0);
  async function walk(dir:string, depth:number) {
    if (found.length >= limit || depth > 3) return;
    let entries; try { entries = await readdir(dir, { withFileTypes:true }); } catch { return; }
    if (entries.some(e => e.isDirectory() && e.name === '.git')) { found.push(await projectInfo(dir)); return; }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules','vendor','tmp','log','cache'].includes(e.name)) await walk(path.join(dir,e.name), depth+1);
  }
  return found.sort((a,b)=>b.updatedAt-a.updatedAt);
}
async function projectInfo(dir:string): Promise<Project> { let branch:null|string=null; try { const {stdout}=await execFileAsync('git',['-C',dir,'branch','--show-current']); branch=stdout.trim()||null; } catch {} let updatedAt=Date.now(); try { updatedAt=(await stat(path.join(dir,'.git'))).mtimeMs; } catch {} return { name:path.basename(dir), path:dir, branch, updatedAt }; }
export async function gitBranch(dir:string) { try { const {stdout}=await execFileAsync('git',['-C',dir,'branch','--show-current']); return stdout.trim()||null; } catch { return null; } }
export async function gitDiff(dir:string) { try { const {stdout}=await execFileAsync('git',['-C',dir,'diff','--no-ext-diff'], {maxBuffer: 1024*1024*10}); return stdout; } catch { return ''; } }
