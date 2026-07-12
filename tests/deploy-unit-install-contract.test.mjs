import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const ctl = readFileSync(new URL('../scripts/agentdeckctl', import.meta.url), 'utf8');
const installUnits = readFileSync(new URL('../deploy/install-units.sh', import.meta.url), 'utf8');
const repoRoot = new URL('..', import.meta.url).pathname;

function block(start, end) {
  const from = ctl.indexOf(start);
  assert.notEqual(from, -1, `${start} not found`);
  const to = ctl.indexOf(end, from);
  assert.notEqual(to, -1, `${end} not found after ${start}`);
  return ctl.slice(from, to);
}

test('agentdeckctl check validates units without invoking install-units', () => {
  const runCheck = block('run_check()', 'run_doctor()');
  assert.match(runCheck, /check_systemd_units "\$SOURCE_ROOT" fail/);
  assert.match(runCheck, /wait_http "http:\/\/127\.0\.0\.1:\$WEB_PORT\/api\/status"/);
  assert.match(runCheck, /wait_http "http:\/\/127\.0\.0\.1:\$RUNTIME_PORT\/healthz"/);
  assert.doesNotMatch(runCheck, /install-units\.sh|systemctl daemon-reload|\/etc\/systemd\/system|\/usr\/local\/bin\/agentdeckctl|chown|ensure_service_owned_dirs|ensure_playwright_browsers|npm run|npm test/);
});

test('agentdeckctl doctor is read-only and prints suggested fix commands', () => {
  assert.match(ctl, /doctor\) run_doctor/);
  const runDoctor = block('run_doctor()', 'render_unit_template()');
  assert.match(runDoctor, /run_check/);
  assert.match(runDoctor, /Suggested next steps:/);
  assert.match(runDoctor, /sudo agentdeckctl install-units/);
  assert.doesNotMatch(runDoctor, /systemctl restart|install-units\.sh|chown|useradd/);
});

test('agentdeckctl deploy all does not install systemd units during cutover', () => {
  const workerDeploy = block('worker_deploy()', 'worker_rollback()');
  assert.match(workerDeploy, /make_release/);
  assert.match(workerDeploy, /start_candidate_web/);
  assert.match(workerDeploy, /drain_runtime/);
  assert.match(workerDeploy, /switch_component runtime "\$release_id"/);
  assert.match(workerDeploy, /switch_component web "\$release_id"/);
  assert.match(workerDeploy, /systemctl restart agentdeck-runtime\.service/);
  assert.match(workerDeploy, /systemctl restart agentdeck-web\.service/);
  assert.match(workerDeploy, /check_systemd_units "\$release_path" warn \|\| true/);
  assert.doesNotMatch(workerDeploy, /install-units\.sh|systemctl daemon-reload|\/usr\/local\/bin\/agentdeckctl/);
});

test('only explicit install-units commands invoke the unit installer', () => {
  assert.match(ctl, /install-units\|setup-units\).*run_install_units/);
  const runInstall = block('run_install_units()', 'make_release()');
  assert.match(runInstall, /\$SOURCE_ROOT\/deploy\/install-units\.sh/);
  assert.match(runInstall, /Installing\/updating systemd units:/);
  assert.match(runInstall, /Resolved \$unit:/);
  assert.match(runInstall, /User\|Group\|WorkingDirectory/);
  assert.match(runInstall, /ENV_DIR=/);
});

test('waited runtime deploy refuses active turns instead of self-waiting', () => {
  const submitJob = block('submit_job()', 'wait_job()');
  assert.match(submitJob, /refusing --wait deploy to avoid self-wait/);
  assert.match(submitJob, /active_turn_count_from_json/);
  assert.match(submitJob, /Run without --wait/);
  assert.match(submitJob, /--force/);
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
  assert.match(installUnits, /install_if_changed 0755 "\$ROOT\/scripts\/agentdeckctl" "\$BIN_DIR\/agentdeckctl"/);
});

function runInstallUnits(env = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-units-'));
  const fakeBin = join(dir, 'bin');
  const systemdDir = join(dir, 'systemd');
  const envDir = join(dir, 'env');
  const dataDir = join(dir, 'data');
  const outBin = join(dir, 'usr-local-bin');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(systemdDir, { recursive: true });
  mkdirSync(envDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outBin, { recursive: true });
  for(const [name,value] of Object.entries(options.envFiles||{}))writeFileSync(join(envDir,name),value);
  writeFileSync(join(fakeBin, 'sudo'), `#!/usr/bin/env bash
if [ "$1" = "install" ] && [ "$2" = "-d" ] && [ "$5" = "/run/agentdeck" ]; then
  exit 0
fi
exec "$@"
`);
  writeFileSync(join(fakeBin, 'systemctl'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(join(fakeBin, 'getent'), `#!/usr/bin/env bash
if [ "$1" = "passwd" ]; then
  echo "$2:x:1000:1000::/home/$2:/bin/bash"
  exit 0
fi
if [ "$1" = "group" ]; then
  echo "$2:x:1000:"
  exit 0
fi
exit 2
`);
  chmodSync(join(fakeBin, 'sudo'), 0o755);
  chmodSync(join(fakeBin, 'systemctl'), 0o755);
  chmodSync(join(fakeBin, 'getent'), 0o755);
  execFileSync('bash', [join(repoRoot, 'deploy/install-units.sh'),...(options.args||[])], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      ROOT: repoRoot,
      LOG: join(dir, 'install.log'),
      AGENTDECK_SYSTEMD_DIR: systemdDir,
      AGENTDECK_BIN_DIR: outBin,
      AGENTDECK_ENV_DIR: envDir,
      AGENTDECK_DATA_DIR: dataDir,
      ...env,
    },
    stdio: 'pipe',
  });
  return { dir, systemdDir, envDir, dataDir, fakeBin, outBin };
}

test('existing readable env files do not require a writable /etc-style env directory',()=>{
  const rendered=runInstallUnits({}, {envFiles:{'web.env':'EXISTING=1\n','runtime.env':'EXISTING=1\n','agentdeck-app-server-default.env':'EXISTING=1\n'}});
  try{assert.equal(readFileSync(join(rendered.envDir,'runtime.env'),'utf8'),'EXISTING=1\n');}finally{rmSync(rendered.dir,{recursive:true,force:true});}
});

test('runtime drop-in installation is idempotent and reloads the effective contract',()=>{
  const rendered=runInstallUnits({}, {args:['--runtime-drop-in'],envFiles:{'runtime.env':'EXISTING=1\n'}});
  try{
    const dropin=readFileSync(join(rendered.systemdDir,'agentdeck-runtime.service.d/90-agentdeck-contract.conf'),'utf8');
    assert.match(dropin,/AGENTDECK_SYSTEMD_UNIT_VERSION=2/);assert.match(dropin,/TimeoutStopSec=660/);
    execFileSync('bash',[join(repoRoot,'deploy/install-units.sh'),'--runtime-drop-in'],{cwd:repoRoot,env:{...process.env,PATH:`${rendered.fakeBin}:${process.env.PATH}`,ROOT:repoRoot,LOG:join(rendered.dir,'install-2.log'),AGENTDECK_SYSTEMD_DIR:rendered.systemdDir,AGENTDECK_BIN_DIR:rendered.outBin,AGENTDECK_ENV_DIR:rendered.envDir,AGENTDECK_DATA_DIR:rendered.dataDir},stdio:'pipe'});
    assert.equal(readFileSync(join(rendered.systemdDir,'agentdeck-runtime.service.d/90-agentdeck-contract.conf'),'utf8'),dropin);
  }finally{rmSync(rendered.dir,{recursive:true,force:true});}
});

test('install-units renders default ubuntu user and paths into final units', () => {
  const rendered = runInstallUnits();
  try {
    const web = readFileSync(join(rendered.systemdDir, 'agentdeck-web.service'), 'utf8');
    const runtime = readFileSync(join(rendered.systemdDir, 'agentdeck-runtime.service'), 'utf8');
    const appServer = readFileSync(join(rendered.systemdDir, 'agentdeck-app-server@.service'), 'utf8');
    for (const unit of [web, runtime, appServer]) {
      assert.match(unit, /^User=ubuntu$/m);
      assert.match(unit, /^Group=ubuntu$/m);
      assert.match(unit, /^Environment=HOME=\/home\/ubuntu$/m);
      assert.match(unit, new RegExp(`^EnvironmentFile=${rendered.envDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'm'));
      assert.doesNotMatch(unit, /@AGENTDECK_/);
    }
    assert.match(web, /^WorkingDirectory=\/opt\/stacks\/agentdeck\/current-web$/m);
    assert.match(runtime, /^WorkingDirectory=\/opt\/stacks\/agentdeck\/current-runtime$/m);
    assert.match(runtime, /^Environment=DATA_DIR=.*\/data$/m);
    assert.match(runtime, /^Environment=CODEX_BIN=\/home\/ubuntu\/\.local\/bin\/codex$/m);
    assert.match(runtime, /^TimeoutStopSec=660$/m);
    assert.match(web, /^Environment=PATH=.*\/home\/ubuntu\/\.local\/bin:\/usr\/local\/bin/m);
    assert.match(appServer, /approval_policy=\\"never\\"/);
    assert.match(appServer, /sandbox_mode=\\"danger-full-access\\"/);
    assert.match(appServer, /^ExecStart=\/home\/ubuntu\/\.local\/bin\/codex app-server/m);
  } finally {
    rmSync(rendered.dir, { recursive: true, force: true });
  }
});

test('install-units renders custom run user group and home into final units', () => {
  const rendered = runInstallUnits({
    AGENTDECK_RUN_USER: 'agentdeck',
    AGENTDECK_RUN_GROUP: 'agentdeck',
    AGENTDECK_HOME: '/var/lib/agentdeck',
  });
  try {
    const web = readFileSync(join(rendered.systemdDir, 'agentdeck-web.service'), 'utf8');
    const runtime = readFileSync(join(rendered.systemdDir, 'agentdeck-runtime.service'), 'utf8');
    const appServer = readFileSync(join(rendered.systemdDir, 'agentdeck-app-server@.service'), 'utf8');
    for (const unit of [web, runtime, appServer]) {
      assert.match(unit, /^User=agentdeck$/m);
      assert.match(unit, /^Group=agentdeck$/m);
      assert.match(unit, /^Environment=HOME=\/var\/lib\/agentdeck$/m);
      assert.doesNotMatch(unit, /\/home\/ubuntu/);
      assert.doesNotMatch(unit, /@AGENTDECK_/);
    }
    assert.match(web, /\/var\/lib\/agentdeck\/\.local\/bin/);
    assert.match(appServer, /^ExecStart=\/var\/lib\/agentdeck\/\.local\/bin\/codex app-server/m);
  } finally {
    rmSync(rendered.dir, { recursive: true, force: true });
  }
});

test('install-units standard profile renders dedicated user and conservative Codex policy', () => {
  const rendered = runInstallUnits({
    AGENTDECK_INSTALL_PROFILE: 'standard',
  });
  try {
    const web = readFileSync(join(rendered.systemdDir, 'agentdeck-web.service'), 'utf8');
    const appServer = readFileSync(join(rendered.systemdDir, 'agentdeck-app-server@.service'), 'utf8');
    assert.match(web, /^User=agentdeck$/m);
    assert.match(web, /^Group=agentdeck$/m);
    assert.match(web, /^Environment=HOME=\/var\/lib\/agentdeck$/m);
    assert.match(appServer, /approval_policy=\\"on-request\\"/);
    assert.match(appServer, /sandbox_mode=\\"workspace-write\\"/);
    assert.doesNotMatch(appServer, /danger-full-access/);
    for (const name of ['web.env', 'runtime.env', 'agentdeck-app-server-default.env']) {
      const envFile = readFileSync(join(rendered.envDir, name), 'utf8');
      assert.doesNotMatch(envFile, /(?:^|\/)ubuntu(?:\/|$)|\/home\/ubuntu/m);
      assert.match(envFile, new RegExp(rendered.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  } finally {
    rmSync(rendered.dir, { recursive: true, force: true });
  }
});

test('install-units hardened profile renders read-only Codex policy', () => {
  const rendered = runInstallUnits({
    AGENTDECK_INSTALL_PROFILE: 'hardened',
  });
  try {
    const appServer = readFileSync(join(rendered.systemdDir, 'agentdeck-app-server@.service'), 'utf8');
    assert.match(appServer, /approval_policy=\\"on-request\\"/);
    assert.match(appServer, /sandbox_mode=\\"read-only\\"/);
  } finally {
    rmSync(rendered.dir, { recursive: true, force: true });
  }
});

test('setup supports install profiles without adding extra interactive questions', () => {
  const setup = readFileSync(new URL('../scripts/setup.sh', import.meta.url), 'utf8');
  assert.match(setup, /AGENTDECK_INSTALL_PROFILE/);
  assert.match(setup, /Choose AgentDeck install profile \[standard\/personal\]/);
  assert.match(setup, /detect_existing_personal_unit/);
  assert.match(setup, /useradd --system --create-home --home-dir "\$RUN_HOME"/);
  assert.doesNotMatch(setup, /approval_policy.*read -r|sandbox.*read -r|sudoers.*read -r/);
});
