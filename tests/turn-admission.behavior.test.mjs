import assert from'node:assert/strict';
import test from'node:test';
import{TurnAdmission}from'../server/dist/turn-admission.js';
import{runtimeIsDrained}from'../server/dist/runtime-drain-state.js';

const drainWork=admission=>({turnAdmissionInFlight:admission.inFlight,activeTurnCount:0,submittingTurnCount:0,claudeActiveTurnCount:0,geminiActivePromptCount:0,appendQueueCount:0,deltaQueueEventCount:0,pendingSqliteWriteCount:0,pendingPushCount:0,subscriberPendingBufferCount:0});

test('an admitted turn paused before its first async operation blocks drain',async()=>{
  const admission=new TurnAdmission();
  assert.equal(admission.tryBegin(true),true);
  let resume;
  const firstAsyncOperation=new Promise(resolve=>{resume=resolve;});
  const request=(async()=>{try{await firstAsyncOperation;}finally{admission.end();}})();
  assert.equal(runtimeIsDrained(drainWork(admission)),false);
  resume();await request;
  assert.equal(runtimeIsDrained(drainWork(admission)),true);
});

test('a new turn is rejected after drain starts and exceptional admissions release',async()=>{
  const admission=new TurnAdmission();
  assert.equal(admission.tryBegin(false),false);
  assert.equal(admission.inFlight,0);
  assert.equal(admission.tryBegin(true),true);
  try{throw new Error('first async operation failed');}catch{}finally{admission.end();}
  assert.equal(admission.inFlight,0);
});
