import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('unauthenticated web status is minimal and runtime is healthy',async()=>{
  const webPort=await freePort(),runtimePort=await freePort(),root=await mkdtemp(path.join(os.tmpdir(),'agentdeck-status-e2e-')),data=path.join(root,'data'),common={...process.env,DATA_DIR:data,RUNTIME_DB:path.join(data,'runtime.sqlite3'),RUNTIME_PORT:String(runtimePort),AGENT_RUNTIME_URL:`http://127.0.0.1:${runtimePort}`,RUNTIME_RUN_DIR:path.join(root,'run'),NODE_ENV:'production'};
  const runtime=spawn(process.execPath,['server/dist/agentdeck-runtime.js'],{cwd:process.cwd(),env:{...common,RUNTIME_HOST:'127.0.0.1',SKIP_RUNTIME_BOOTSTRAP:'1'},stdio:['ignore','pipe','pipe']}),web=spawn(process.execPath,['server/dist/index.js'],{cwd:process.cwd(),env:{...common,ADMIN_PASSWORD:'agentdeck-test-password',COOKIE_SECRET:'agentdeck-test-cookie-secret-1234567890',COOKIE_SECURE:'false',HOST:'127.0.0.1',PORT:String(webPort),ALLOWED_ORIGINS:`http://127.0.0.1:${webPort}`,ALLOWED_WORKSPACES:process.cwd(),USE_AGENT_RUNTIME:'1'},stdio:['ignore','pipe','pipe']}),output=[];for(const child of[runtime,web]){child.stdout.on('data',x=>output.push(String(x)));child.stderr.on('data',x=>output.push(String(x)));}
  try{
    await waitJson(`http://127.0.0.1:${runtimePort}/healthz`,runtime,output);await waitJson(`http://127.0.0.1:${webPort}/api/status`,web,output);
    const status=await getJson(`http://127.0.0.1:${webPort}/api/status`);assert.equal(status.authed,false);assert.equal(status.authenticated,false);assert.equal(typeof status.serverTime,'number');assert.deepEqual(status.capabilities,{});assert.equal(Object.hasOwn(status,'roots'),false);assert.equal(Object.hasOwn(status,'codexHome'),false);assert.equal(Object.hasOwn(status,'providers'),false);
    assert.equal((await getJson(`http://127.0.0.1:${runtimePort}/healthz`)).ok,true);
  }finally{for(const child of[web,runtime])if(child.exitCode===null)child.kill('SIGTERM');await Promise.all([web,runtime].map(child=>new Promise(resolve=>child.exitCode===null?child.once('exit',resolve):resolve())));await rm(root,{recursive:true,force:true});}
});

async function getJson(url){const response=await fetch(url);assert.equal(response.ok,true,`${url} returned ${response.status}`);return response.json();}
async function waitJson(url,child,output){const end=Date.now()+15000;while(Date.now()<end){if(child.exitCode!==null)throw new Error(`service exited early\n${output.join('')}`);try{return await getJson(url);}catch{}await new Promise(resolve=>setTimeout(resolve,50));}throw new Error(`service did not start\n${output.join('')}`);}
function freePort(){return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();server.close(()=>resolve(address.port));});});}
