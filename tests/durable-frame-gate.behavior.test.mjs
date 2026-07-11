import assert from 'node:assert/strict';
import test from 'node:test';
import {DurableFrameGate} from '../client/src/durable-frame-gate.ts';

test('out of order approval is held until contiguous and duplicate side effects emit once',()=>{
  const gate=new DurableFrameGate(0,{clientConnectionId:'browser-2'});const approval={type:'approval',runtimeSequence:2,frameIndex:0,frameCount:1,requestId:'a'};
  assert.deepEqual(gate.push(approval).ready,[]);const ready=gate.push({type:'runtimeConnection',runtimeSequence:1,frameIndex:0,frameCount:1,status:'connected'}).ready;
  assert.deepEqual(ready.map(x=>x.runtimeSequence),[1,2]);assert.deepEqual(gate.push(approval).ready,[]);
});

test('cursor ranges advance without timeline payload and overlap idempotently',()=>{
  const gate=new DurableFrameGate(4,{clientConnectionId:'browser'});for(let sequence=5;sequence<=9;sequence++)assert.equal(gate.push({type:'runtime_cursor',runtimeSequence:sequence,frameIndex:0,frameCount:1,fromSequence:sequence,throughSequence:sequence}).ready.length,1);assert.equal(gate.appliedThrough(),9);
});

test('old recovery epoch frames are ignored',()=>{
  const gate=new DurableFrameGate(10,{clientConnectionId:'client-new',joinRequestId:'new',recoveryEpoch:4});assert.equal(gate.push({type:'approval',runtimeSequence:11,frameIndex:0,frameCount:1,clientConnectionId:'client-old',joinRequestId:'old',recoveryEpoch:3}).ignored,true);assert.equal(gate.appliedThrough(),10);
});
test('client connection identity is independent from server websocket generation',()=>{const gate=new DurableFrameGate(0,{clientConnectionId:'client-uuid-2',joinRequestId:'j',recoveryEpoch:0});const result=gate.push({type:'system',runtimeSequence:1,frameIndex:0,frameCount:1,clientConnectionId:'client-uuid-2',connectionGeneration:99,joinRequestId:'j',recoveryEpoch:0});assert.equal(result.ready.length,1);assert.equal(gate.appliedThrough(),1);});
test('pending limits trigger controlled resnapshot and clear memory',()=>{const gate=new DurableFrameGate(0,{clientConnectionId:'c'},{sequences:2,frames:2,bytes:10000});gate.push({type:'approval',runtimeSequence:10,frameIndex:0,frameCount:1});gate.push({type:'approval',runtimeSequence:11,frameIndex:0,frameCount:1});const result=gate.push({type:'approval',runtimeSequence:12,frameIndex:0,frameCount:1});assert.equal(result.resnapshotNeeded,true);assert.equal(gate.stats().pendingSequences,0);});
