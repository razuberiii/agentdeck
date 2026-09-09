import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function load() {
  const source = await readFile(new URL('../client/src/mobile-workbench.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

test('login errors distinguish wrong password, wrong origin, throttling and network failure', async () => {
  const { loginErrorMessage } = await load();
  assert.match(loginErrorMessage({status:401}), /密码/);
  assert.match(loginErrorMessage({status:403,code:'origin'}), /地址/);
  assert.match(loginErrorMessage({status:429}), /稍后/);
  assert.match(loginErrorMessage(new TypeError('Failed to fetch')), /网络/);
  assert.doesNotMatch(loginErrorMessage({status:500,message:'private backend detail'}), /private/);
});

test('task buckets respect active turn state, including waiting and finishing', async () => {
  const { taskBucket } = await load();
  assert.equal(taskBucket({status:'idle',activeTurn:{status:'waiting_input'}}), 'waiting');
  assert.equal(taskBucket({status:'running',activeTurn:{status:'waiting_plan_approval'}}), 'waiting');
  assert.equal(taskBucket({status:'output_draining'}), 'running');
  assert.equal(taskBucket({status:'completed'}), 'other');
  assert.equal(taskBucket({status:'active'}), 'other');
});

test('search supports Chinese status labels and trimmed case-insensitive project names', async () => {
  const { matchesTask } = await load();
  const row={title:'修复登录',project_dir:'/opt/projects/AgentDeck',status:'idle',activeTurn:{status:'waiting_approval'}};
  assert.equal(matchesTask(row, '  agentdeck  ', '等待审批'),true);
  assert.equal(matchesTask(row, '等待审批', '等待审批'),true);
  assert.equal(matchesTask(row, '不存在', '等待审批'),false);
});

test('draft parsing preserves text/mode/workspace and rejects corrupt or unsupported records', async () => {
  const { parseLaunchDraft } = await load();
  const draft={version:1,text:'继续检查\n不要发出任务',mode:'plan',workspace:'/opt/projects/demo'};
  assert.deepEqual(parseLaunchDraft(JSON.stringify(draft)),draft);
  for(const raw of [null,'{oops','null','[]','{"version":2,"text":"old"}']) {
    assert.deepEqual(parseLaunchDraft(raw),{version:1,text:'',mode:'direct',workspace:''});
  }
  assert.equal(parseLaunchDraft('{"version":1,"text":42,"mode":"bad"}').text,'');
});

test('only the submitted draft is cleared, not a blank command-center session or newer edits', async () => {
  const { clearSubmittedDraft } = await load();
  const draft={version:1,text:'修复手机界面',mode:'plan',workspace:'/opt/projects/mobile'};
  assert.equal(clearSubmittedDraft(draft,''),draft);
  assert.equal(clearSubmittedDraft(draft,'之前的任务'),draft);
  assert.deepEqual(clearSubmittedDraft(draft,'修复手机界面'),{...draft,text:''});
});
