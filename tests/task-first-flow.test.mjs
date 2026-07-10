import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('home task composer creates a persistent session and auto-submits after join', async () => {
  const source = await readFile(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
  assert.match(source, /className="taskPrompt"/);
  assert.match(source, /storageSet\(pendingTaskKey\(s\.id\),initialTask\.trim\(\)\)/);
  assert.match(source, /const pendingTask=storageGet\(pendingTaskKey\(id\)\)/);
  assert.match(source, /sendMessage\(ws,id,\{text:pendingTask\.trim\(\),attachments:\[\],planMode:'direct'\}\)/);
  assert.match(source, /storageRemove\(pendingTaskKey\(id\)\)/);
});

test('dashboard bootstrap replaces the separate home app-state request', async () => {
  const source = await readFile(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
  const home = source.slice(source.indexOf('function Home()'), source.indexOf('function SessionRow'));
  assert.match(home, /setStatus\(next\.control\)/);
  assert.doesNotMatch(home, /api\('\/api\/app-state'/);
});
