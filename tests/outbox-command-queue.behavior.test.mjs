import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionCommandQueue } from '../server/dist/websocket-command-queue.js';

test('same-session commands are serial while different sessions can progress',async()=>{
  const queue=new SessionCommandQueue(4); const order=[]; let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const first=queue.run('s1',async()=>{order.push('first:start');await gate;order.push('first:end');});
  const second=queue.run('s1',async()=>{order.push('second');});
  const other=queue.run('s2',async()=>{order.push('other');});
  await other; assert.deepEqual(order,['first:start','other']); release(); await Promise.all([first,second]);
  assert.deepEqual(order,['first:start','other','first:end','second']);
});

test('a failed command does not poison later session commands',async()=>{
  const queue=new SessionCommandQueue();
  await assert.rejects(queue.run('s',async()=>{throw new Error('boom');}),/boom/);
  assert.equal(await queue.run('s',async()=>42),42);
});
