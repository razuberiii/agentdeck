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
  assert.match(web, /Inspect the repository and reason about the task/);
  assert.match(web, /CREATE TABLE IF NOT EXISTS plan_tasks/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS plan_tasks/);
  assert.match(web, /parsePlanSubmission/);
  assert.match(web, /saveCanonicalUserMessage\(threadId, originalText/);
  assert.match(web, /stripInternalPlanPrompt/);
  assert.doesNotMatch(web, /Output a complete implementation plan with these sections/);
});

test('plan review answer API drives approve, revise, regenerate, and cancel follow-ups', () => {
  assert.match(web, /app\.post\('\/api\/interactive-requests\/:requestId\/answer'/);
  assert.match(web, /optionId === 'cancel'/);
  assert.match(web, /approvedPlanPrompt/);
  assert.match(web, /revisePlanPrompt/);
  assert.match(web, /regeneratePlanPrompt/);
  assert.match(web, /sendTurn\(request\.sessionId, followup, \[\], crypto\.randomUUID\(\), 'direct'\)/);
  assert.match(web, /sendTurn\(request\.sessionId, revision, \[\], crypto\.randomUUID\(\), 'plan'\)/);
  assert.match(web, /createPlanReviewRequest/);
  assert.match(web, /waiting_plan_approval/);
});

test('plan mode is forced through read-only runtime policy', () => {
  assert.match(web, /interactiveRequests: await listInteractiveRequests/);
  assert.match(web, /approvalPolicy:planTurnOptions\?\.approvalPolicy/);
  assert.match(web, /sandboxMode:planTurnOptions\?\.sandboxMode/);
  assert.match(runtime, /String\(body\.planMode \|\| ''\) === 'plan'/);
  assert.match(runtime, /sandboxMode:'read-only'/);
});

test('mobile UI exposes plan mode and a lightweight plan review card', () => {
  assert.match(client, /sendMode/);
  assert.match(client, /计划模式：描述任务，只生成计划/);
  assert.match(client, /普通模式/);
  assert.match(client, /发送模式/);
  assert.match(client, /PlanReviewCard/);
  assert.match(client, /计划已生成，等待确认/);
  assert.match(client, /answerPlan/);
  assert.doesNotMatch(client, /先给计划/);
  assert.doesNotMatch(client, /直接执行/);
  assert.match(styles, /\.planReviewCard/);
  assert.doesNotMatch(styles, /\.modeToggle/);
});
