import assert from 'node:assert/strict';
import test from 'node:test';
import {DurableFrameGate} from '../client/src/durable-frame-gate.ts';

test('out of order approval is held until contiguous and duplicate side effects emit once',()=>{
  const gate=new DurableFrameGate(0,{connectionGeneration:1});const approval={type:'approval',runtimeSequence:2,requestId:'a'};
  assert.deepEqual(gate.push(approval).ready,[]);const ready=gate.push({type:'runtimeConnection',runtimeSequence:1,status:'connected'}).ready;
  assert.deepEqual(ready.map(x=>x.runtimeSequence),[1,2]);assert.deepEqual(gate.push(approval).ready,[]);
});

test('cursor ranges advance without timeline payload and overlap idempotently',()=>{
  const gate=new DurableFrameGate(4,{connectionGeneration:1});assert.equal(gate.push({type:'runtime_cursor',fromSequence:5,throughSequence:8}).ready.length,1);assert.equal(gate.appliedThrough(),8);assert.equal(gate.push({type:'runtime_cursor',fromSequence:7,throughSequence:9}).ready.length,1);assert.equal(gate.appliedThrough(),9);
});

test('old recovery epoch frames are ignored',()=>{
  const gate=new DurableFrameGate(10,{connectionGeneration:3,joinRequestId:'new',recoveryEpoch:4});assert.equal(gate.push({type:'approval',runtimeSequence:11,connectionGeneration:3,joinRequestId:'old',recoveryEpoch:3}).ignored,true);assert.equal(gate.appliedThrough(),10);
});
