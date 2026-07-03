#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const dataDir = path.join(root, '.data');
const runtimePort = Number(process.env.RUNTIME_PORT || 3852);
const webPort = Number(process.env.PORT || 3842);
const host = '127.0.0.1';

await mkdir(dataDir, { recursive:true });
const adminPassword = await secretFile(path.join(dataDir, 'local-admin-password'), () => `agentdeck-${crypto.randomBytes(12).toString('base64url')}`);
const cookieSecret = await secretFile(path.join(dataDir, 'local-cookie-secret'), () => crypto.randomBytes(32).toString('base64url'));
const runtimeToken = await secretFile(path.join(dataDir, 'local-runtime-token'), () => crypto.randomBytes(32).toString('base64url'));

await run('npm', ['run', 'build'], { stdio:'inherit' });

const commonEnv = {
  ...process.env,
  DATA_DIR: dataDir,
  RUNTIME_DATA_DIR: dataDir,
  RUNTIME_DB: path.join(dataDir, 'agentdeck-runtime.sqlite3'),
  RUNTIME_TOKEN: runtimeToken,
  AGENT_RUNTIME_TOKEN: runtimeToken,
  AGENT_RUNTIME_URL: `http://${host}:${runtimePort}`,
  COOKIE_SECRET: cookieSecret,
  ADMIN_PASSWORD: adminPassword,
  USE_AGENT_RUNTIME: '1',
  HOST: host,
  PORT: String(webPort),
  RUNTIME_HOST: host,
  RUNTIME_PORT: String(runtimePort),
  ALLOWED_ORIGINS: `http://${host}:${webPort},http://localhost:${webPort}`,
};

const children = [
  spawn(process.execPath, ['server/dist/agentdeck-runtime.js'], { cwd:root, env:commonEnv, stdio:['ignore', 'pipe', 'pipe'] }),
  spawn(process.execPath, ['server/dist/index.js'], { cwd:root, env:commonEnv, stdio:['ignore', 'pipe', 'pipe'] }),
];

for (const child of children) {
  child.stdout.on('data', chunk => process.stdout.write(prefix(child, chunk)));
  child.stderr.on('data', chunk => process.stderr.write(prefix(child, chunk)));
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`\nlocal process exited: pid=${child.pid} code=${code} signal=${signal}`);
    shutdown(code || 1);
  });
}

console.log('');
console.log('AgentDeck local mode');
console.log(`URL: http://${host}:${webPort}`);
console.log(`Admin username: admin`);
console.log(`Admin password: ${adminPassword}`);
console.log(`Data dir: ${dataDir}`);
console.log('Press Ctrl+C to stop.');
console.log('');

let shuttingDown = false;
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill('SIGKILL');
    }
    process.exit(code);
  }, 2500).unref();
}

async function secretFile(file, create) {
  if (existsSync(file)) return (await readFile(file, 'utf8')).trim();
  const value = create();
  await writeFile(file, `${value}\n`, { mode:0o600 });
  return value;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd:root, ...options });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)));
    child.on('error', reject);
  });
}

function prefix(child, chunk) {
  const label = children.indexOf(child) === 0 ? 'runtime' : 'web';
  return String(chunk).split(/\n/).map((line, index, arr) => {
    if (!line && index === arr.length - 1) return '';
    return `[${label}] ${line}`;
  }).join('\n');
}
