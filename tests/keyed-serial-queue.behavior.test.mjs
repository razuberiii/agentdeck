import assert from'node:assert/strict';
import test from'node:test';
import{KeyedSerialQueue}from'../server/dist/keyed-serial-queue.js';
import{codexSessionStateForNotification}from'../server/dist/codex-session-state.js';

test('concurrent Codex notifications for one thread apply in arrival order',async()=>{
  const queue=new KeyedSerialQueue();
  let state={active_turn_id:null,status:'idle',interruption_reason:null};
  let releaseStarted;const paused=new Promise(resolve=>{releaseStarted=resolve;});
  const started=queue.run('thread-1',async()=>{await paused;state=codexSessionStateForNotification(state,'turn/started',{turn:{id:'turn-1'}});});
  const status=queue.run('thread-1',async()=>{state=codexSessionStateForNotification(state,'thread/status/changed',{status:'idle'});});
  releaseStarted();await Promise.all([started,status]);
  assert.equal(state.active_turn_id,'turn-1');
  assert.equal(state.status,'running');
});
