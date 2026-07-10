import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source=await readFile(new URL('../server/src/index.ts',import.meta.url),'utf8');

for(const [provider,route,nextRoute] of [
  ['codex',"app.post('/api/profiles/:id/switch'","app.delete('/api/profiles/:id'"],
  ['claude',"app.post('/api/claude/profiles/:id/switch'","app.post('/api/claude/profiles/:id/logout'"],
  ['gemini',"app.post('/api/gemini/profiles/:id/switch'","app.post('/api/gemini/profiles/:id/refresh'"],
  ['antigravity',"app.post('/api/antigravity/profiles/:id/switch'","app.delete('/api/antigravity/profiles/:id'"],
]) test(`${provider} account switch invalidates its cache without forcing unrelated provider probes`,()=>{
  const block=source.slice(source.indexOf(route),source.indexOf(nextRoute));
  assert.match(block,new RegExp(`invalidateProviderCaches\\('${provider}'\\)`));
  assert.match(block,/await unifiedProviderStatuses\(false\)/);
  assert.match(block,/providerStatus:/);
});

test('settings applies returned provider status immediately',async()=>{
  const client=await readFile(new URL('../client/src/main.tsx',import.meta.url),'utf8');
  assert.match(client,/function applyFreshProviderStatus\(provider:ProviderId,status:any\)/);
  for(const provider of ['codex','claude','gemini','antigravity']) assert.match(client,new RegExp(`applyFreshProviderStatus\\('${provider}',result\\.providerStatus\\)`));
  for(const name of ['switchProfile','switchClaudeProfile','switchGeminiProfile','switchAntigravityProfile']) {
    const start=client.indexOf(`async function ${name}`);
    const block=client.slice(start,client.indexOf('async function',start+20));
    assert.match(block,/syncSettings\(\)\.catch\(\(\)=>\{\}\)/);
    assert.doesNotMatch(block,/await syncSettings\(\);/);
  }
});

test('account switch refreshes the home status source and active profile rows',async()=>{
  const client=await readFile(new URL('../client/src/main.tsx',import.meta.url),'utf8');
  assert.match(client,/api\('\/api\/status'\+\(force\?'\?refresh=1':''\)\)/);
  assert.match(client,/onChanged=\{async\(\)=>\{ await refreshSessions\(\); await refreshStatus\(\);/);
  for(const provider of ['claude','gemini','antigravity']) assert.match(client,new RegExp(`markActiveProfile\\(id,'${provider}'\\)`));
});

test('agent selection stays optimistic and does not invalidate provider health',async()=>{
  const client=await readFile(new URL('../client/src/main.tsx',import.meta.url),'utf8');
  const settingsRoute=source.slice(source.indexOf("app.patch('/api/settings'"),source.indexOf("app.get('/api/models'"));
  assert.doesNotMatch(settingsRoute,/if \(provider\).*invalidateUnifiedProviderStatuses/);
  const switchBlock=client.slice(client.indexOf('async function switchProvider'),client.indexOf('const activeProvider='));
  assert.match(switchBlock,/setStatus\(current=>current\?\{\.\.\.current,activeProvider:provider\}/);
  assert.doesNotMatch(switchBlock,/await refreshSessions\(\)/);
});
