import assert from 'node:assert/strict';
import test from 'node:test';
import {ClaudeRuntimeManager} from '../server/dist/claude/claude-runtime-manager.js';

const input={localSessionId:'s1',turnId:'t1',profile:{id:'p1',name:'Claude',profileDir:'/tmp/profile',configDir:'/tmp/profile/.claude',type:'api_key',active:true,status:'authenticated',createdAt:1,updatedAt:1},cwd:'/tmp',text:'hello',input:[],permissionMode:'default'};
function manager({updateSession=async()=>{},appendEvent=async()=>{},executeQuery=async function*(){}}={}){
  return new ClaudeRuntimeManager({}, {readEnv:async()=>({})}, {updateSession,appendEvent,executeQuery});
}

test('Claude initialization persistence failures always release drain admission',async t=>{
  await t.test('initial updateSession',async()=>{
    const runtime=manager({updateSession:async()=>{throw new Error('initial update failed');}});
    await assert.rejects(runtime.startTurn(input),/initial update failed/);
    assert.equal(runtime.activeTurnCount(),0);
  });
  await t.test('turn started event',async()=>{
    let events=0;
    const runtime=manager({appendEvent:async()=>{if(++events===1)throw new Error('started failed');}});
    await assert.rejects(runtime.startTurn(input),/started failed/);
    assert.equal(runtime.activeTurnCount(),0);
  });
});

test('Claude preserves provider error while terminal writes independently fail',async()=>{
  const updates=[],events=[];
  const providerError=new Error('provider failed');
  const runtime=manager({
    executeQuery:async function*(){throw providerError;},
    updateSession:async(_id,value)=>{updates.push(value);if(value.status==='interrupted')throw new Error('terminal session failed');},
    appendEvent:async(_id,type)=>{events.push(type);if(type==='turn/failed')throw new Error('terminal event failed');},
  });
  await assert.rejects(runtime.startTurn(input),error=>error===providerError);
  assert.equal(runtime.activeTurnCount(),0);
  assert.ok(updates.some(value=>value.status==='interrupted'));
  assert.ok(events.includes('turn/failed'));
});
