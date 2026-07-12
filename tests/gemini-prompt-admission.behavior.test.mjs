import assert from'node:assert/strict';
import test from'node:test';
import{GeminiAcpRuntime}from'../server/dist/acp/gemini-runtime.js';
import{runtimeIsDrained}from'../server/dist/runtime-drain-state.js';

function runtimeWith({updateSession=async()=>{},appendEvent=async()=>{},request=async()=>({ok:true})}={}){
  const runtime=new GeminiAcpRuntime({db:{},dataDir:'/tmp',defaultCwd:'/tmp',profileId:'test',profileDir:'/tmp',updateSession,appendEvent});
  runtime.sessions.set('session-1',{localSessionId:'session-1',providerSessionId:'provider-1',cwd:'/tmp',configOptions:[],model:null,activePrompt:null,promptController:null,permissionMode:'read-only'});
  runtime.agent={request};
  return runtime;
}
function drainWork(runtime){return{turnAdmissionInFlight:0,activeTurnCount:0,submittingTurnCount:0,claudeActiveTurnCount:0,geminiActivePromptCount:runtime.activePromptCount(),appendQueueCount:0,deltaQueueEventCount:0,pendingSqliteWriteCount:0,pendingPushCount:0,subscriberPendingBufferCount:0};}

test('Gemini prompt is drain-visible while its initial session update is paused',async()=>{
  let resume;const paused=new Promise(resolve=>{resume=resolve;});
  const runtime=runtimeWith({updateSession:async()=>paused});
  const prompt=runtime.prompt('session-1',[]);
  assert.equal(runtime.activePromptCount(),1);
  assert.equal(runtimeIsDrained(drainWork(runtime)),false);
  resume();await prompt;
  assert.equal(runtime.activePromptCount(),0);
});

test('Gemini admission clears after initial update or event persistence fails',async t=>{
  await t.test('updateSession failure',async()=>{
    const runtime=runtimeWith({updateSession:async()=>{throw new Error('update failed');}});
    await assert.rejects(runtime.prompt('session-1',[]),/update failed/);
    assert.equal(runtime.activePromptCount(),0);assert.equal(runtime.sessions.get('session-1').promptController,null);
  });
  await t.test('appendEvent failure',async()=>{
    const runtime=runtimeWith({appendEvent:async()=>{throw new Error('append failed');}});
    await assert.rejects(runtime.prompt('session-1',[]),/append failed/);
    assert.equal(runtime.activePromptCount(),0);assert.equal(runtime.sessions.get('session-1').promptController,null);
  });
});

test('Gemini prompt completion and agent failure both clear admission state',async t=>{
  await t.test('completion',async()=>{
    const runtime=runtimeWith();await runtime.prompt('session-1',[]);
    assert.equal(runtime.activePromptCount(),0);assert.equal(runtime.sessions.get('session-1').promptController,null);
  });
  await t.test('failure',async()=>{
    const runtime=runtimeWith({request:async()=>{throw new Error('agent failed');}});
    await assert.rejects(runtime.prompt('session-1',[]),/agent failed/);
    assert.equal(runtime.activePromptCount(),0);assert.equal(runtime.sessions.get('session-1').promptController,null);
  });
});

test('Gemini terminal persistence failures are independent and preserve the original error',async t=>{
  for(const failingEvent of ['turn/started','turn/completed','turn/failed'])await t.test(failingEvent,async()=>{
    const updates=[];const original=new Error(`${failingEvent} failed`);
    const runtime=runtimeWith({
      appendEvent:async(_id,type)=>{if(type===failingEvent)throw original;},
      updateSession:async(_id,value)=>{updates.push(value);},
      request:failingEvent==='turn/failed'?async()=>{throw new Error('provider failed');}:async()=>({ok:true}),
    });
    await assert.rejects(runtime.prompt('session-1',[]),error=>error===original || (failingEvent==='turn/failed'&&error.message==='provider failed'));
    assert.ok(updates.some(value=>value.status==='interrupted'));
    assert.equal(runtime.activePromptCount(),0);assert.equal(runtime.sessions.get('session-1').promptController,null);
  });
  await t.test('terminal session update',async()=>{
    const providerError=new Error('provider failed');
    const runtime=runtimeWith({request:async()=>{throw providerError;},updateSession:async(_id,value)=>{if(value.status==='interrupted')throw new Error('session failed');}});
    await assert.rejects(runtime.prompt('session-1',[]),error=>error===providerError);
    assert.equal(runtime.activePromptCount(),0);assert.equal(runtime.sessions.get('session-1').promptController,null);
  });
});
