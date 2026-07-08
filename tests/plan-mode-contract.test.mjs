import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const web = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../server/src/agentdeck-runtime.ts', import.meta.url), 'utf8');
const db = readFileSync(new URL('../server/src/db.ts', import.meta.url), 'utf8');
const client = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8');

test('plan mode sends a provider-agnostic plan-only prompt without storing it as user text', () => {
  assert.match(web, /function planOnlyPrompt/);
  assert.match(web, /\$plan/);
  assert.match(web, /AgentDeck Plan Mode is active/);
  assert.match(web, /CREATE TABLE IF NOT EXISTS plan_tasks/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS plan_tasks/);
  assert.match(web, /parsePlanSubmission/);
  assert.match(web, /saveCanonicalUserMessage\(threadId, originalText/);
  assert.match(web, /stripInternalPlanPrompt/);
});

test('legacy plan review answer API no longer copies assistant plans into follow-up prompts', () => {
  assert.match(web, /app\.post\('\/api\/interactive-requests\/:requestId\/answer'/);
  assert.match(web, /optionId === 'cancel'/);
  assert.doesNotMatch(web, /planApprovalPrompt/);
  assert.doesNotMatch(web, /planRevisionPrompt/);
  assert.doesNotMatch(web, /planRegeneratePrompt/);
  assert.doesNotMatch(web, /sendTurn\(request\.sessionId, followup, \[\]/);
});

test('plan mode is forced through read-only runtime policy', () => {
  assert.match(web, /interactiveRequests: await listInteractiveRequests/);
  assert.match(web, /approvalPolicy:planTurnOptions\?\.approvalPolicy/);
  assert.match(web, /sandboxMode:planTurnOptions\?\.sandboxMode/);
  assert.match(runtime, /String\(body\.planMode \|\| ''\) === 'plan'/);
  assert.match(runtime, /sandboxMode:'read-only'/);
});

test('mobile UI keeps plan mode out of the composer and removes old primary plan buttons', () => {
  assert.match(client, /sendMode/);
  assert.match(client, /计划模式：描述任务，只生成计划/);
  assert.match(client, /普通模式/);
  assert.match(client, /发送模式/);
  assert.doesNotMatch(client, /先给计划/);
  assert.doesNotMatch(client, /直接执行/);
  assert.doesNotMatch(client, /PlanCard/);
  assert.doesNotMatch(client, /计划确认/);
  assert.doesNotMatch(styles, /\.modeToggle/);
});
