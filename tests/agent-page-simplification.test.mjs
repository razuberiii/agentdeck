import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8');

test('Agent selection page renders provider name with account-aware status', () => {
  const agentBlock = source.slice(
    source.indexOf("{page==='agent'&&"),
    source.indexOf("{page==='mode'&&")
  );
  assert.match(source, /const PROVIDER_ORDER:ProviderId\[\]\s*=\s*\['codex','claude','antigravity','gemini'\]/);
  assert.match(agentBlock, /PROVIDER_ORDER\.map/);
  assert.match(agentBlock, /providerStatusById\[provider\]/);
  assert.match(agentBlock, /providerChoiceDetail\(providerStatusById\[provider\]\)/);
  assert.match(agentBlock, /providerChoiceNote\(providerStatusById\[provider\]\)/);
  assert.doesNotMatch(agentBlock, /providerSubtitle/);
  assert.doesNotMatch(agentBlock, /providerNotice/);
  assert.doesNotMatch(agentBlock, /version/);
});

test('Agent selection status helper displays account identity without CLI versions', () => {
  const helperBlock = source.slice(
    source.indexOf('function providerChoiceDetail'),
    source.indexOf('function providerSubtitle')
  );
  for (const label of ['不可用', '已登录', '未登录', '正在登录', '状态未知', '个人版客户端已停止支持']) {
    assert.match(helperBlock, new RegExp(label));
  }
  assert.match(helperBlock, /accountSummary\?\.email/);
  assert.doesNotMatch(helperBlock, /version/);
});

test('Gemini personal unsupported disables executable session model actions', () => {
  assert.match(source, /reasonCode==='gemini_client_unsupported'/);
  assert.match(source, /个人版客户端已停止支持/);
  assert.match(source, /disabled=\{!currentSessionId \|\| activeProviderStatus\?\.reasonCode==='gemini_client_unsupported'\}/);
  assert.match(source, /disabled=\{activeProviderStatus\?\.reasonCode==='gemini_client_unsupported'\}/);
});

test('Settings secondary pages have back navigation and duplicate diagnostics is removed', () => {
  const sheetBlock = source.slice(
    source.indexOf('function SettingsSheet'),
    source.indexOf('function mergeSettingsData')
  );
  assert.match(sheetBlock, /actions=\{page!=='main'\?<button className="settingsBack" onClick=\{goBack\}>返回<\/button>:undefined\}/);
  const mainBlock = sheetBlock.slice(sheetBlock.indexOf("{page==='main'&&"), sheetBlock.indexOf("{page==='agent'&&"));
  assert.doesNotMatch(mainBlock, /diagnostics/);
  assert.match(source, /aria-label="诊断"/);
});

test('Agent sheet controls avoid horizontal overflow and per-character wrapping', () => {
  assert.match(styles, /\.sheetActions button\{[^}]*white-space:nowrap/);
  assert.match(styles, /\.sheet\{[^}]*width:min\(100dvw,640px\)/);
  assert.match(styles, /\.providerChoices button\{[^}]*min-width:0/);
  assert.match(styles, /\.providerChoices small\{[^}]*white-space:nowrap/);
});
