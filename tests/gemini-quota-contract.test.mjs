import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const serverSource = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');

test('Gemini quota route reports unsupported through unified ProviderStatus', () => {
  const routeBlock = serverSource.slice(
    serverSource.indexOf("app.get('/api/quota'"),
    serverSource.indexOf("if (provider === 'antigravity')")
  );
  assert.match(routeBlock, /providerStatus: geminiProviderStatus/);
  assert.match(routeBlock, /supported: false/);
  assert.match(routeBlock, /Gemini ACP 暂未提供稳定的独立实时剩余额度查询。/);
  assert.doesNotMatch(routeBlock, /prompt/);
  assert.doesNotMatch(routeBlock, /\/stats/);
  assert.doesNotMatch(routeBlock, /当前 Profile 尚未登录/);
});

test('quota sheet reads Gemini account identity from ProviderStatus first', () => {
  const sheetBlock = clientSource.slice(
    clientSource.indexOf('function QuotaSheet'),
    clientSource.indexOf('function findDeepEmail')
  );
  assert.match(sheetBlock, /providerStatus\?\.accountSummary/);
  assert.match(sheetBlock, /providerStatus\?\.account/);
  assert.match(sheetBlock, /quota\?\.message/);
  assert.doesNotMatch(sheetBlock, /当前 Profile 尚未登录/);
});
