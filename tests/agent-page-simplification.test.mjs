import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8');

test('Agent selection page renders only provider name and short status', () => {
  const agentBlock = source.slice(
    source.indexOf("{page==='agent'&&"),
    source.indexOf("{page==='mode'&&")
  );
  assert.match(agentBlock, /providerChoiceStatus\(codexProviderStatus\)/);
  assert.match(agentBlock, /providerChoiceStatus\(geminiProviderStatus\)/);
  assert.match(agentBlock, /providerChoiceStatus\(antigravityProviderStatus\)/);
  assert.doesNotMatch(agentBlock, /providerSubtitle/);
  assert.doesNotMatch(agentBlock, /providerNotice/);
  assert.doesNotMatch(agentBlock, /accountSummary/);
  assert.doesNotMatch(agentBlock, /version/);
  assert.doesNotMatch(agentBlock, /email/);
});

test('Agent selection status helper only returns the allowed short labels', () => {
  const helperBlock = source.slice(
    source.indexOf('function providerChoiceStatus'),
    source.indexOf('function providerSubtitle')
  );
  for (const label of ['不可用', '已登录', '未登录', '正在登录', '状态未知']) {
    assert.match(helperBlock, new RegExp(label));
  }
  assert.doesNotMatch(helperBlock, /服务不可用/);
  assert.doesNotMatch(helperBlock, /状态异常/);
  assert.doesNotMatch(helperBlock, /version/);
  assert.doesNotMatch(helperBlock, /email/);
});

test('Agent sheet controls avoid horizontal overflow and per-character wrapping', () => {
  assert.match(styles, /\.sheetActions button\{[^}]*white-space:nowrap/);
  assert.match(styles, /\.sheet\{[^}]*width:min\(100dvw,640px\)/);
  assert.match(styles, /\.providerChoices button\{[^}]*min-width:0/);
  assert.match(styles, /\.providerChoices small\{[^}]*white-space:nowrap/);
});
