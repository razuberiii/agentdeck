import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source=await readFile(new URL('../server/src/index.ts',import.meta.url),'utf8');

for(const [provider,route,nextRoute] of [
  ['codex',"app.post('/api/profiles/:id/switch'","app.delete('/api/profiles/:id'"],
  ['claude',"app.post('/api/claude/profiles/:id/switch'","app.post('/api/claude/profiles/:id/logout'"],
  ['gemini',"app.post('/api/gemini/profiles/:id/switch'","app.post('/api/gemini/profiles/:id/refresh'"],
  ['antigravity',"app.post('/api/antigravity/profiles/:id/switch'","app.delete('/api/antigravity/profiles/:id'"],
]) test(`${provider} account switch rebuilds and returns fresh provider status`,()=>{
  const block=source.slice(source.indexOf(route),source.indexOf(nextRoute));
  assert.match(block,new RegExp(`invalidateProviderCaches\\('${provider}'\\)`));
  assert.match(block,/await unifiedProviderStatuses\(true\)/);
  assert.match(block,/providerStatus:/);
});

test('settings applies returned provider status immediately',async()=>{
  const client=await readFile(new URL('../client/src/main.tsx',import.meta.url),'utf8');
  assert.match(client,/function applyFreshProviderStatus\(provider:ProviderId,status:any\)/);
  for(const provider of ['codex','claude','gemini','antigravity']) assert.match(client,new RegExp(`applyFreshProviderStatus\\('${provider}',result\\.providerStatus\\)`));
});
