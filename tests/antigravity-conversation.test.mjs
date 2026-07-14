import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAntigravityArgs, parseAntigravityConversation, antigravityResumeOutcome, antigravityMetadata } from '../server/dist/antigravity-cli.js';

const id='ce69f19b-3085-4abf-b514-03b7e4d0813a';
test('first Antigravity turn creates an explicit durable conversation with two hour print timeout',()=>{
  const args=buildAntigravityArgs({prompt:'hello',mode:'accept-edits',yolo:false,logFile:'/tmp/turn.log'});
  assert.equal(args.includes('--conversation'),false);assert.deepEqual(args.slice(-4),['--print-timeout','2h','--print','hello']);assert.deepEqual(args.slice(0,2),['--mode','accept-edits']);
});
test('subsequent and plan/yolo turns target the exact conversation',()=>{
  const args=buildAntigravityArgs({prompt:'next',mode:'plan',yolo:true,conversationId:id,logFile:'/tmp/turn.log'});
  assert.deepEqual(args.slice(args.indexOf('--conversation'),args.indexOf('--conversation')+2),['--conversation',id]);assert.ok(args.includes('--dangerously-skip-permissions'));assert.deepEqual(args.slice(0,2),['--mode','plan']);
});
test('conversation id is extracted from the per-turn official log and silent fallback is rejected',()=>{
  assert.equal(parseAntigravityConversation(`Created conversation ${id}\nPrint mode: conversation=${id}, sending message`),id);
  assert.deepEqual(antigravityResumeOutcome(id,id),{ok:true,recreated:false,reason:null});
  assert.equal(antigravityResumeOutcome(id,'49f2fc8e-7d8e-4f06-8799-3988e5b0f2f7').reason,'requested_conversation_not_resumed');
});
test('profile binding metadata survives upgrades and corrupt metadata degrades safely',()=>{
  assert.deepEqual(antigravityMetadata('{broken',{profileId:'p1'}),{metadataCorrupt:true,profileId:'p1',provider:'antigravity'});
  assert.equal(antigravityMetadata(JSON.stringify({profileId:'p1'}),{conversationId:id}).profileId,'p1');
});
