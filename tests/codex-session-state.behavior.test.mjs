import assert from'node:assert/strict';
import test from'node:test';
import{codexSessionStateForNotification}from'../server/dist/codex-session-state.js';

test('thread status cannot clear a turn established by turn/started',()=>{
  let state={active_turn_id:null,status:'idle',interruption_reason:null};
  state=codexSessionStateForNotification(state,'turn/started',{turn:{id:'turn-1'}});
  state=codexSessionStateForNotification(state,'thread/status/changed',{status:'idle'});
  assert.equal(state.active_turn_id,'turn-1');
  assert.equal(state.status,'running');
});

test('only a terminal turn notification clears the active turn',()=>{
  const active={active_turn_id:'turn-1',status:'running',interruption_reason:null};
  assert.equal(codexSessionStateForNotification(active,'item/completed',{item:{type:'final_answer'}}).active_turn_id,'turn-1');
  assert.equal(codexSessionStateForNotification(active,'thread/status/changed',{status:'idle'}).active_turn_id,'turn-1');
  assert.equal(codexSessionStateForNotification(active,'turn/completed',{turn:{status:'completed'}}).active_turn_id,null);
  assert.equal(codexSessionStateForNotification(active,'turn/failed',{turn:{status:'failed'}}).active_turn_id,null);
  assert.equal(codexSessionStateForNotification(active,'turn/interrupted',{}).active_turn_id,null);
});
