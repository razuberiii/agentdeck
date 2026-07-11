import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {queueAndSendPendingTask} from '../client/src/pending-task-outbox.ts';

test('home task composer creates a persistent session and auto-submits after join', async () => {
  const records=[];const sent=[];
  const outbox={retryDelay:()=>500,async put(record){records.push({...record});},async update(id,patch){Object.assign(records.find(row=>row.clientMessageId===id),patch);}};
  const id=await queueAndSendPendingTask({outbox,sessionId:'session-1',text:'first task',attachments:[],planMode:'plan',uuid:()=> 'message-1',now:()=>1,send:messageId=>sent.push(messageId)});
  assert.equal(id,'message-1');assert.deepEqual(sent,['message-1']);assert.equal(records[0].status,'sent');assert.equal(records[0].planMode,'plan');
});

test('dashboard bootstrap replaces the separate home app-state request', async () => {
  const source = await readFile(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
  const home = source.slice(source.indexOf('function Home()'), source.indexOf('function SessionRow'));
  assert.match(home, /setStatus\(next\.control\)/);
  assert.doesNotMatch(home, /api\('\/api\/app-state'/);
});
