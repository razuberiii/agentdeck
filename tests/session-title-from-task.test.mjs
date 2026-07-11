import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('task creation derives a bounded title on the server', async () => {
  const server=await readFile(new URL('../server/src/index.ts',import.meta.url),'utf8');
  assert.match(server,/sessionTitleFromTask\(req\.body\?\.initialTask, requestedTitle \|\| path\.basename\(projectDir\)\)/);
  const helper=server.slice(server.indexOf('function sessionTitleFromTask'),server.indexOf('async function runtimeAdminState'));
  assert.match(helper,/split\('\\n'\)/);
  assert.match(helper,/chars\.length>72/);
  assert.match(helper,/slice\(0,71\)\.join\(''\)\+'…'/);
});

test('task-first client sends the initial task to create-session', async () => {
  const client=await readFile(new URL('../client/src/main.tsx',import.meta.url),'utf8');
  assert.match(client,/initialTask:initialTask\.trim\(\)\|\|undefined/);
});

test('placeholder New task titles are replaced for every provider before dispatch',async()=>{
  const server=await readFile(new URL('../server/src/index.ts',import.meta.url),'utf8');
  const sendTurn=server.slice(server.indexOf('async function sendTurn'),server.indexOf('async function stopTurn'));
  assert.match(sendTurn,/const generatedTitle=autoTitle\(originalText/);
  assert.ok(sendTurn.indexOf('const generatedTitle=autoTitle(originalText')<sendTurn.indexOf("normalizeProvider(row.provider_id) === 'antigravity'"));
  assert.match(server,/'new task'/);
  assert.match(server,/'新任务'/);
  assert.match(sendTurn,/broadcast\(threadId,\{type:'sessionTitle',title:generatedTitle\}\)/);
});
