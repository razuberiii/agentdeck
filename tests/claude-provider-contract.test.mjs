import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const registrySource = readFileSync(new URL('../server/src/provider-registry.ts', import.meta.url), 'utf8');
const profileStoreSource = readFileSync(new URL('../server/src/claude/claude-profile-store.ts', import.meta.url), 'utf8');
const mapperSource = readFileSync(new URL('../server/src/claude/claude-event-mapper.ts', import.meta.url), 'utf8');
const runtimeManagerSource = readFileSync(new URL('../server/src/claude/claude-runtime-manager.ts', import.meta.url), 'utf8');
const profileEnvSource = readFileSync(new URL('../server/src/claude/claude-profile-env.ts', import.meta.url), 'utf8');
const authSource = readFileSync(new URL('../server/src/claude/claude-auth.ts', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../server/src/agentdeck-runtime.ts', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');

test('Claude Code is registered as the second provider and Gemini remains last', () => {
  assert.match(registrySource, /PROVIDER_ORDER:\s*AgentProviderId\[\]\s*=\s*\['codex', 'claude', 'antigravity', 'gemini'\]/);
  assert.match(registrySource, /claude:\s*\{\s*id:'claude', displayName:'Claude Code', order:1/);
  assert.match(clientSource, /function visibleProviderIds/);
  assert.doesNotMatch(clientSource, /const PROVIDER_ORDER/);
});

test('Claude capabilities are explicit and do not invent quota or model discovery', () => {
  for (const capability of ['partialStreaming', 'toolCalls', 'approvals', 'askUserQuestion', 'sessionResume', 'attachments', 'imageInput', 'cancellation', 'modelSelection', 'accountManagement', 'workspaceSelection', 'diffArtifacts']) {
    assert.match(registrySource, new RegExp(`${capability}:supported`), `${capability} should be supported`);
  }
  assert.match(registrySource, /quota:unsupported\('quota_not_supported'/);
  assert.match(registrySource, /modelDiscovery:unsupported\('model_discovery_not_supported'/);
  assert.match(registrySource, /methods:\['official_cli','existing_cli_profile','setup_token','api_key'\]/);
});

test('Claude profile store keeps secrets out of SQLite and enforces file permissions', () => {
  assert.match(profileStoreSource, /CLAUDE_CODE_OAUTH_TOKEN = input\.token/);
  assert.match(profileStoreSource, /ANTHROPIC_API_KEY = input\.apiKey/);
  assert.match(profileStoreSource, /writeFile\(file, JSON\.stringify\(env\), \{ mode:0o600 \}\)/);
  assert.match(profileStoreSource, /chmod\(profileDir, 0o700\)/);
  assert.match(profileStoreSource, /chmod\(configDir, 0o700\)/);
  assert.match(profileStoreSource, /credential_summary/);
  assert.doesNotMatch(profileStoreSource, /INSERT INTO claude_profiles[^"]*CLAUDE_CODE_OAUTH_TOKEN/);
  assert.doesNotMatch(profileStoreSource, /INSERT INTO claude_profiles[^"]*ANTHROPIC_API_KEY/);
  assert.match(profileStoreSource, /input\.includes\('\.\.'\)/);
  assert.match(profileStoreSource, /outside allowed root/);
});

test('Claude runtime uses official SDK query with Claude Code preset and guarded permission mode', () => {
  assert.match(runtimeManagerSource, /for await \(const message of \(this\.options\.executeQuery \|\| query\)\(/);
  assert.match(runtimeManagerSource, /systemPrompt:\s*\{ type:'preset', preset:'claude_code' \}/);
  assert.match(runtimeManagerSource, /canUseTool/);
  assert.match(runtimeManagerSource, /AbortController/);
  assert.match(runtimeManagerSource, /allowDangerouslySkipPermissions:\s*input\.permissionMode === 'bypassPermissions'/);
  assert.match(runtimeManagerSource, /claudeProfileEnv\(input\.profile, env\)/);
  assert.match(runtimeSource, /v === 'yolo'\) return 'bypassPermissions'/);
  assert.match(runtimeSource, /v === 'workspace-write'\) return 'acceptEdits'/);
  assert.match(runtimeSource, /v === 'plan'\) return 'plan'/);
});

test('Claude official CLI login uses one isolated profile environment for login, status, logout, and SDK query', () => {
  assert.match(profileEnvSource, /export function claudeProfileEnv/);
  assert.match(profileEnvSource, /env\.HOME = profile\.profileDir/);
  assert.match(profileEnvSource, /env\.CLAUDE_CONFIG_DIR = profile\.configDir/);
  assert.match(authSource, /\['auth', 'status'\], claudeProfileEnv\(profile\)/);
  assert.match(authSource, /\['auth', 'logout'\], claudeProfileEnv\(profile\)/);
  assert.match(serverSource, /pty\.spawn\(String\(cli\.command\), \['auth', 'login'\]/);
  assert.match(serverSource, /env:claudeProfileEnv\(profile, \{\}, process\.env\)/);
  assert.match(serverSource, /await claudeProfileStore\.markStatus\(profile\.id, 'authenticated'\)/);
  assert.match(clientSource, /使用 Claude CLI 登录/);
  assert.match(clientSource, /其他登录方式/);
  assert.match(clientSource, /<details className="advancedLogin"/);
  assert.match(serverSource, /profiles\.filter\(profile => profile\.status === 'authenticated'\)\.map\(claudeProfileDto\)/);
  assert.match(serverSource, /if \(!profile \|\| profile\.status !== 'authenticated'\) return null/);
  assert.match(serverSource, /const verified = await claudeAuthStatus\(profile\)/);
  assert.match(serverSource, /if \(!verified\.ok\)[\s\S]*claudeProfileStore\.delete\(profile\.id\)/);
  assert.match(serverSource, /existing\.status !== 'authenticated'/);
});

test('Claude SDK mapper emits canonical events and redacts before persistence', () => {
  for (const eventType of ['claude/session_init', 'assistant/delta', 'reasoning/delta', 'tool/use', 'tool/result', 'assistant/final', 'turn/completed', 'turn/failed', 'claude/debug']) {
    assert.match(mapperSource, new RegExp(eventType.replace('/', '\\/')));
  }
  assert.match(mapperSource, /redactClaudeSecrets\(message\)/);
  assert.match(mapperSource, /persistDelta:true/);
  assert.match(mapperSource, /costUsd/);
  assert.match(mapperSource, /usage/);
});

test('Claude web integration keeps canonical user messages separate from provider attachment paths', () => {
  assert.match(serverSource, /buildClaudeTurnInput\(threadId, text, attachments\)/);
  assert.match(serverSource, /attachment_path/);
  assert.match(serverSource, /saveCanonicalUserMessage\(threadId, text, attachments, clientMessageId, turnId,retryOf,canonicalUserMessageId\(threadId,clientMessageId\)\)/);
  assert.match(serverSource, /answerClaudeApproval/);
  assert.match(clientSource, /accept_session/);
  assert.match(clientSource, /ClaudeProfileForm/);
});
