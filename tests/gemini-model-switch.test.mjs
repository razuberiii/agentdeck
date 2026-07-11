import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexSource = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../server/src/acp/gemini-runtime.ts', import.meta.url), 'utf8');
const agentRuntimeSource = readFileSync(new URL('../server/src/agentdeck-runtime.ts', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
const schemaSource = readFileSync(new URL('../server/src/schema-migrations.ts', import.meta.url), 'utf8');

test('Gemini profiles store model defaults independently from global settings', () => {
  assert.match(schemaSource, /default_model_mode:"TEXT NOT NULL DEFAULT 'auto'"/);
  assert.match(schemaSource, /default_model:'TEXT'/);
  assert.match(indexSource, /setActiveGeminiDefaultModel/);
  assert.match(indexSource, /UPDATE gemini_profiles SET default_model_mode=\?1, default_model=\?2/);
  assert.doesNotMatch(indexSource, /modelProvider === 'gemini' \? 'defaultModelGemini'/);
});

test('Gemini current session model switch uses ACP config option without sending a prompt', () => {
  assert.match(runtimeSource, /methods\.agent\.session\.setConfigOption/);
  assert.match(runtimeSource, /configId: modelConfig\.id/);
  const switchBody = runtimeSource.slice(runtimeSource.indexOf('async setSessionModel'), runtimeSource.indexOf('async authenticate'));
  assert.doesNotMatch(switchBody, /session\.prompt|methods\.agent\.session\.prompt/);
  assert.match(agentRuntimeSource, /app\.post\('\/gemini\/sessions\/:id\/model'/);
});

test('Gemini model UI exposes default, current session, auto, and manual model choices', () => {
  assert.match(indexSource, /geminiFallbackModels/);
  assert.match(indexSource, /gemini-2\.5-pro/);
  assert.match(indexSource, /gemini-2\.5-flash/);
  assert.match(clientSource, /GeminiModelSummary/);
  assert.match(clientSource, /手动模型 ID/);
  assert.match(clientSource, /仅应用到当前会话/);
  assert.match(clientSource, /保存为默认并应用到当前会话/);
});
