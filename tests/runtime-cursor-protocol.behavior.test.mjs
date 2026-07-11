import assert from 'node:assert/strict';
import test from 'node:test';
import {RuntimeCursorBridge} from '../server/src/runtime-cursor-bridge.ts';
import {applyTimelineMessage,applyTimelineSnapshot,emptyTimelineState} from '../client/src/timeline-reducer.ts';
import {matchingRecoveryAck,sameRecoveryRequest} from '../client/src/runtime-recovery.ts';

const visible=sequence=>({type:'codex',method:'item/completed',runtimeSequence:sequence,runtimeGeneration:'g1',params:{item:{id:`m${sequence}`,type:'agentMessage',text:`message ${sequence}`,phase:'final_answer'}}});
const cursor=(fromSequence,throughSequence,generation='g1')=>({type:'runtime_cursor',fromSequence,throughSequence,runtimeGeneration:generation});

test('filtered durable gap is represented by a payload-free range before the next visible event',()=>{
  const frames=[];const bridge=new RuntimeCursorBridge(frame=>frames.push(frame),{flushMs:1000});
  bridge.filtered(515,'g1');bridge.filtered(516,'g1');bridge.filtered(517,'g1');bridge.filtered(518,'g1');bridge.filtered(519,'g1');bridge.beforeVisible(520,'g1');
  assert.deepEqual(frames,[cursor(515,519)]);
  assert.equal(JSON.stringify(frames).includes('reasoning'),false);
  let state=emptyTimelineState(513);state=applyTimelineMessage(state,visible(514));state=applyTimelineMessage(state,frames[0]);state=applyTimelineMessage(state,visible(520));
  assert.equal(state.contiguousAppliedSequence,520);assert.equal(state.recovering,false);assert.deepEqual(state.liveMessages.map(x=>x.runtimeSequence),[514,520]);
});

test('filtered tail flushes without a later visible event',async()=>{
  const frames=[];const bridge=new RuntimeCursorBridge(frame=>frames.push(frame),{flushMs:5});
  for(let sequence=21;sequence<=30;sequence++)bridge.filtered(sequence,'g1');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(frames,[cursor(21,30)]);
});

test('one thousand filtered events coalesce without timeline or payload growth',()=>{
  const frames=[];const bridge=new RuntimeCursorBridge(frame=>frames.push(frame),{flushMs:1000});
  for(let sequence=1;sequence<=1000;sequence++)bridge.filtered(sequence,'g1');bridge.flush('test');
  assert.deepEqual(frames,[cursor(1,1000)]);assert.equal(Object.keys(frames[0]).length,4);
  const state=applyTimelineMessage(emptyTimelineState(),frames[0]);
  assert.equal(state.contiguousAppliedSequence,1000);assert.equal(state.liveMessages.length,0);assert.equal(state.recovering,false);
});

test('cursor ranges are idempotent, overlap safely, and preserve real gaps',()=>{
  let state=emptyTimelineState(10);state=applyTimelineMessage(state,cursor(11,15));state=applyTimelineMessage(state,cursor(11,15));state=applyTimelineMessage(state,cursor(13,18));
  assert.equal(state.contiguousAppliedSequence,18);assert.equal(state.recovering,false);
  state=applyTimelineMessage(state,cursor(20,22));assert.equal(state.contiguousAppliedSequence,18);assert.equal(state.recovering,true);
  state=applyTimelineMessage(state,visible(19));assert.equal(state.contiguousAppliedSequence,22);assert.equal(state.recovering,false);assert.deepEqual(state.liveMessages.map(x=>x.runtimeSequence),[19]);
});

test('snapshot-covered cursor is ignored and generation boundaries never merge',()=>{
  const frames=[];const bridge=new RuntimeCursorBridge(frame=>frames.push(frame),{flushMs:1000});
  bridge.filtered(51,'g1');bridge.filtered(52,'g2');bridge.flush('test');
  assert.deepEqual(frames,[cursor(51,51,'g1'),cursor(52,52,'g2')]);
  let state=applyTimelineSnapshot(emptyTimelineState(),[],60);state=applyTimelineMessage(state,cursor(51,59));
  assert.equal(state.contiguousAppliedSequence,60);assert.equal(state.recovering,false);
});

test('malformed cursor ranges never jump the durable cursor',()=>{
  const initial=emptyTimelineState(10);
  for(const frame of [cursor(0,12),cursor(11,10),cursor(11,Number.NaN)]){
    const state=applyTimelineMessage(initial,frame);assert.equal(state.contiguousAppliedSequence,10);assert.equal(state.recovering,false);assert.equal(state.liveMessages.length,0);
  }
});

test('recovery requests single-flight until the exact join acknowledgement',()=>{
  const active={epoch:7,joinRequestId:'join-7',targetGeneration:'g2',connectionGeneration:4};
  for(const trigger of ['sequence_gap','runtime_recovering','websocket_reconnect','generation_change','snapshot_reload'])assert.equal(sameRecoveryRequest(active,'g2',4),true,trigger);
  assert.equal(sameRecoveryRequest(active,'g3',4),false);
  assert.equal(sameRecoveryRequest(active,'g2',5),false);
  const ack={type:'joined',sessionId:'session-1',runtimeGeneration:'g2',recoveryEpoch:7,joinRequestId:'join-7'};
  assert.equal(matchingRecoveryAck(active,ack,'session-1',4),true);
  assert.equal(matchingRecoveryAck(active,{...ack,recoveryEpoch:6},'session-1',4),false);
  assert.equal(matchingRecoveryAck(active,{...ack,runtimeGeneration:'g1'},'session-1',4),false);
  assert.equal(matchingRecoveryAck(active,ack,'other-session',4),false);
  assert.equal(matchingRecoveryAck(active,ack,'session-1',3),false);
});
