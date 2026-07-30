import path from 'node:path';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';

const MAX_AUTH_FILE_BYTES = 1024 * 1024;

export async function adoptExistingCodexAuth(
  userHome:string,
  managedCodexHome:string,
):Promise<boolean> {
  const source = path.resolve(userHome, '.codex', 'auth.json');
  const target = path.resolve(managedCodexHome, 'auth.json');
  if (source === target) return false;

  let sourceStat;
  try {
    sourceStat = await lstat(source);
  } catch (error:any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > MAX_AUTH_FILE_BYTES) return false;
  if (typeof process.getuid === 'function' && sourceStat.uid !== process.getuid()) return false;

  const auth = await readFile(source);
  try {
    JSON.parse(auth.toString('utf8'));
  } catch {
    return false;
  }

  await mkdir(managedCodexHome, { recursive:true, mode:0o700 });
  await chmod(managedCodexHome, 0o700);
  try {
    await writeFile(target, auth, { flag:'wx', mode:0o600 });
  } catch (error:any) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
  await chmod(target, 0o600);
  return true;
}
