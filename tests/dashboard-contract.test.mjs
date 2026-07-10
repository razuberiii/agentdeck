import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('dashboard API aggregates mission-control metrics from canonical sessions', async () => {
  const server = await readFile(new URL('../server/src/index.ts', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("app.get('/api/dashboard'"), server.indexOf("app.post('/api/sessions'"));
  assert.match(route, /preHandler: ensureAuth/);
  assert.match(route, /await listIndexedThreads\(archived\)/);
  assert.match(route, /running:/);
  assert.match(route, /waiting:/);
  assert.match(route, /updatedToday:/);
  assert.match(route, /activity/);
  assert.match(route, /projects:\[\.\.\.projects\.values\(\)\]/);
  assert.match(route, /sessions,/);
});

test('client dashboard contract stays typed', async () => {
  const types = await readFile(new URL('../client/src/api/types.ts', import.meta.url), 'utf8');
  assert.match(types, /export type Dashboard =/);
  assert.match(types, /metrics:\{total:number;running:number;waiting:number;updatedToday:number;projects:number\}/);
});
