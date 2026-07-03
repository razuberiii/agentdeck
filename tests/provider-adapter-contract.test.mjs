import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const adapterSource = readFileSync(new URL('../server/src/provider-adapter.ts', import.meta.url), 'utf8');
const registrySource = readFileSync(new URL('../server/src/provider-registry.ts', import.meta.url), 'utf8');
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

test('Provider registry capabilities use supported false with reason codes for unsupported features', () => {
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
    assert.match(registrySource, new RegExp(`${capability}[:']`), `${capability} missing`);
  }
  assert.match(registrySource, /supported:false/);
  assert.match(registrySource, /reasonCode/);
  assert.match(registrySource, /message/);
  assert.match(registrySource, /quota_not_supported/);
  assert.match(registrySource, /model_discovery_not_supported/);
});

test('Provider registry fixes canonical order with Gemini last and Claude second', () => {
  assert.match(registrySource, /PROVIDER_ORDER:\s*AgentProviderId\[\]\s*=\s*\['codex', 'claude', 'antigravity', 'gemini'\]/);
  assert.match(registrySource, /displayName:'Claude Code'/);
  assert.match(registrySource, /id:'claude'/);
});

test('Unified ProviderStatus consumes adapter capabilities instead of page inference', () => {
  assert.match(serverSource, /providerCapabilitiesFor\('codex'\)/);
  assert.match(serverSource, /providerCapabilitiesFor\('claude'\)/);
  assert.match(serverSource, /providerCapabilitiesFor\('gemini'\)/);
  assert.match(serverSource, /providerCapabilitiesFor\('antigravity'\)/);
  assert.match(serverSource, /capabilities: adapterCapabilities\.codex/);
  assert.match(serverSource, /capabilities: adapterCapabilities\.claude/);
  assert.match(serverSource, /capabilities: adapterCapabilities\.gemini/);
  assert.match(serverSource, /capabilities: adapterCapabilities\.antigravity/);
});
