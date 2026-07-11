import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Db} from '../server/dist/db.js';
import {deleteSessionRelations,SESSION_RELATION_TABLES} from '../server/dist/session-lifecycle.js';

test('session relation deletion is one transaction and leaves no related rows',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'agentdeck-session-delete-'));const db=new Db(join(dir,'db.sqlite'));
  try{await db.init();const id='session-delete-1';await db.run("INSERT INTO sessions(id,title,project_dir,status,permission_mode,approval_policy,sandbox_mode,created_at,updated_at) VALUES(?1,'x','/tmp','idle','default','on-request','workspace-write',1,1)",[id]);
    await db.run("INSERT INTO events(session_id,ts,kind,payload) VALUES(?1,1,'x','{}')",[id]);
    await db.run("INSERT INTO artifacts(id,session_id,path,name,mime,size,created_at) VALUES('a',?1,'p','n','text/plain',1,1)",[id]);
    await db.run("INSERT INTO artifact_baselines(session_id,turn_id,project_dir,manifest_json,created_at) VALUES(?1,'t','/tmp','{}',1)",[id]);
    await db.run("INSERT INTO agent_messages(id,session_id,role,text,created_at) VALUES('m',?1,'user','x',1)",[id]);
    await db.run("INSERT INTO message_receipts(session_id,client_message_id,status,created_at,updated_at) VALUES(?1,'c','persisted',1,1)",[id]);
    await db.run("INSERT INTO interactive_requests(request_id,session_id,provider_id,kind,title,body,options_json,status,created_at) VALUES('r',?1,'codex','input','t','b','[]','pending',1)",[id]);
    await db.run("INSERT INTO plan_tasks(plan_id,session_id,original_user_task,status,created_at) VALUES('p',?1,'x','planning',1)",[id]);
    deleteSessionRelations(db,id);
    for(const table of [...SESSION_RELATION_TABLES,'sessions'])assert.equal((await db.get(`SELECT COUNT(*) count FROM ${table} WHERE ${table==='sessions'?'id':'session_id'}=?1`,[id])).count,0,table);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
