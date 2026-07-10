import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');

test('home is task-first and keeps provider switching in the Agent dock', () => {
  const homeBlock = source.slice(
    source.indexOf('<header className="homeTop">'),
    source.indexOf('<section className="quickStart">')
  );
  assert.match(homeBlock, /homeServerLabel/);
  assert.match(homeBlock, /className="taskPrompt"/);
  assert.match(homeBlock, /今天想让 Agent/);
  assert.match(homeBlock, /<AgentDock/);
  assert.match(homeBlock, /onSwitch=\{switchProvider\}/);
  assert.match(homeBlock, /storageSet\(draftKey\(s\.id\),initialTask\.trim\(\)\)/);
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
