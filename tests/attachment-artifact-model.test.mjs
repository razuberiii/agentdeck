import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../server/src/agentdeck-runtime.ts', import.meta.url), 'utf8');
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
  assert.match(server, /ALTER TABLE artifacts ADD COLUMN operation TEXT NOT NULL DEFAULT 'created'/);
  assert.match(server, /recordArtifactBaseline/);
  assert.match(server, /scanArtifactsForTurn/);
  assert.match(server, /content_hash/);
  assert.match(server, /relative_path/);
  assert.match(server, /turn_id/);
  assert.match(server, /if \(!anchorItemId \|\| !turnId\) return \[\]/);
  assert.match(server, /const operation = !old \? 'created' : \(old\.size !== f\.size \|\| old\.contentHash !== f\.contentHash \? 'modified' : ''\)/);
  assert.match(server, /ON CONFLICT\(session_id, turn_id, relative_path, operation\) DO UPDATE/);
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
  assert.match(server, /modified \? '已修改文件' : '已生成文件'/);
  assert.match(client, /ArtifactGroup title="已生成文件"/);
  assert.match(client, /ArtifactGroup title="已修改文件"/);
  assert.match(client, /const parsedImages = artifacts\.length \? \[\] : extractMarkdownImages\(text\)/);
  assert.match(client, /const parsedFiles = artifacts\.length \? \[\] : extractFileLinks\(text\)/);
});

test('artifact ownership excludes internal files and does not scan with missing turn id', () => {
  assert.match(server, /const activeArtifactTurns = new Map<string, string>\(\)/);
  assert.match(server, /activeArtifactTurns\.set\(threadId, turnId\)/);
  assert.match(server, /scanArtifactsForTurn\(threadId, String\(row\.project_dir\), artifactTurnId, anchorItemId\)/);
  assert.doesNotMatch(server, /scanArtifactsForTurn\(threadId, String\(row\.project_dir\), null, anchorItemId\)/);
  assert.match(server, /function artifactPathIsInternal/);
  assert.match(server, /deploy-manifest\.json/);
  assert.match(server, /client\/public\/test-assets\/image-test\.png/);
});

test('session restore reconciles canonical user messages with attachments', () => {
  assert.match(server, /CREATE UNIQUE INDEX IF NOT EXISTS agent_messages_session_client_message/);
  assert.match(server, /ON CONFLICT\(session_id,client_message_id\) WHERE client_message_id IS NOT NULL DO UPDATE/);
  assert.match(server, /canonicalUserMessageItem/);
  assert.match(server, /ensureCanonicalUsersInThreadSnapshot/);
  assert.match(server, /findCanonicalUserForRuntimeEvent/);
  assert.match(server, /userMessageAttachmentsFromRow/);
  assert.match(server, /item\?\.type === 'userMessage' && canonicalUsers\.length\) continue/);
  assert.match(server, /await ensureCanonicalUsersInThreadSnapshot\(thread, threadId\)/);
  assert.match(client, /reconcileTimelineEvents/);
  assert.match(readFileSync(new URL('../client/src/timeline-reducer.ts', import.meta.url), 'utf8'), /userContentIdentityKey/);
  assert.match(readFileSync(new URL('../client/src/timeline-reducer.ts', import.meta.url), 'utf8'), /userLooseTextKey/);
  assert.match(client, /dedupeAttachments/);
});

test('runtime recovery context stays provider-only and out of visible history', () => {
  assert.match(runtime, /const RECOVERY_CONTEXT_MARKER = '\[\[AGENT_RUNTIME_RECOVERY_CONTEXT\]\]'/);
  assert.match(runtime, /const codexInput = live\.recovered \? \[await recoveryContextInput\(session\), \.\.\.input\] : input/);
  assert.match(runtime, /const retryInput = rebuilt\.recovered \? \[await recoveryContextInput\(session\), \.\.\.input\] : input/);
  assert.match(runtime, /await appendEvent\(session\.id, 'user', \{\s*input,/);
  assert.match(runtime, /isProviderOnlyRecoveryEvent/);
  assert.match(runtime, /provider-only recovery context event suppressed/);
  assert.match(runtime, /visibleInputText\(payload\.input \|\| \[\]\)/);

  const saveCanonicalStart = server.indexOf('async function saveCanonicalUserMessage');
  const saveCanonicalEnd = server.indexOf('async function findCanonicalUserForRuntimeEvent', saveCanonicalStart);
  const saveCanonical = server.slice(saveCanonicalStart, saveCanonicalEnd);
  assert.match(saveCanonical, /text=excluded\.text/);
  assert.match(saveCanonical, /attachments_json=excluded\.attachments_json/);
  assert.doesNotMatch(saveCanonical, /RECOVERY_CONTEXT_MARKER|AGENT_RUNTIME_RECOVERY_CONTEXT|provider/i);

  assert.match(server, /inputHasProviderOnlyRecovery\(payload\?\.input\)\) continue/);
  assert.match(server, /if \(inputHasProviderOnlyRecovery\(input\)\) return out/);
  assert.match(server, /itemHasProviderOnlyRecovery\(item\)/);
  assert.match(server, /stripProviderOnlyText\(stripInternalAttachmentPrompt/);
  assert.match(server, /sanitizeThreadForMobile/);

  assert.match(client, /const RECOVERY_CONTEXT_MARKER = '\[\[AGENT_RUNTIME_RECOVERY_CONTEXT\]\]'/);
  assert.match(client, /hasInternalProviderText/);
  assert.match(client, /if \(hasInternalProviderText\(value\)\) return ''/);
});
