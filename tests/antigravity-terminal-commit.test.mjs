import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Db} from '../server/dist/db.js';
import {DurableEventStore} from '../server/dist/event-store.js';
import {migrateRuntimeSchema} from '../server/dist/schema-migrations.js';

test('Antigravity terminal commit is atomic, keyed, and recoverable',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'agentdeck-terminal-')),db=new Db(path.join(dir,'runtime.sqlite3'));
  try{
    await db.init();await migrateRuntimeSchema(db);const now=Date.now();
    await db.run("INSERT INTO sessions(id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,archived,created_at,updated_at,provider_id,provider,active_turn_id,last_sequence) VALUES('agy','agy','/tmp','agy','running','workspace-write','on-request','workspace-write',0,?1,?1,'antigravity','antigravity','turn-1',0)",[now]);
    const store=new DurableEventStore(db,'test');
    const input={sessionId:'agy',turnId:'turn-1',status:'idle',interruptionReason:null,assistant:{eventType:'item/completed',eventKey:'antigravity:turn-1:assistant',payload:{method:'item/completed',params:{item:{id:'answer',type:'agentMessage',text:'answer'}}}},terminal:{eventType:'turn/completed',eventKey:'antigravity:turn-1:terminal',payload:{method:'turn/completed',params:{turn:{id:'turn-1',status:'completed'}}}}};
    await assert.rejects(store.commitAtomicTerminal({...input,testFailureStage:'session_update'}));
    assert.deepEqual(await state(db),{status:'running',active_turn_id:'turn-1',events:0});
    await assert.rejects(store.commitAtomicTerminal({...input,testFailureStage:'terminal_event'}));
    assert.deepEqual(await state(db),{status:'running',active_turn_id:'turn-1',events:0});
    const intentPayload=JSON.stringify(input.terminal.payload),assistantPayload=JSON.stringify(input.assistant.payload);
    await db.run("INSERT INTO antigravity_terminal_intents(session_id,turn_id,terminal,reason,client_message_id,assistant_item_json,terminal_payload_json,created_at,updated_at) VALUES('agy','turn-1','completed',NULL,'message-1',?1,?2,?3,?3)",[assistantPayload,intentPayload,now]);
    await store.commitAtomicTerminal(input);await store.commitAtomicTerminal(input);
    assert.deepEqual(await state(db),{status:'idle',active_turn_id:null,events:2});
    assert.equal((await db.get('SELECT COUNT(*) count FROM antigravity_terminal_intents'))?.count,0);
    assert.equal((await db.get("SELECT COUNT(*) count FROM events WHERE event_type='item/completed'"))?.count,1);
    assert.equal((await db.get("SELECT COUNT(*) count FROM events WHERE event_type='turn/completed'"))?.count,1);
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

async function state(db){const session=await db.get("SELECT status,active_turn_id FROM sessions WHERE id='agy'"),events=await db.get("SELECT COUNT(*) count FROM events WHERE session_id='agy'");return{status:session.status,active_turn_id:session.active_turn_id,events:Number(events.count)};}
