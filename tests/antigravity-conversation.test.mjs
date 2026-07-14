import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTypeScript } from './helpers/import-typescript.mjs';
const { buildAntigravityArgs, parseAntigravityConversation, antigravityResumeOutcome, antigravityMetadata, resolveAntigravityBinary } = await importTypeScript(new URL('../server/src/antigravity-cli.ts',import.meta.url));

const id='ce69f19b-3085-4abf-b514-03b7e4d0813a';
test('first Antigravity turn creates an explicit durable conversation with two hour print timeout',()=>{
  const args=buildAntigravityArgs({prompt:'hello',mode:'accept-edits',yolo:false,logFile:'/tmp/turn.log'});
  assert.equal(args.includes('--conversation'),false);assert.deepEqual(args.slice(-4),['--print-timeout','2h','--print','hello']);assert.deepEqual(args.slice(0,2),['--mode','accept-edits']);
});
test('subsequent plan turn targets the exact conversation without YOLO permissions',()=>{
  const args=buildAntigravityArgs({prompt:'next',mode:'plan',yolo:true,conversationId:id,logFile:'/tmp/turn.log'});
  assert.deepEqual(args.slice(args.indexOf('--conversation'),args.indexOf('--conversation')+2),['--conversation',id]);assert.equal(args.includes('--dangerously-skip-permissions'),false);assert.deepEqual(args.slice(0,2),['--mode','plan']);
});
test('direct YOLO and validated attachment directories are preserved',()=>{const args=buildAntigravityArgs({prompt:'edit',mode:'accept-edits',yolo:true,addDirs:['/safe/a','/safe/a']});assert.ok(args.includes('--dangerously-skip-permissions'));assert.deepEqual(args.slice(args.indexOf('--add-dir'),args.indexOf('--add-dir')+2),['--add-dir','/safe/a']);});
test('conversation id is extracted from the per-turn official log and silent fallback is rejected',()=>{
  assert.equal(parseAntigravityConversation(`Created conversation ${id}\nPrint mode: conversation=${id}, sending message`),id);
  assert.deepEqual(antigravityResumeOutcome(id,id),{ok:true,recreated:false,reason:null});
  assert.equal(antigravityResumeOutcome(id,'49f2fc8e-7d8e-4f06-8799-3988e5b0f2f7').reason,'requested_conversation_not_resumed');
});
test('profile binding metadata survives upgrades and corrupt metadata degrades safely',()=>{
  assert.deepEqual(antigravityMetadata('{broken',{profileId:'p1'}),{metadataCorrupt:true,profileId:'p1',provider:'antigravity'});
  assert.equal(antigravityMetadata(JSON.stringify({profileId:'p1'}),{conversationId:id}).profileId,'p1');
});
test('runtime binary resolution checks the managed provider directory before PATH',async()=>{const root=await mkdtemp(join(tmpdir(),'agy-bin-'));const bin=join(root,'provider-tools','bin');await mkdir(bin,{recursive:true});await writeFile(join(bin,'agy'),'#!/bin/sh\n',{mode:0o755});assert.equal(await resolveAntigravityBinary({dataDir:root,homeDir:root,pathEnv:'/missing'}),join(bin,'agy'));await assert.rejects(()=>resolveAntigravityBinary({dataDir:join(root,'none'),homeDir:join(root,'none'),pathEnv:'/missing'}),/provider_binary_not_found/);});
