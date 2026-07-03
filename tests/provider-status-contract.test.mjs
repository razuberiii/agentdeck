import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extractGeminiModelOptions, providerAuthLabel, providerStatus } from '../server/dist/provider-status.js';

const providersSource = readFileSync(new URL('../server/src/providers.ts', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');

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
  assert.equal(status.canContinueSession, true);
  assert.equal(status.canSelectModel, true);
  assert.equal(providerAuthLabel(status.auth, status.availability), '已登录');
  assert.equal(status.account.email, 'user@example.com');
  assert.deepEqual(status.accountSummary, {
    profileId: 'g1',
    providerAccountId: 'g1',
    email: 'user@example.com',
    displayName: undefined,
    authType: 'oauth-personal',
  });
});

test('Gemini personal OAuth unsupported remains authenticated but cannot create sessions', () => {
  assert.match(indexSource, /function isGeminiPersonalUnsupportedProfile/);
  assert.match(indexSource, /geminiPersonalUnsupported/);
  assert.match(indexSource, /reasonCode: geminiReason/);
  assert.match(indexSource, /'gemini_client_unsupported'/);
  assert.match(indexSource, /canCreateSession: !!geminiCli\?\.ok && USE_AGENT_RUNTIME && geminiAuth === 'authenticated' && !geminiPersonalUnsupported/);
  assert.match(indexSource, /canContinueSession: !!geminiCli\?\.ok && USE_AGENT_RUNTIME && geminiAuth === 'authenticated' && !geminiPersonalUnsupported/);
  assert.match(indexSource, /isGeminiPersonalUnsupportedProfile\(activeProfile\)/);
  assert.match(indexSource, /authType/);
  assert.match(indexSource, /api_key/);
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
  assert.equal(unauthenticated.canContinueSession, false);
  assert.equal(typeof unauthenticated.canManageAccounts, 'boolean');
  assert.equal(typeof unauthenticated.canQueryQuota, 'boolean');
  assert.equal(typeof unauthenticated.canListModels, 'boolean');
  assert.equal(typeof unauthenticated.canSelectModel, 'boolean');
  assert.equal(typeof unauthenticated.capabilities, 'object');
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
  assert.equal(status.canContinueSession, true);
});

test('ProviderStatus exposes the full phase 8 contract without UI inference', () => {
  const status = providerStatus({
    provider: 'codex',
    displayName: 'Codex',
    cliStatus: { ok:true, version:'codex-cli 0.133.0' },
    auth: 'authenticated',
    account: { id:'provider-c1', profileId:'profile-c1', email:'codex@example.com', displayName:'Codex User', authType:'chatgpt' },
    activeProfileId: 'profile-c1',
    canCreateSession: true,
    canContinueSession: true,
    canManageAccounts: true,
    canQueryQuota: true,
    canListModels: true,
    canSelectModel: true,
    capabilities: { imageInput:true },
    checkedAt: '2026-07-01T00:00:00.000Z',
  });

  for (const key of ['provider','availability','auth','accountSummary','version','activeProfileId','canCreateSession','canContinueSession','canManageAccounts','canQueryQuota','canListModels','canSelectModel','capabilities','reasonCode','message','checkedAt']) {
    assert.ok(Object.hasOwn(status, key), `${key} missing`);
  }
  assert.equal(status.accountSummary.profileId, 'profile-c1');
  assert.equal(status.accountSummary.providerAccountId, 'provider-c1');
  assert.equal(status.capabilities.imageInput, true);
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

test('Antigravity binary resolution is deterministic and reports ENOENT explicitly', () => {
  const antigravityClass = providersSource.slice(
    providersSource.indexOf('export class AntigravityProvider'),
    providersSource.indexOf('export class GeminiProvider'),
  );
  assert.match(antigravityClass, /process\.env\.ANTIGRAVITY_BIN \|\| ''/);
  assert.match(antigravityClass, /detectProviderCommand\(this\.command, 'agy'\)/);
  assert.doesNotMatch(antigravityClass, /'gemini'/);
  assert.match(antigravityClass, /provider_binary_not_found/);
  assert.doesNotMatch(indexSource, /\/home\/ubuntu\/\.local\/bin\/agy/);
  assert.match(indexSource, /ensureAntigravityBinary/);
  assert.match(indexSource, /resolveAntigravityBinary/);
  assert.match(indexSource, /detectManagedCommand\(process\.env\.ANTIGRAVITY_BIN \|\| '', 'agy'\)/);
  assert.match(indexSource, /structuredProviderError\('provider_binary_not_found'/);
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

test('Gemini CLI status allows slow version and help probes without prompt calls', () => {
  const geminiClass = providersSource.slice(
    providersSource.indexOf('export class GeminiProvider'),
    providersSource.indexOf('function antigravityFallbackModels'),
  );
  assert.match(geminiClass, /tryExecDetailed\(found, \['--version'\], undefined, 10_000, 'gemini --version'\)/);
  assert.match(geminiClass, /tryExecDetailed\(found, \['--help'\], undefined, 10_000, 'gemini --help'\)/);
  assert.doesNotMatch(geminiClass, /prompt|sendMessage|generateContent/i);
});
