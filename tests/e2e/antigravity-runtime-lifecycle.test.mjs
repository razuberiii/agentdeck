import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('Antigravity Runtime releases failed claims and waits through SIGKILL cancellation',async()=>{
  const port=await freePort(),root=await mkdtemp(path.join(os.tmpdir(),'agentdeck-agy-runtime-')),data=path.join(root,'data'),profileId='abcdef0123456789',home=path.join(data,'antigravity-profiles',profileId,'home'),binary=path.join(root,'agy'),pidFile=path.join(root,'agy.pid'),argsFile=path.join(root,'args');
  await mkdir(home,{recursive:true});
  const env={...process.env,DATA_DIR:data,RUNTIME_DATA_DIR:data,RUNTIME_DB:path.join(data,'runtime.sqlite3'),RUNTIME_HOST:'127.0.0.1',RUNTIME_PORT:String(port),SKIP_RUNTIME_BOOTSTRAP:'1',ANTIGRAVITY_BIN:binary,ANTIGRAVITY_STOP_GRACE_MS:'120',HOME:path.join(root,'empty-home'),PATH:'/usr/bin:/bin'};
  const child=spawn(process.execPath,['server/dist/agentdeck-runtime.js'],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']}),output=[];child.stdout.on('data',x=>output.push(String(x)));child.stderr.on('data',x=>output.push(String(x)));
  try{
    await waitHttp(port,'/healthz',child,output);
    await writeFile(path.join(data,'runtime'),'blocks log directory');
    await ensureSession(port,'log-failure',profileId,home);
    assert.equal((await post(port,'/sessions/log-failure/turns',turnBody(profileId,home,'log failure'))).status,200);
    await waitTerminal(port,'log-failure','turn/failed');await assertReleased(port,'log-failure');
    await unlink(path.join(data,'runtime'));

    await ensureSession(port,'binary-failure',profileId,home);
    assert.equal((await post(port,'/sessions/binary-failure/turns',turnBody(profileId,home,'missing binary'))).status,200);
    await waitTerminal(port,'binary-failure','turn/failed');await assertReleased(port,'binary-failure');
    const retry=await post(port,'/sessions/binary-failure/turns',{...turnBody(profileId,home,'missing binary retry'),turnId:'retry-turn',clientMessageId:'retry-message'});assert.equal(retry.status,200,'a pre-spawn failure must not permanently retain the claim');
    await waitTerminalCount(port,'binary-failure','turn/failed',2);await assertReleased(port,'binary-failure');

    await writeFile(binary,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${argsFile}'\nlog=''\nprompt=''\nwhile [ "$#" -gt 0 ]; do [ "$1" = '--log-file' ] && { shift; log="$1"; }; prompt="$1"; shift; done\nif [ "$prompt" = 'STOP' ]; then printf '%s' "$$" > '${pidFile}'; trap '' TERM; while :; do sleep 1; done; fi\nid='ce69f19b-3085-4abf-b514-03b7e4d0813a'\nmkdir -p "$HOME/.gemini/antigravity-cli/conversations"\n: > "$HOME/.gemini/antigravity-cli/conversations/$id.db"\necho "Print mode: conversation=$id, sending message" > "$log"\nsleep 0.1\necho completed\n`);await chmod(binary,0o755);
    const attachmentDir=path.join(data,'attachments','attachment-session'),attachmentPath=path.join(attachmentDir,'note.txt');await mkdir(attachmentDir,{recursive:true});await writeFile(attachmentPath,'verified attachment contents');
    await ensureSession(port,'attachment-session',profileId,home);const attachmentTurn={...turnBody(profileId,home,`read ${attachmentPath}`),attachments:[{id:'known',name:'note.txt',path:attachmentPath}]};assert.equal((await post(port,'/sessions/attachment-session/turns',attachmentTurn)).status,200);await waitTerminal(port,'attachment-session','turn/completed');assert.match(await readFile(argsFile,'utf8'),new RegExp(`--add-dir ${escapeRegex(attachmentDir)}`));assert.equal(await readFile(attachmentPath,'utf8'),'verified attachment contents');
    const otherDir=path.join(data,'attachments','other-session');await mkdir(otherDir,{recursive:true});const otherPath=path.join(otherDir,'secret.txt');await writeFile(otherPath,'must not be read');await ensureSession(port,'forged-attachment',profileId,home);assert.equal((await post(port,'/sessions/forged-attachment/turns',{...turnBody(profileId,home,'forged'),attachments:[{id:'forged',path:otherPath}]})).status,200);await waitTerminal(port,'forged-attachment','turn/failed');await assertReleased(port,'forged-attachment');
    await ensureSession(port,'stop-session',profileId,home);
    assert.equal((await post(port,'/sessions/stop-session/turns',turnBody(profileId,home,'STOP'))).status,200);
    const pid=Number(await waitFile(pidFile));const started=Date.now(),stopped=await post(port,'/sessions/stop-session/stop',{});assert.equal(stopped.status,200);assert.equal(stopped.body.processExited,true);assert.ok(Date.now()-started>=100,'SIGTERM grace period should elapse before SIGKILL');
    assert.throws(()=>process.kill(pid,0),error=>error?.code==='ESRCH');
    const events=(await get(port,'/sessions/stop-session/events?after=0&includeDeltas=1')).body.events;assert.equal(events.filter(event=>event.event_type==='turn/interrupted').length,1);assert.equal(events.some(event=>['turn/completed','turn/failed'].includes(event.event_type)),false);await assertReleased(port,'stop-session');
  }finally{if(child.exitCode===null)child.kill('SIGTERM');await new Promise(resolve=>child.exitCode===null?child.once('exit',resolve):resolve());await rm(root,{recursive:true,force:true});}
});

function turnBody(id,home,text){return{profile:{id,homeDir:home},accountId:id,text,input:[{type:'text',text}],turnId:`turn-${text.replaceAll(' ','-')}`,clientMessageId:`message-${text.replaceAll(' ','-')}`,permissionMode:'workspace-write'};}
async function ensureSession(port,sessionId,id,home){const response=await post(port,'/antigravity/sessions',{sessionId,profile:{id,homeDir:home},accountId:id,cwd:process.cwd(),title:sessionId,mode:'workspace-write'});assert.equal(response.status,200);}
async function assertReleased(port,id){const session=(await get(port,`/sessions/${id}`)).body.session;assert.equal(session.active_turn_id,null);assert.ok(['failed','interrupted'].includes(session.status));}
async function waitTerminal(port,id,type){return waitTerminalCount(port,id,type,1);}
async function waitTerminalCount(port,id,type,count){const end=Date.now()+10000;let events=[];while(Date.now()<end){events=(await get(port,`/sessions/${id}/events?after=0&includeDeltas=1`)).body.events;if(events.filter(event=>event.event_type===type).length>=count)return events;await delay(30);}throw new Error(`${type} was not persisted: ${JSON.stringify(events)}`);}
async function waitFile(file){const end=Date.now()+10000;while(Date.now()<end){const value=await readFile(file,'utf8').catch(()=>'');if(value)return value;await delay(20);}throw new Error('child pid was not written');}
async function get(port,url){const response=await fetch(`http://127.0.0.1:${port}${url}`);return{status:response.status,body:await response.json()};}
async function post(port,url,body){const response=await fetch(`http://127.0.0.1:${port}${url}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};}
async function waitHttp(port,url,child,output){const end=Date.now()+10000;while(Date.now()<end){if(child.exitCode!==null)throw new Error(`runtime exited\n${output.join('')}`);try{if((await fetch(`http://127.0.0.1:${port}${url}`)).ok)return;}catch{}await delay(30);}throw new Error(`runtime unavailable\n${output.join('')}`);}
function freePort(){return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();server.close(()=>resolve(address.port));});});}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const escapeRegex=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
