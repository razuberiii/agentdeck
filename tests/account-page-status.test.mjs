import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');

test('account page starts with current active account summary', () => {
  const accountBlock = source.slice(
    source.indexOf("{page==='account'&&activeProvider==='codex'"),
    source.indexOf("{deleteProfile&&")
  );
  assert.match(accountBlock, /<CurrentAccountSummary provider="codex"/);
  assert.match(accountBlock, /<CurrentAccountSummary provider="gemini"/);
  assert.match(accountBlock, /<CurrentAccountSummary provider="antigravity"/);
  assert.match(accountBlock, /<section><b>登录中的任务<\/b>/);
  assert.doesNotMatch(accountBlock, /登录中的账户/);
});

test('current account summary is not polluted by login attempts', () => {
  const helperBlock = source.slice(
    source.indexOf('function currentAccountSummary'),
    source.indexOf('function pendingLoginTitle')
  );
  assert.match(helperBlock, /正在读取账户信息/);
  assert.match(helperBlock, /账户信息读取失败，可重试/);
  assert.match(helperBlock, /已登录/);
  assert.match(helperBlock, /尚未登录/);
  assert.doesNotMatch(helperBlock, /正在登录/);
  assert.doesNotMatch(helperBlock, /authenticating/);
});

test('login attempts are labelled as tasks and completed Codex jobs disappear', () => {
  const pendingBlock = source.slice(
    source.indexOf('function pendingLoginTitle'),
    source.indexOf('function authTypeLabel')
  );
  assert.match(pendingBlock, /等待完成/);
  assert.match(pendingBlock, /授权/);
  assert.doesNotMatch(pendingBlock, /账户/);
  assert.match(source, /if\(r\.job\.status==='done'\) setLoginJob\(null\)/);
  assert.match(source, /loginJob&&loginJob\.status!=='done'&&<LoginJobPanel/);
});
