import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clientSource = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const runtimeClientSource = readFileSync(new URL('../server/src/runtime-client.ts', import.meta.url), 'utf8');

test('Codex quota reads use the active profile identity and no shared cache', () => {
  const routeBlock = serverSource.slice(
    serverSource.indexOf("app.get('/api/quota'"),
    serverSource.indexOf("app.get('/api/settings'")
  );
  assert.match(routeBlock, /const activeProfile:any = await getActiveProfile/);
  assert.match(routeBlock, /runtime\.account\(accountId, codexHome\)/);
  assert.match(routeBlock, /runtime\.rateLimits\(accountId, codexHome\)/);
  assert.match(routeBlock, /cache:'none'/);
  assert.doesNotMatch(routeBlock, /quotaCache/);
  assert.match(runtimeClientSource, /codexAccountQuery\(accountId, codexHome\)/);
});

test('Codex quota logs only sanitized window metadata', () => {
  const helperBlock = serverSource.slice(
    serverSource.indexOf('function codexQuotaLogFields'),
    serverSource.indexOf('function providerDisplayName')
  );
  for (const field of ['planType', 'limitId', 'limitName', 'primaryUsedPercent', 'primaryWindowDurationMins', 'primaryResetsAt', 'secondaryPresent', 'secondaryUsedPercent', 'secondaryWindowDurationMins', 'secondaryResetsAt']) {
    assert.match(helperBlock, new RegExp(field));
  }
  assert.doesNotMatch(helperBlock, /email/);
  assert.doesNotMatch(helperBlock, /token/i);
});

test('Codex quota UI names windows dynamically and hides missing secondary limits', () => {
  const sheetBlock = clientSource.slice(
    clientSource.indexOf('function QuotaSheet'),
    clientSource.indexOf('function findDeepEmail')
  );
  const titleBlock = clientSource.slice(
    clientSource.indexOf('function quotaWindowTitle'),
    clientSource.indexOf('function usageSummary')
  );
  assert.match(sheetBlock, /quotaWindowTitle\(limit\.primary\)/);
  assert.match(sheetBlock, /limit\.secondary&&<QuotaBar/);
  assert.doesNotMatch(sheetBlock, /title="5 小时额度"/);
  assert.doesNotMatch(sheetBlock, /title="周额度"/);
  assert.match(titleBlock, /mins===300/);
  assert.match(titleBlock, /mins===10080/);
  assert.match(titleBlock, /mins===43200/);
  assert.match(titleBlock, /30 天额度/);
});
