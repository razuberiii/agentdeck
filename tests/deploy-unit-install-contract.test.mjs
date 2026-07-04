import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ctl = readFileSync(new URL('../scripts/agentdeckctl', import.meta.url), 'utf8');
const installUnits = readFileSync(new URL('../deploy/install-units.sh', import.meta.url), 'utf8');

function block(start, end) {
  const from = ctl.indexOf(start);
  assert.notEqual(from, -1, `${start} not found`);
  const to = ctl.indexOf(end, from);
  assert.notEqual(to, -1, `${end} not found after ${start}`);
  return ctl.slice(from, to);
}

test('agentdeckctl check validates units without invoking install-units', () => {
  const runCheck = block('run_check()', 'render_unit_template()');
  assert.match(runCheck, /check_systemd_units "\$SOURCE_ROOT" fail/);
  assert.match(runCheck, /wait_http "http:\/\/127\.0\.0\.1:\$WEB_PORT\/api\/status"/);
  assert.match(runCheck, /wait_http "http:\/\/127\.0\.0\.1:\$RUNTIME_PORT\/healthz"/);
  assert.doesNotMatch(runCheck, /install-units\.sh|systemctl daemon-reload|\/etc\/systemd\/system|\/usr\/local\/bin\/agentdeckctl/);
});

test('agentdeckctl deploy all does not install systemd units during cutover', () => {
  const workerDeploy = block('worker_deploy()', 'worker_rollback()');
  assert.match(workerDeploy, /make_release/);
  assert.match(workerDeploy, /start_candidate_web/);
  assert.match(workerDeploy, /drain_runtime/);
  assert.match(workerDeploy, /switch_current "\$release_id"/);
  assert.match(workerDeploy, /systemctl restart agentdeck-runtime\.service/);
  assert.match(workerDeploy, /systemctl restart agentdeck-web\.service/);
  assert.match(workerDeploy, /check_systemd_units "\$release_path" warn \|\| true/);
  assert.doesNotMatch(workerDeploy, /install-units\.sh|systemctl daemon-reload|\/usr\/local\/bin\/agentdeckctl/);
});

test('only explicit install-units commands invoke the unit installer', () => {
  assert.match(ctl, /install-units\|setup-units\) run_install_units/);
  const runInstall = block('run_install_units()', 'make_release()');
  assert.match(runInstall, /\$SOURCE_ROOT\/deploy\/install-units\.sh/);
});

test('unit drift is reported without blocking normal deploy unless a manifest requires newer units', () => {
  assert.match(ctl, /systemd units are outdated\. Run:/);
  assert.match(ctl, /sudo agentdeckctl install-units/);
  assert.match(ctl, /assert_release_unit_requirement "\$release_path"/);
  assert.match(ctl, /requiredSystemdUnitVersion/);
});

test('install-units writes only changed files and reloads systemd only for unit changes', () => {
  assert.match(installUnits, /install_if_changed\(\)/);
  assert.match(installUnits, /cmp -s "\$source" "\$target"/);
  assert.match(installUnits, /unchanged \$target/);
  assert.match(installUnits, /if \[ "\$changed" = "1" \]; then\s+sudo systemctl daemon-reload/s);
  assert.match(installUnits, /install_if_changed 0755 "\$ROOT\/scripts\/agentdeckctl" \/usr\/local\/bin\/agentdeckctl/);
});
