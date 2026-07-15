import assert from'node:assert/strict';
import{spawn}from'node:child_process';
import{createServer}from'node:http';
import{mkdir,mkdtemp,rm}from'node:fs/promises';
import net from'node:net';
import os from'node:os';
import path from'node:path';
import test from'node:test';
import Database from'better-sqlite3';
import{WebSocketServer}from'ws';

test('Codex lineage survives a Runtime restart until the real turn terminal is durable',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'agentdeck-codex-lineage-')),data=path.join(root,'data'),cwd=path.join(root,'workspace'),runtimePort=await freePort(),appServerPort=await freePort(),dbFile=path.join(data,'runtime.sqlite3'),threadId='codex-lineage-session',realTurns=['provider-turn-A','provider-turn-B'],output=[];await mkdir(cwd,{recursive:true});
  const fake=await fakeCodexAppServer(appServerPort,threadId,cwd,realTurns);const env={...process.env,NODE_ENV:'test',DATA_DIR:data,RUNTIME_DATA_DIR:data,RUNTIME_DB:dbFile,RUNTIME_HOST:'127.0.0.1',RUNTIME_PORT:String(runtimePort),CODEX_APP_SERVER_DEFAULT_PORT:String(appServerPort),CODEX_HOME:path.join(root,'codex-home'),HOME:path.join(root,'home'),SKIP_RUNTIME_BOOTSTRAP:'1'};let runtime=startRuntime(env,output);
  try{
    await waitHttp(runtimePort,'/healthz',runtime,output);
    assert.equal((await post(runtimePort,'/codex/sessions/resume',{threadId,accountId:'default',codexHome:env.CODEX_HOME,cwd,title:'lineage'})).status,200);
    const common={input:[{type:'text',text:'identical text'}],text:'identical text',accountId:'default',codexHome:env.CODEX_HOME,cwd,approvalPolicy:'never',sandboxMode:'workspace-write'};
    assert.equal((await post(runtimePort,`/sessions/${threadId}/turns`,{...common,messageId:'message-A',clientMessageId:'A',segmentId:'segment-A',retryOf:'',localTurnId:'local-A',turnId:'local-A'})).status,200);
    await waitLineage(dbFile,threadId,'provider-turn-A','segment-A');
    fake.notify('turn/completed',{threadId,turn:{id:'provider-turn-A',status:'completed'}});await waitNoLineage(dbFile,threadId,'provider-turn-A');
    assert.equal((await post(runtimePort,`/sessions/${threadId}/turns`,{...common,messageId:'message-B',clientMessageId:'B',segmentId:'segment-B',retryOf:'A',localTurnId:'local-B',turnId:'local-B'})).status,200);
    const persisted=await waitLineage(dbFile,threadId,'provider-turn-B','segment-B');assert.deepEqual(persisted,{session_id:threadId,turn_id:'provider-turn-B',segment_id:'segment-B',client_message_id:'B',message_id:'message-B',retry_of:'A'});
    runtime.kill('SIGKILL');await new Promise(resolve=>runtime.once('exit',resolve));runtime=startRuntime({...env,SKIP_RUNTIME_BOOTSTRAP:'1'},output);await waitHttp(runtimePort,'/healthz',runtime,output);assert.equal((await post(runtimePort,'/codex/accounts/default',{})).status,200);await fake.waitForConnections(2);
    fake.notify('item/agentMessage/delta',{threadId,turnId:'provider-turn-B',itemId:'assistant-B',delta:'delta B'});
    fake.notify('item/started',{threadId,turnId:'provider-turn-B',item:{id:'command-B',type:'commandExecution',status:'inProgress',command:'echo B'}});
    fake.notify('item/completed',{threadId,turnId:'provider-turn-B',item:{id:'command-B',type:'commandExecution',status:'interrupted',command:'echo B'}});
    fake.notify('item/completed',{threadId,turnId:'provider-turn-B',item:{id:'assistant-B',type:'agentMessage',phase:'final_answer',text:'final B'}});
    fake.notify('turn/completed',{threadId,turn:{id:'provider-turn-B',status:'completed'}});
    await waitNoLineage(dbFile,threadId,'provider-turn-B');
    const replay=await waitEvents(runtimePort,threadId,events=>events.filter(event=>event.event_type==='turn/completed'&&payload(event)?.turnId==='provider-turn-B').length===1&&events.some(event=>event.event_type==='item/agentMessage/delta'&&payload(event)?.turnId==='provider-turn-B'));
    const bEvents=replay.filter(event=>['item/agentMessage/delta','item/started','item/completed','turn/completed'].includes(event.event_type)&&payload(event)?.turnId==='provider-turn-B');assert.equal(bEvents.length,5);for(const event of bEvents){const value=payload(event);assert.equal(value.turnId,'provider-turn-B');assert.equal(value.segmentId,'segment-B');assert.equal(value.clientMessageId,'B');assert.equal(value.messageId,'message-B');assert.equal(value.retryOf,'A');}
    assert.equal(replay.filter(event=>event.event_type==='turn/completed'&&payload(event)?.turnId==='provider-turn-B').length,1);assert.equal(replay.filter(event=>event.event_type==='item/agentMessage/delta'&&payload(event)?.turnId==='provider-turn-B').length,1);assert.equal(replay.filter(event=>event.event_type==='item/completed'&&payload(event)?.params?.item?.id==='assistant-B').length,1);
    const users=replay.filter(event=>event.event_type==='user').map(payload);assert.deepEqual(users.map(user=>[user.clientMessageId,user.segmentId,user.input?.[0]?.text]),[['A','segment-A','identical text'],['B','segment-B','identical text']]);assert.equal(bEvents.every(event=>payload(event).segmentId!=='segment-A'),true);
    const snapshot=await get(runtimePort,`/sessions/${threadId}`);assert.equal(snapshot.status,200);const replayAgain=(await get(runtimePort,`/sessions/${threadId}/events?after=0&includeDeltas=1`)).body.events;assert.deepEqual(replayAgain.map(event=>[event.sequence,event.event_type,payload(event)?.turnId||'']),replay.map(event=>[event.sequence,event.event_type,payload(event)?.turnId||'']));
  }finally{if(runtime.exitCode===null)runtime.kill('SIGTERM');await new Promise(resolve=>runtime.exitCode===null?runtime.once('exit',resolve):resolve());await fake.close();await rm(root,{recursive:true,force:true});}
});

function startRuntime(env,output){const child=spawn(process.execPath,['server/dist/agentdeck-runtime.js'],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>output.push(String(chunk)));child.stderr.on('data',chunk=>output.push(String(chunk)));return child;}
async function fakeCodexAppServer(port,threadId,cwd,turnIds){const sockets=[],server=createServer((req,res)=>{res.statusCode=req.url==='/readyz'?200:404;res.end();}),wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req)));wss.on('connection',ws=>{sockets.push(ws);ws.on('message',raw=>{const msg=JSON.parse(String(raw));if(msg.id===undefined)return;let result={};if(msg.method==='initialize')result={capabilities:{}};else if(msg.method==='thread/resume'||msg.method==='thread/read')result={thread:{id:threadId,cwd,status:{type:'active'},turns:[]}};else if(msg.method==='thread/list')result={data:[]};else if(msg.method==='turn/start')result={turn:{id:turnIds.shift(),status:'inProgress'}};else if(msg.method==='account/read')result={account:{type:'chatgpt'}};ws.send(JSON.stringify({id:msg.id,result}));});});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});return{notify(method,params){const ws=[...sockets].reverse().find(item=>item.readyState===1);if(!ws)throw new Error('fake app-server is not connected');ws.send(JSON.stringify({method,params}));},async waitForConnections(count){await wait(()=>sockets.length>=count&&sockets.at(-1)?.readyState===1);},async close(){for(const ws of sockets)ws.terminate();await new Promise(resolve=>server.close(resolve));wss.close();}};}
async function waitLineage(file,sessionId,turnId,segmentId){let found;await wait(()=>{try{const db=new Database(file,{readonly:true});found=db.prepare('SELECT session_id,turn_id,segment_id,client_message_id,message_id,retry_of FROM runtime_turn_lineage WHERE session_id=? AND turn_id=?').get(sessionId,turnId);db.close();return found?.segment_id===segmentId;}catch{return false;}});return found;}
async function waitNoLineage(file,sessionId,turnId){await wait(()=>{try{const db=new Database(file,{readonly:true}),count=db.prepare('SELECT COUNT(*) FROM runtime_turn_lineage WHERE session_id=? AND turn_id=?').pluck().get(sessionId,turnId);db.close();return count===0;}catch{return false;}});}
async function waitEvents(port,sessionId,predicate){let events=[];await wait(async()=>{const response=await get(port,`/sessions/${sessionId}/events?after=0&includeDeltas=1`);events=response.body.events||[];return predicate(events);});return events;}
function payload(event){try{return JSON.parse(event.payload_json||'{}')}catch{return{}}}
async function wait(predicate,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('condition timeout');}
async function waitHttp(port,path,child,output){await wait(async()=>{if(child.exitCode!==null)throw new Error(output.join(''));try{return(await fetch(`http://127.0.0.1:${port}${path}`)).ok}catch{return false;}});}
async function post(port,path,body){const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};}
async function get(port,path){const response=await fetch(`http://127.0.0.1:${port}${path}`);return{status:response.status,body:await response.json()};}
function freePort(){return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});}
