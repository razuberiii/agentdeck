import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import net from 'node:net';import os from 'node:os';import path from 'node:path';
import test from 'node:test';import Database from 'better-sqlite3';import WebSocket from 'ws';
const root=path.resolve(new URL('../..',import.meta.url).pathname);

test('isolated Runtime restart preserves multi-frame delivery and model revision',{timeout:45_000},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'agentdeck-restart-e2e-')),runtimePort=await port(),webPort=await port();
  const logs={runtime:[],web:[]};let runtime,web,ws;
  const env={...process.env,DATA_DIR:dir,RUNTIME_DATA_DIR:dir,RUNTIME_DB:path.join(dir,'runtime.sqlite3'),RUNTIME_TOKEN:'test-runtime-token',AGENT_RUNTIME_TOKEN:'test-runtime-token',AGENT_RUNTIME_URL:`http://127.0.0.1:${runtimePort}`,COOKIE_SECRET:'test-cookie-secret-that-is-long-enough',COOKIE_SECURE:'false',ADMIN_PASSWORD:'test-admin-password',USE_AGENT_RUNTIME:'1',HOST:'127.0.0.1',PORT:String(webPort),RUNTIME_HOST:'127.0.0.1',RUNTIME_PORT:String(runtimePort),ALLOWED_ORIGINS:`http://127.0.0.1:${webPort}`,DEFAULT_WORKDIR:root};
  const start=(kind,file)=>{const child=spawn(process.execPath,[file],{cwd:root,env,stdio:['ignore','pipe','pipe']});for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>logs[kind].push(String(chunk)));return child;};
  try{
    runtime=start('runtime','server/dist/agentdeck-runtime.js');web=start('web','server/dist/index.js');
    await waitJson(`http://127.0.0.1:${runtimePort}/healthz`);await waitJson(`http://127.0.0.1:${webPort}/api/status`);
    seed(path.join(dir,'runtime.sqlite3'));seed(path.join(dir,'agentdeck.sqlite3'));
    const origin=`http://127.0.0.1:${webPort}`;
    const login=await fetch(`${origin}/api/login`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'test-admin-password'})});
    if(!login.ok)throw new Error(`login ${login.status}: ${await login.text()}`);
    const cookies=login.headers.getSetCookie().map(value=>value.split(';')[0]),cookie=cookies.join('; '),csrf=cookies.find(value=>value.startsWith('agentdeck_csrf='))?.split('=')[1]||'';
    const patched=await fetch(`${origin}/api/sessions/s`,{method:'PATCH',headers:{cookie,origin,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify({model:'gpt-5.1'})});
    if(!patched.ok)throw new Error(`patch ${patched.status}: ${await patched.text()}`);const applied=await patched.json();assert.ok(applied.modelRevision>=1);
    const snapshot=await fetch(`${origin}/api/sessions/s`,{headers:{cookie}}).then(r=>r.json());assert.equal(snapshot.session.modelRevision,applied.modelRevision);
    const dashboard=await fetch(`${origin}/api/dashboard`,{headers:{cookie}}).then(r=>r.json());assert.equal(dashboard.sessions.find(session=>session.id==='s').modelRevision,applied.modelRevision);
    ws=new WebSocket(`ws://127.0.0.1:${webPort}/ws`,{headers:{cookie,origin}});await onceOpen(ws);const frames=[];ws.on('message',data=>frames.push(JSON.parse(String(data))));
    ws.send(JSON.stringify({type:'join',sessionId:'s',lastSequence:0,clientAppliedSequence:0,snapshotCoveredSequence:0,clientConnectionId:'isolated-client-uuid',joinRequestId:'join-1',recoveryEpoch:0,runtimeGeneration:''}));await wait(()=>frames.some(frame=>frame.type==='joined'));
    runtime.kill('SIGTERM');await onceExit(runtime);const failedPatch=await fetch(`${origin}/api/sessions/s`,{method:'PATCH',headers:{cookie,origin,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify({model:'must-not-stick'})});assert.equal(failedPatch.ok,false);assert.equal(readModel(path.join(dir,'agentdeck.sqlite3')),'gpt-5.1');insertEvent(path.join(dir,'runtime.sqlite3'),1,'thread_recovered_with_new_upstream',{warning:'restart marker'});runtime=start('runtime','server/dist/agentdeck-runtime.js');await waitJson(`http://127.0.0.1:${runtimePort}/healthz`);
    await wait(()=>frames.filter(frame=>frame.runtimeSequence===1).length===2&&frames.some(frame=>frame.type==='runtimeConnection'&&frame.status==='connected'),15_000);
    const durable=frames.filter(frame=>frame.runtimeSequence===1);assert.deepEqual(durable.map(frame=>frame.frameIndex),[0,1]);assert.ok(durable.every(frame=>frame.frameCount===2));assert.equal(new Set(durable.map(frame=>`${frame.runtimeSequence}:${frame.frameIndex}`)).size,2);
    const after=await fetch(`${origin}/api/sessions/s`,{headers:{cookie}}).then(r=>r.json());assert.equal(after.session.model,'gpt-5.1');assert.equal(after.session.modelRevision,applied.modelRevision);
  }catch(error){throw new Error(`${error?.stack||error}\nRuntime tail:\n${logs.runtime.join('').slice(-8000)}\nWeb tail:\n${logs.web.join('').slice(-8000)}`);}
  finally{try{ws?.close();}catch{}for(const child of[runtime,web])if(child&&!child.killed)child.kill('SIGTERM');await Promise.all([runtime,web].filter(Boolean).map(child=>onceExit(child).catch(()=>{})));await rm(dir,{recursive:true,force:true});}
});
function seed(file){const db=new Database(file);for(const sql of['ALTER TABLE sessions ADD COLUMN model_id TEXT','ALTER TABLE sessions ADD COLUMN model_revision INTEGER NOT NULL DEFAULT 0','ALTER TABLE sessions ADD COLUMN provider_id TEXT','ALTER TABLE sessions ADD COLUMN last_sequence INTEGER NOT NULL DEFAULT 0'])try{db.exec(sql);}catch{}db.prepare("INSERT OR REPLACE INTO sessions(id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,model,model_id,model_revision,archived,created_at,updated_at,provider_id,last_sequence)VALUES('s','s',?,'Restart','idle','yolo','never','full-access','gpt-5','gpt-5',0,0,1,1,'codex',0)").run(root);db.close();}
function insertEvent(file,sequence,type,payload){const db=new Database(file),now=Date.now(),json=JSON.stringify(payload);db.prepare('INSERT INTO events(session_id,ts,kind,payload,sequence,event_type,payload_json,created_at,event_key)VALUES(?,?,?,?,?,?,?,?,NULL)').run('s',now,type,json,sequence,type,json,now);db.prepare('UPDATE sessions SET last_sequence=? WHERE id=?').run(sequence,'s');db.close();}
function readModel(file){const db=new Database(file,{readonly:true});const model=db.prepare("SELECT model FROM sessions WHERE id='s'").pluck().get();db.close();return model;}
function port(){return new Promise((resolve,reject)=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(error=>error?reject(error):resolve(value));});server.on('error',reject);});}
async function waitJson(url){let last;for(let i=0;i<100;i++){try{const response=await fetch(url,{headers:{authorization:'Bearer test-runtime-token'}});if(response.ok)return response.json();last=new Error(`${response.status}`);}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,100));}throw last;}
async function wait(predicate,timeout=10_000){const end=Date.now()+timeout;while(Date.now()<end){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('condition timeout');}
function onceOpen(ws){return new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});}
function onceExit(child){return new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',resolve);});}
