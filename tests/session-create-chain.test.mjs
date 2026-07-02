import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const webSource = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../server/src/agentdeck-runtime.ts', import.meta.url), 'utf8');
const lifecycleSource = readFileSync(new URL('../server/src/codex-profile-lifecycle.ts', import.meta.url), 'utf8');

test('Codex session creation validates active profile before runtime create', () => {
  assert.match(webSource, /codexCreateSessionPreflight\(\)/);
  assert.match(webSource, /const canonical:any = await getActiveProfile\(\)/);
  assert.match(lifecycleSource, /codex_no_active_profile/);
  assert.match(lifecycleSource, /codex_profile_not_authenticated/);
  assert.doesNotMatch(lifecycleSource, /codex_profile_identity_unresolved/);
});

test('Codex runtime create errors are structured and sanitized', () => {
  assert.match(webSource, /structuredSessionCreateError\('codex', e, 'web_session_api'\)/);
  assert.match(webSource, /safeDetail/);
  assert.match(webSource, /layer/);
  assert.match(runtimeSource, /new StructuredRuntimeError\(502/);
  assert.match(runtimeSource, /code:'codex_session_create_failed'/);
  assert.match(runtimeSource, /layer:'runtime_session_service'/);
});

test('Codex session creation does not fall back to default account after preflight', () => {
  const createBlock = webSource.slice(
    webSource.indexOf("const codexPreflight = await codexCreateSessionPreflight"),
    webSource.indexOf("const started = await codex.startThread")
  );
  assert.doesNotMatch(createBlock, /accountId: accountId \|\| 'default'/);
  assert.match(createBlock, /accountId,/);
  assert.match(createBlock, /codexHome: activeProfile\.codex_home/);
});

test('Codex turns use the current active profile as the explicit execution profile', () => {
  assert.match(webSource, /codexContinueSessionPreflight\(\)/);
  assert.match(webSource, /const activeProfile:any = continuePreflight\.profile/);
  assert.match(webSource, /codexExecutionContext\(activeProfile\)/);
  assert.match(webSource, /accountId:execution\.executingProfileId/);
  assert.match(webSource, /codexHome:execution\.runtime\.codexHome/);
  assert.match(webSource, /selectedProfileId:execution\.selectedProfileId/);
  assert.match(webSource, /executingProfileId:execution\.executingProfileId/);
  assert.match(webSource, /upstreamBindingProfileId/);
});

test('Codex runtime turn continuation rejects missing execution profile and records binding', () => {
  const turnBlock = runtimeSource.slice(
    runtimeSource.indexOf("const accountId = String(body.accountId || '').trim();"),
    runtimeSource.indexOf("app.post('/sessions/:id/stop'")
  );
  assert.match(turnBlock, /codex_executing_profile_required/);
  assert.doesNotMatch(turnBlock, /body\.accountId \|\| session\.current_upstream_account_id/);
  assert.match(turnBlock, /getOrEnsureCodexTurnAccount\(accountId, body\.codexHome\)/);
  assert.match(runtimeSource, /if \(nextHome\) return ensureAccount\(id, nextHome\)/);
  assert.match(turnBlock, /accountSwitched/);
  assert.match(turnBlock, /ensureLiveThread\(session, runtime, opts, cwd, accountSwitched\)/);
  assert.match(turnBlock, /selected_profile_id=\?1,executing_profile_id=\?2,upstream_binding_profile_id=\?2/);
  assert.match(turnBlock, /providerThreadId:threadId/);
});
