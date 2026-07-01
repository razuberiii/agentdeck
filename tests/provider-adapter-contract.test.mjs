import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const adapterSource = readFileSync(new URL('../server/src/provider-adapter.ts', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');

test('ProviderAdapter declares the full phase 9 operation surface', () => {
  for (const method of [
    'getStatus',
    'getCapabilities',
    'createSession',
    'loadSession',
    'rebindSession',
    'sendTurn',
    'cancelTurn',
    'getModels',
    'setModel',
    'getQuota',
    'startLogin',
    'completeLogin',
    'cancelLogin',
    'logout',
    'deleteProfile',
    'getAccountIdentity',
    'ensureRuntime',
  ]) {
    assert.match(adapterSource, new RegExp(`${method}\\(`), `${method} missing`);
  }
});

test('ProviderAdapter capabilities use supported false with reason codes for unsupported features', () => {
  for (const capability of [
    'authentication',
    'accountManagement',
    'persistentSessions',
    'streaming',
    'cancellation',
    'attachments',
    'modelSelection',
    'modelDiscovery',
    'quota',
    'sessionResume',
    'crossProfileResume',
  ]) {
    assert.match(adapterSource, new RegExp(`${capability}[:']`), `${capability} missing`);
  }
  assert.match(adapterSource, /supported:false/);
  assert.match(adapterSource, /reasonCode/);
  assert.match(adapterSource, /message/);
});

test('Unified ProviderStatus consumes adapter capabilities instead of page inference', () => {
  assert.match(serverSource, /providerCapabilitiesFor\('codex'\)/);
  assert.match(serverSource, /providerCapabilitiesFor\('gemini'\)/);
  assert.match(serverSource, /providerCapabilitiesFor\('antigravity'\)/);
  assert.match(serverSource, /capabilities: adapterCapabilities\.codex/);
  assert.match(serverSource, /capabilities: adapterCapabilities\.gemini/);
  assert.match(serverSource, /capabilities: adapterCapabilities\.antigravity/);
});
