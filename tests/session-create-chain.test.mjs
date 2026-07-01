import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const webSource = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../server/src/agentdeck-runtime.ts', import.meta.url), 'utf8');

test('Codex session creation validates active profile before runtime create', () => {
  assert.match(webSource, /codexCreateSessionPreflight\(activeProfile\)/);
  assert.match(webSource, /codex_no_active_profile/);
  assert.match(webSource, /codex_profile_identity_unresolved/);
  assert.match(webSource, /codex_profile_not_authenticated/);
  assert.match(webSource, /当前 Codex Profile 仍是占位身份 Codex Account/);
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
