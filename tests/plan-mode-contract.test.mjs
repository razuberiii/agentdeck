import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const web = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../server/src/agentdeck-runtime.ts', import.meta.url), 'utf8');
const db = readFileSync(new URL('../server/src/db.ts', import.meta.url), 'utf8');
const client = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8');

test('plan mode sends a provider-agnostic plan-only prompt and stores review requests', () => {
  assert.match(web, /function planOnlyPrompt/);
  assert.match(web, /\$plan/);
  assert.match(web, /不要修改文件，不要执行会改变工作区的命令/);
  assert.match(web, /CREATE TABLE IF NOT EXISTS interactive_requests/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS interactive_requests/);
  assert.match(web, /createPlanReviewRequest/);
  assert.match(web, /kind='plan_review'/);
  assert.match(web, /waiting_plan_approval/);
});

test('interactive request answer API supports approve revise regenerate and cancel', () => {
  assert.match(web, /app\.post\('\/api\/interactive-requests\/:requestId\/answer'/);
  assert.match(web, /planApprovalPrompt/);
  assert.match(web, /planRevisionPrompt/);
  assert.match(web, /planRegeneratePrompt/);
  assert.match(web, /optionId === 'cancel'/);
  assert.match(web, /sendTurn\(request\.sessionId, followup, \[\]/);
});

test('plan review survives refresh and runtime drain treats it as active', () => {
  assert.match(web, /interactiveRequests: await listInteractiveRequests/);
  assert.match(web, /webPlanStatus/);
  assert.match(runtime, /waiting_plan_approval/);
  assert.match(runtime, /executing_approved_plan/);
});

test('mobile UI exposes direct and plan modes with a non-overflowing plan card', () => {
  assert.match(client, /sendMode/);
  assert.match(client, /先给计划/);
  assert.match(client, /PlanCard/);
  assert.match(client, /批准并执行/);
  assert.match(client, /修改后执行/);
  assert.match(client, /重新生成/);
  assert.match(client, /取消/);
  assert.match(styles, /\.sendMode/);
  assert.match(styles, /\.planActions\{[^}]*flex-wrap:wrap/);
  assert.match(styles, /@media\(max-width:380px\).*\.planActions button\{flex-basis:100%\}/);
});
