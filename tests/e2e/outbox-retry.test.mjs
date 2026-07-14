import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { chromium } from '@playwright/test';

const PASSWORD='agentdeck-test-password';

test('failed message retry starts a new turn once when double clicked',async()=>{
  const port=await freePort(),runtimePort=await freePort(),root=await mkdtemp(path.join(tmpdir(),'agentdeck-retry-e2e-')),data=path.join(root,'data'),profileId='abcdef0123456789',home=path.join(data,'antigravity-profiles',profileId,'home'),counter=path.join(root,'turn-count'),argsFile=path.join(root,'args'),binary=path.join(root,'agy');
  await mkdir(path.join(home,'.gemini','antigravity-cli'),{recursive:true});
  await writeFile(path.join(home,'.gemini','antigravity-cli','antigravity-oauth-token'),'test-token');
  await writeFile(binary,`#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'agy test 1.1.2'; exit 0; fi\nif [ "$1" = "models" ]; then exit 1; fi\nprintf '%s\\n---\\n' "$*" >> '${argsFile}'\nlog=''\nwhile [ "$#" -gt 0 ]; do [ "$1" = '--log-file' ] && { shift; log="$1"; }; shift; done\ncount=0\n[ ! -f '${counter}' ] || count=$(cat '${counter}')\ncount=$((count + 1))\nprintf '%s' "$count" > '${counter}'\nif [ "$count" -eq 1 ]; then echo 'first turn fails' >&2; exit 1; fi\nid='ce69f19b-3085-4abf-b514-03b7e4d0813a'\nmkdir -p "$HOME/.gemini/antigravity-cli/conversations"\n: > "$HOME/.gemini/antigravity-cli/conversations/$id.db"\nprintf 'Created conversation %s\\nPrint mode: conversation=%s, sending message\\n' "$id" "$id" > "$log"\necho 'retry completed'\n`);
  await chmod(binary,0o755);
  const common={...process.env,DATA_DIR:data,RUNTIME_DATA_DIR:data,RUNTIME_DB:path.join(data,'agentdeck-runtime.sqlite3'),RUNTIME_PORT:String(runtimePort),AGENT_RUNTIME_URL:`http://127.0.0.1:${runtimePort}`,ANTIGRAVITY_BIN:binary,NODE_ENV:'production'},runtimeChild=spawn(process.execPath,['server/dist/agentdeck-runtime.js'],{cwd:process.cwd(),env:{...common,RUNTIME_HOST:'127.0.0.1',SKIP_RUNTIME_BOOTSTRAP:'1'},stdio:['ignore','pipe','pipe']});
  const child=spawn(process.execPath,['server/dist/index.js'],{cwd:process.cwd(),env:{...common,ADMIN_PASSWORD:PASSWORD,COOKIE_SECRET:'agentdeck-test-cookie-secret-1234567890',COOKIE_SECURE:'false',HOST:'127.0.0.1',PORT:String(port),ALLOWED_ORIGINS:`http://127.0.0.1:${port}`,ALLOWED_WORKSPACES:process.cwd(),USE_AGENT_RUNTIME:'1'},stdio:['ignore','pipe','pipe']});
  const output=[];for(const proc of [runtimeChild,child]){proc.stdout.on('data',chunk=>output.push(String(chunk)));proc.stderr.on('data',chunk=>output.push(String(chunk)));}let browser;
  try{
    await waitForHttp(runtimePort,'/healthz',runtimeChild,output);
    await waitForServer(port,child,output);
    const db=new Database(path.join(data,'agentdeck.sqlite3')),now=Date.now(),sessionId='retry-session';
    db.prepare("INSERT INTO antigravity_profiles(id,name,home_dir,active,status,created_at,updated_at) VALUES(?,'Retry profile',?,1,'authenticated',?,?)").run(profileId,home,now,now);
    db.prepare("INSERT INTO sessions(id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,model,archived,created_at,updated_at,provider_id,account_id,model_id,workspace_path,provider_session_id) VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)").run(sessionId,sessionId,process.cwd(),'Retry session','idle','workspace-write','on-request','workspace-write',null,now,now,'antigravity',profileId,null,process.cwd(),sessionId);
    db.prepare("INSERT INTO agent_messages(id,session_id,role,text,created_at) VALUES(?,?,?,?,?)").run('legacy-user',sessionId,'user','legacy question',now-20);
    db.prepare("INSERT INTO agent_messages(id,session_id,role,text,created_at) VALUES(?,?,?,?,?)").run('legacy-assistant',sessionId,'assistant','legacy answer',now-10);
    db.close();
    browser=await chromium.launch({headless:true});const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}`);await page.getByLabel('管理员密码').fill(PASSWORD);await page.getByRole('button',{name:'登录并进入工作区'}).click();
    await page.goto(`http://127.0.0.1:${port}/#/s/${sessionId}`);await page.getByText(/Browser 已连接/).waitFor({timeout:10000});await page.locator('textarea').fill('run retry test');await page.getByRole('button',{name:'发送',exact:true}).click();
    await waitForFailedReceipt(path.join(data,'agentdeck.sqlite3'),sessionId);
    const retry=page.getByRole('button',{name:'重试',exact:true});await retry.waitFor({timeout:10000}).catch(async error=>{throw new Error(`${error.message}\npage=${await page.locator('body').innerText()}\nserver=${output.join('')}`);});
    await retry.evaluate(button=>{button.click();button.click();});
    await waitForAcceptedRetry(path.join(data,'agentdeck.sqlite3'),sessionId);
    await waitForCounter(counter,'2');
    assert.equal(await readFile(counter,'utf8'),'2','first attempt plus exactly one retry must execute');
    await new Promise(resolve=>setTimeout(resolve,300));await page.locator('textarea').fill('strict resume');await page.getByRole('button',{name:'发送',exact:true}).click();await waitForCounter(counter,'3');
    const verify=new Database(path.join(data,'agentdeck.sqlite3'),{readonly:true});const receipts=verify.prepare('SELECT client_message_id,status,retry_of FROM message_receipts WHERE session_id=? ORDER BY created_at').all(sessionId);verify.close();
    assert.equal(receipts.length,3);assert.equal(receipts[0].status,'failed');assert.equal(receipts[1].retry_of,receipts[0].client_message_id);assert.notEqual(receipts[1].client_message_id,receipts[0].client_message_id);assert.ok(['accepted','persisted'].includes(receipts[1].status));
    const runtimeDb=new Database(path.join(data,'agentdeck-runtime.sqlite3'),{readonly:true}),runtimeSession=runtimeDb.prepare('SELECT provider_session_id FROM sessions WHERE id=?').get(sessionId),runtimeEvents=runtimeDb.prepare('SELECT event_type,payload_json FROM events WHERE session_id=? ORDER BY sequence').all(sessionId);runtimeDb.close();assert.equal(runtimeSession.provider_session_id,'ce69f19b-3085-4abf-b514-03b7e4d0813a');assert.ok(runtimeEvents.some(event=>event.event_type==='antigravity/history_imported'));const args=await readFile(argsFile,'utf8');assert.match(args,/legacy question/);assert.match(args,/legacy answer/);assert.match(args,/--conversation ce69f19b-3085-4abf-b514-03b7e4d0813a/);
  }finally{if(browser)await browser.close();for(const proc of [child,runtimeChild])if(proc.exitCode===null)proc.kill('SIGTERM');await Promise.all([child,runtimeChild].map(proc=>new Promise(resolve=>proc.exitCode===null?proc.once('exit',resolve):resolve())));await rm(root,{recursive:true,force:true});}
});

function freePort(){return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();server.close(()=>resolve(address.port));});});}
async function waitForServer(port,child,output){const end=Date.now()+15000;while(Date.now()<end){if(child.exitCode!==null)throw new Error(`server exited early\n${output.join('')}`);try{if((await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`server did not start\n${output.join('')}`);}
async function waitForHttp(port,url,child,output){const end=Date.now()+15000;while(Date.now()<end){if(child.exitCode!==null)throw new Error(`process exited early\n${output.join('')}`);try{if((await fetch(`http://127.0.0.1:${port}${url}`)).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}throw new Error(`service did not start\n${output.join('')}`);}
async function waitForFailedReceipt(file,sessionId){const end=Date.now()+15000;while(Date.now()<end){const db=new Database(file,{readonly:true}),row=db.prepare('SELECT status FROM message_receipts WHERE session_id=? ORDER BY created_at DESC LIMIT 1').get(sessionId);db.close();if(row?.status==='failed')return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('first receipt did not fail');}
async function waitForAcceptedRetry(file,sessionId){const end=Date.now()+15000;while(Date.now()<end){const db=new Database(file,{readonly:true}),row=db.prepare("SELECT status,retry_of FROM message_receipts WHERE session_id=? AND retry_of IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(sessionId);db.close();if(row&&['accepted','persisted'].includes(row.status))return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('retry receipt was not accepted');}
async function waitForCounter(file,value){const end=Date.now()+15000;while(Date.now()<end){if(await readFile(file,'utf8').catch(()=>'')===value)return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error(`counter did not reach ${value}`);}
