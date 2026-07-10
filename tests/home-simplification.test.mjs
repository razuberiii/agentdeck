import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8');

test('home is task-first and keeps provider switching in the Agent dock', () => {
  const homeBlock = source.slice(
    source.indexOf('<header className="homeTop">'),
    source.indexOf('function SessionRow')
  );
  assert.match(homeBlock, /homeServerLabel/);
  assert.match(homeBlock, /taskPrompt/);
  assert.match(homeBlock, /<RotatingHeadline/);
  assert.match(homeBlock, /<WorkPulse/);
  assert.doesNotMatch(homeBlock, /MissionControl|OutputShelf|最近产物|最近 7 天/);
  assert.match(homeBlock, /<AgentDock/);
  assert.match(homeBlock, /onSwitch=\{switchProvider\}/);
  assert.match(homeBlock, /const selectedWorkspace = workspaceOverride \|\| defaultWorkspace/);
  assert.match(homeBlock, /setWorkspaceOverride\(p\.path\)/);
  assert.match(homeBlock, /pickerProjects:Project\[\]/);
  assert.match(homeBlock, /disabled=\{!!busy\}/);
  assert.match(homeBlock, /busy\?'创建中':'开工'/);
  assert.doesNotMatch(homeBlock, /onPick=\{\(p\)=>newSession\(p\.path/);
  assert.match(homeBlock, /aria-label="额度与用量"[^>]+onClick=\{showQuota\}/);
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

test('work pulse only appears for active work and does not duplicate recent sessions', () => {
  const block=source.slice(source.indexOf('function WorkPulse'),source.indexOf('function AgentDock'));
  assert.match(block,/if\(!items\.length\) return null/);
  assert.doesNotMatch(block,/刚刚完成或更新/);
  assert.doesNotMatch(block,/const recent=/);
  assert.doesNotMatch(block,/\['running','active','waiting'\]/);
  assert.match(block,/JUST FINISHED/);
  assert.match(block,/10\*60_000/);
  assert.match(block,/doneDot/);
});

test('editorial headline is randomized once per page visit instead of rotating', () => {
  const block=source.slice(source.indexOf('function RotatingHeadline'),source.indexOf('function App'));
  assert.match(block,/Math\.random\(\)/);
  assert.doesNotMatch(block,/setInterval/);
});

test('launch and conversation send actions share one signal-control language', () => {
  assert.match(styles,/\.launchButton,\.composer \.sendBtn\{/);
  assert.match(styles,/\.launchButton:before,\.composer \.sendBtn:before/);
  assert.match(styles,/background:var\(--signal\)!important/);
});

test('image viewer uses the editorial command bar instead of legacy rounded controls', () => {
  assert.match(styles,/\.viewer header button,\.viewer header a\{/);
  assert.match(styles,/border-radius:0!important/);
  assert.match(styles,/\.viewer header a:before/);
});

test('settings choices, account actions, and message copy use the shared command language', () => {
  assert.match(source,/className="settingsSheet"/);
  assert.match(styles,/\.settingsSheet \.providerChoices button/);
  assert.match(styles,/\.settingsSheet \.modeButtons button/);
  assert.match(styles,/\.settingsSheet \.profileRow \.dangerText/);
  assert.match(styles,/\.chatShell \.bubble \.copyBtn/);
});
