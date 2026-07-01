import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runtimeSource = readFileSync(new URL('../server/src/agentdeck-runtime.ts', import.meta.url), 'utf8');
const appServerUnit = readFileSync(new URL('../deploy/systemd/agentdeck-app-server@.service', import.meta.url), 'utf8');
const runtimeUnit = readFileSync(new URL('../deploy/systemd/agentdeck-runtime.service', import.meta.url), 'utf8');
const installUnits = readFileSync(new URL('../deploy/install-units.sh', import.meta.url), 'utf8');

test('Codex app-server runtime defaults to the existing ubuntu service user', () => {
  assert.match(runtimeSource, /const APP_SERVER_USER = process\.env\.CODEX_APP_SERVER_USER \|\| 'ubuntu'/);
  assert.doesNotMatch(runtimeSource, /CODEX_APP_SERVER_USER \|\| 'agentdeck'/);
  assert.match(runtimeSource, /'--uid', APP_SERVER_USER/);
  assert.match(runtimeSource, /'--gid', APP_SERVER_GROUP/);
});

test('Codex app-server start failures expose the required structured invalid-user error', () => {
  assert.match(runtimeSource, /code:'codex_app_server_invalid_run_user'/);
  assert.match(runtimeSource, /layer:'codex_app_server_manager'/);
  assert.match(runtimeSource, /message:'Codex 后台服务运行用户配置无效'/);
  assert.match(runtimeSource, /safeDetail:'配置的服务运行用户不存在或无法解析'/);
  assert.match(runtimeSource, /217\\\/USER\|Failed to determine user credentials/);
});

test('systemd restart policy is bounded for runtime and app-server units', () => {
  for (const unit of [appServerUnit, runtimeUnit]) {
    assert.match(unit, /^User=ubuntu$/m);
    assert.match(unit, /^Group=ubuntu$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, /^RestartSec=5$/m);
    assert.match(unit, /^StartLimitIntervalSec=60$/m);
    assert.match(unit, /^StartLimitBurst=3$/m);
    assert.doesNotMatch(unit, /^Restart=always$/m);
    assert.doesNotMatch(unit, /^User=agentdeck$/m);
  }
});

test('install-units validates configured service user and group before installing units', () => {
  assert.match(installUnits, /RUN_USER=\$\{AGENTDECK_RUN_USER:-ubuntu\}/);
  assert.match(installUnits, /getent passwd "\$RUN_USER"/);
  assert.match(installUnits, /getent group "\$RUN_GROUP"/);
});
