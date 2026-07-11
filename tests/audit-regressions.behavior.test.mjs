import assert from 'node:assert/strict';
import test from 'node:test';
import {dispatchRecoveryFrames} from '../client/src/runtime-recovery.ts';
import {queueAndSendPendingTask} from '../client/src/pending-task-outbox.ts';
import {attachmentLimitError,providerAttachmentCapabilities} from '../client/src/attachment-policy.ts';
import {applyAuthoritativeTimelineSnapshot,emptyTimelineState} from '../client/src/timeline-reducer.ts';
import {loadDraftAttachments,saveDraftAttachments} from '../client/src/utils/storage.ts';
import {BrowserDeliveryHub} from '../server/dist/browser-delivery.js';
import {withReceiptFailure} from '../server/src/message-receipt.ts';

test('two consecutive runtime recoveries resolve and do not retain the previous promise',()=>{
  const ref={current:null};let resolved=0,applied=[];
  const recover=epoch=>{const recovery={epoch,promise:{epoch}};ref.current=recovery;return recovery.promise;};
  const apply=frame=>{applied.push(frame.type);if(frame.type==='joined'){ref.current=null;resolved++;}};
  const first=recover(1);dispatchRecoveryFrames([{type:'runtime_cursor',runtimeSequence:10},{type:'joined'}],ref,f=>Number(f.runtimeSequence||0),apply);
  assert.equal(ref.current,null);const second=recover(2);assert.notEqual(second,first);
  dispatchRecoveryFrames([{type:'runtime_cursor',runtimeSequence:11},{type:'joined'},{type:'runtimeConnection'}],ref,f=>Number(f.runtimeSequence||0),apply);
  assert.equal(ref.current,null);assert.equal(resolved,2);assert.deepEqual(applied.at(-1), 'runtimeConnection');
});

test('initial task survives a socket close after send and is retried with the same id',async()=>{
  const records=new Map();const outbox={retryDelay:()=>500,async put(r){records.set(r.clientMessageId,{...r});},async update(id,p){records.set(id,{...records.get(id),...p});}};
  const sent=[];await queueAndSendPendingTask({outbox,sessionId:'s',text:'first',attachments:[{id:'attachment-1',name:'a.txt'}],planMode:'direct',uuid:()=> 'message-1',now:()=>100,send:id=>{sent.push(id);}});
  assert.equal(records.get('message-1').status,'sent');assert.equal(records.get('message-1').attachments[0].id,'attachment-1');
  sent.push(records.get('message-1').clientMessageId);assert.deepEqual(sent,['message-1','message-1']);
});

test('provider-specific file capability and aggregate limits are enforced',()=>{
  const caps={imageInput:true,fileInput:false,maxAttachmentBytes:10,maxAttachmentsPerMessage:2,maxTotalAttachmentBytes:12,providers:{gemini:{fileInput:true}}};
  assert.equal(providerAttachmentCapabilities(caps,'gemini').fileInput,true);
  assert.match(attachmentLimitError([{size:8}],{size:5},caps),/总大小/);
  assert.match(attachmentLimitError([{size:1},{size:1}],{size:1},caps),/最多/);
});

test('blob previews are not restored from local storage',()=>{
  const values=new Map();globalThis.localStorage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  saveDraftAttachments('s',[{id:'attachment-1',name:'a.png',type:'image/png',size:1,url:'/server',previewUrl:'blob:dead'}]);
  assert.equal(loadDraftAttachments('s')[0].previewUrl,undefined);
});

test('authoritative snapshot rolls a restored database cursor backwards',()=>{
  const stale=emptyTimelineState(200);const restored=applyAuthoritativeTimelineSnapshot(stale,[],100);
  assert.equal(restored.contiguousAppliedSequence,100);assert.equal(restored.coveredSequence,100);
});

test('releasing the last session frees its delivery ring',()=>{
  const hub=new BrowserDeliveryHub();hub.publish('old',1,'g',[{type:'system'}]);assert.equal(hub.metrics().sessions,1);hub.releaseSession('old');assert.deepEqual(hub.metrics(),{sessions:0,sequences:0,bytes:0});
});

test('attachment and provider preflight failures become terminal receipts and duplicate ids do not execute again',async()=>{
  for(const failure of ['attachment not found','provider unavailable']){
    const receipts=new Map([['message-1','received']]);let executions=0;
    await assert.rejects(withReceiptFailure(async()=>{executions++;throw new Error(failure);},async message=>{receipts.set('message-1',`failed:${message}`);}),new RegExp(failure));
    const retry=async id=>{if(receipts.has(id))return receipts.get(id);executions++;};
    assert.equal(await retry('message-1'),`failed:${failure}`);assert.equal(executions,1);
  }
});
