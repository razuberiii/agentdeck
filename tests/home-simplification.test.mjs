import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');

test('home status strip keeps provider details off the first viewport', () => {
  const homeBlock = source.slice(
    source.indexOf('<header className="homeTop">'),
    source.indexOf('<section className="quickStart">')
  );
  assert.match(homeBlock, /homeServerLabel/);
  assert.match(homeBlock, /homeAgentLabel\(activeProvider, activeProviderStatus\)/);
  assert.match(homeBlock, /showSettings\('agent'\)/);
  assert.doesNotMatch(homeBlock, /providerSubtitle/);
  assert.doesNotMatch(homeBlock, /accountSummary/);
  assert.doesNotMatch(homeBlock, /activeStatusProfileLabel/);
});

test('home Agent label only exposes provider name plus short unavailable/login state', () => {
  const helperBlock = source.slice(
    source.indexOf('function homeAgentLabel'),
    source.indexOf('function accountSubtitle')
  );
  assert.match(helperBlock, /不可用/);
  assert.match(helperBlock, /需要登录/);
  assert.doesNotMatch(helperBlock, /version/);
  assert.doesNotMatch(helperBlock, /email/);
  assert.doesNotMatch(helperBlock, /authType/);
});
