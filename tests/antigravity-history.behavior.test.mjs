import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Db} from '../server/dist/db.js';
import {loadAntigravityLegacyHistory} from '../server/dist/antigravity-history.js';

test('legacy Antigravity takeover imports the latest 80 messages in stable conversation order',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'agentdeck-agy-history-')),db=new Db(path.join(dir,'db.sqlite3'));
  await db.init();
  try{
    await db.run("INSERT INTO sessions(id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,created_at,updated_at)VALUES('legacy','legacy','/tmp','legacy','idle','workspace-write','on-request','workspace-write',1,1)");
    for(let i=0;i<100;i++){
      const id=`message-${String(i).padStart(3,'0')}`,role=i%2?'assistant':'user',marker=i===0?'old marker':i===99?'recent marker':`message ${i}`;
      await db.run('INSERT INTO agent_messages(id,session_id,role,text,original_text,created_at)VALUES(?1,?2,?3,?4,?4,?5)',[id,'legacy',role,marker,Math.floor(i/2)]);
    }
    const history=await loadAntigravityLegacyHistory(db,'legacy');
    assert.equal(history.length,80);
    assert.equal(history[0].id,'message-020');
    assert.equal(history.at(-1).id,'message-099');
    assert.equal(history.some(item=>item.text==='recent marker'),true);
    assert.equal(history.some(item=>item.text==='old marker'),false);
    assert.deepEqual(history.map(item=>item.id),[...history].map(item=>item.id).sort());
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
