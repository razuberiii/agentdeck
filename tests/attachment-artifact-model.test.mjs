import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const client = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');

test('canonical user messages do not persist provider attachment prompts', () => {
  assert.match(server, /function saveCanonicalUserMessage/);
  assert.match(server, /original_text/);
  assert.match(server, /attachments_json/);
  assert.doesNotMatch(server, /INSERT INTO agent_messages[\s\S]{0,180}\bprompt\b/);
  assert.match(server, /providerInputText/);
  assert.doesNotMatch(server, /function attachmentPromptText/);
});

test('legacy internal attachment prompts are hidden from snapshots and UI', () => {
  assert.match(server, /stripInternalAttachmentPrompt/);
  assert.match(server, /Local path:/);
  assert.match(client, /stripInternalAttachmentPrompt/);
  assert.match(client, /Read this file from the local path if needed/);
});

test('artifacts are registered from persisted turn baselines', () => {
  assert.match(server, /CREATE TABLE IF NOT EXISTS artifact_baselines/);
  assert.match(server, /recordArtifactBaseline/);
  assert.match(server, /scanArtifactsForTurn/);
  assert.match(server, /content_hash/);
  assert.match(server, /relative_path/);
  assert.match(server, /turn_id/);
  assert.doesNotMatch(server, /artifactScanStarts/);
});

test('session snapshots only inject persisted artifacts and keep anchors stable', () => {
  const routeStart = server.indexOf("app.get('/api/sessions/:id'");
  const routeEnd = server.indexOf("app.patch('/api/sessions/:id'", routeStart);
  const route = server.slice(routeStart, routeEnd);
  assert.doesNotMatch(route, /scanArtifactsForTurn/);
  assert.doesNotMatch(route, /injectGeneratedImages/);
  assert.match(server, /turnIndexForAnchor\(thread\.turns, group\[0\]\?\.anchor_item_id\)/);
  assert.doesNotMatch(server, /turnIndexMentioningArtifacts\(thread\.turns, group\)/);
});

test('artifact cards are not duplicated by markdown link parsing', () => {
  assert.match(server, /text:'已生成文件'/);
  assert.match(client, /const parsedImages = artifacts\.length \? \[\] : extractMarkdownImages\(text\)/);
  assert.match(client, /const parsedFiles = artifacts\.length \? \[\] : extractFileLinks\(text\)/);
});
