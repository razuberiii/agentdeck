import assert from 'node:assert/strict';
import test from 'node:test';
import { extractGeminiModelOptions, providerAuthLabel, providerStatus } from '../server/dist/provider-status.js';

test('Gemini authenticated profile remains authenticated with authMethods metadata', () => {
  const status = providerStatus({
    provider: 'gemini',
    displayName: 'Gemini',
    cliStatus: { ok:true, version:'0.49.0', authMethods:[{ id:'oauth-personal' }, { id:'api-key' }, { id:'vertex' }, { id:'gateway' }] },
    auth: 'authenticated',
    account: { id:'g1', profileId:'g1', email:'user@example.com', authType:'oauth-personal' },
    activeProfileId: 'g1',
    canCreateSession: true,
    checkedAt: '2026-07-01T00:00:00.000Z',
  });

  assert.equal(status.auth, 'authenticated');
  assert.equal(status.canCreateSession, true);
  assert.equal(providerAuthLabel(status.auth, status.availability), '已登录');
  assert.equal(status.account.email, 'user@example.com');
});

test('Codex authenticated and unauthenticated statuses use same contract', () => {
  const authenticated = providerStatus({
    provider: 'codex',
    displayName: 'Codex',
    cliStatus: { ok:true, version:'codex-cli 0.133.0' },
    auth: 'authenticated',
    account: { id:'c1', email:'codex@example.com' },
    activeProfileId: 'c1',
  });
  const unauthenticated = providerStatus({
    provider: 'codex',
    displayName: 'Codex',
    cliStatus: { ok:true, version:'codex-cli 0.133.0' },
    auth: 'unauthenticated',
    canCreateSession: false,
    message: '请先登录 Codex',
  });

  assert.equal(providerAuthLabel(authenticated.auth, authenticated.availability), '已登录');
  assert.equal(providerAuthLabel(unauthenticated.auth, unauthenticated.availability), '未登录');
  assert.equal(unauthenticated.canCreateSession, false);
});

test('Antigravity unknown auth is neutral, not unauthenticated', () => {
  const status = providerStatus({
    provider: 'antigravity',
    displayName: 'Antigravity',
    cliStatus: { ok:true, version:'1.0.14' },
    auth: 'unknown',
    account: { id:'a1', displayName:'Antigravity Account' },
    activeProfileId: 'a1',
    canCreateSession: true,
  });

  assert.equal(status.auth, 'unknown');
  assert.equal(providerAuthLabel(status.auth, status.availability), '状态未知');
  assert.equal(status.canCreateSession, true);
});

test('unavailable availability renders service unavailable instead of not logged in', () => {
  const status = providerStatus({
    provider: 'gemini',
    displayName: 'Gemini',
    cliStatus: { ok:false, error:'spawn gemini ENOENT' },
    auth: 'unknown',
    canCreateSession: false,
  });

  assert.equal(status.availability, 'unavailable');
  assert.equal(providerAuthLabel(status.auth, status.availability), '服务不可用');
});

test('Gemini ACP session configOptions expose model choices', () => {
  const models = extractGeminiModelOptions({
    configOptions: [{
      id: 'model',
      category: 'model',
      options: [
        { value:'gemini-2.5-pro', label:'Gemini 2.5 Pro', selected:true },
        { value:'gemini-2.5-flash', label:'Gemini 2.5 Flash' },
      ],
    }],
  });

  assert.deepEqual(models.map(model => model.id), ['gemini-2.5-pro', 'gemini-2.5-flash']);
  assert.equal(models[0].isDefault, true);
});

test('Gemini legacy model fields are parsed without prompt calls', () => {
  const models = extractGeminiModelOptions({
    availableModels: ['default-a', { id:'default-b', displayName:'Default B' }],
    currentModel: 'default-b',
  });

  assert.deepEqual(models.map(model => model.id), ['default-a', 'default-b']);
  assert.equal(models[1].isDefault, true);
});
