import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('dashboard API aggregates mission-control metrics from canonical sessions', async () => {
  const server = await readFile(new URL('../server/src/index.ts', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("app.get('/api/dashboard'"), server.indexOf("app.post('/api/sessions'"));
  assert.match(route, /preHandler: ensureAuth/);
  assert.match(route, /Promise\.all\(\[listIndexedThreads\(archived\), lightAppState\(\), dashboardArtifacts\(\)\]\)/);
  assert.match(route, /lightAppState\(\)/);
  assert.match(route, /running:/);
  assert.match(route, /waiting:/);
  assert.match(route, /updatedToday:/);
  assert.match(route, /activity/);
  assert.match(route, /projects:\[\.\.\.projects\.values\(\)\]/);
  assert.match(route, /sessions,/);
  assert.match(route, /control,/);
  assert.match(route, /dashboardArtifacts\(\)/);
  assert.match(route, /artifacts,/);
});

test('client dashboard contract stays typed', async () => {
  const types = await readFile(new URL('../client/src/api/types.ts', import.meta.url), 'utf8');
  assert.match(types, /export type Dashboard =/);
  assert.match(types, /control:Status/);
  assert.match(types, /artifacts:\{total:number;items:DashboardArtifact\[\]\}/);
  assert.match(types, /metrics:\{total:number;running:number;waiting:number;updatedToday:number;projects:number\}/);
});
