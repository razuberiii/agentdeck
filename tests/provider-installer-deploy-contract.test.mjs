import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexSource = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
const providersSource = readFileSync(new URL('../server/src/providers.ts', import.meta.url), 'utf8');
const claudeAuthSource = readFileSync(new URL('../server/src/claude/claude-auth.ts', import.meta.url), 'utf8');
const ctlSource = readFileSync(new URL('../scripts/agentdeckctl', import.meta.url), 'utf8');
const runtimeUnit = readFileSync(new URL('../deploy/systemd/agentdeck-runtime.service', import.meta.url), 'utf8');
const webUnit = readFileSync(new URL('../deploy/systemd/agentdeck-web.service', import.meta.url), 'utf8');

test('provider installer is server-side allowlisted and does not accept browser commands', () => {
  assert.match(indexSource, /const PROVIDER_INSTALLERS:Record<AgentProviderId/);
  assert.match(indexSource, /codex:[\s\S]*packageName:'@openai\/codex'/);
  assert.match(indexSource, /claude:[\s\S]*installScriptUrl:'https:\/\/claude\.ai\/install\.sh'/);
  assert.match(indexSource, /antigravity:[\s\S]*automatic:false/);
  assert.match(indexSource, /gemini:[\s\S]*automatic:false/);
  assert.match(indexSource, /app\.post\('\/api\/providers\/:provider\/install'/);
  assert.match(indexSource, /const action = String\(req\.body\?\.action \|\| 'install'\)/);
  assert.doesNotMatch(indexSource, /req\.body\?\.command|req\.body\?\.url|req\.body\?\.packageName|req\.body\?\.path/);
  assert.match(indexSource, /if \(!\['install','retry'\]\.includes\(action\)\)/);
  assert.match(indexSource, /downloadProviderInstallScript\(job, String\(installer\.installScriptUrl\), scriptPath\)/);
  assert.match(indexSource, /parsed\.protocol !== 'https:' \|\| parsed\.hostname !== 'claude\.ai' \|\| parsed\.pathname !== '\/install\.sh'/);
  assert.doesNotMatch(indexSource, /sudo npm install -g/);
});

test('provider tools install into DATA_DIR and managed bin participates in detection', () => {
  assert.match(indexSource, /const PROVIDER_TOOLS_DIR = path\.join\(DATA_DIR, 'provider-tools'\)/);
  assert.match(indexSource, /const MANAGED_PROVIDER_BIN_DIR = path\.join\(PROVIDER_TOOLS_DIR, 'bin'\)/);
  assert.match(indexSource, /await symlink\(managedBinaryPath, binLink\)/);
  assert.match(indexSource, /const PROVIDER_INSTALL_JOBS_FILE = path\.join\(PROVIDER_TOOLS_DIR, 'jobs', 'install-jobs\.json'\)/);
  assert.match(indexSource, /detectManagedCommand\(process\.env\.CODEX_BIN \|\| '', 'codex'\)/);
  assert.match(providersSource, /managedProviderBinary\('gemini'\)/);
  assert.match(providersSource, /detectProviderCommand\(this\.command, 'agy'\)/);
  assert.match(claudeAuthSource, /provider-tools\/bin\/claude/);
});

test('provider settings page exposes install, manual method, cancel, and logs', () => {
  assert.match(clientSource, /function ProviderInstallPanel/);
  assert.match(clientSource, /api\(`\/api\/providers\/\$\{provider\}\/install`/);
  assert.match(clientSource, /api\('\/api\/provider-install\/'\+job\.id,\{method:'DELETE'\}/);
  assert.match(clientSource, /手动安装方法/);
  assert.match(clientSource, /查看日志/);
  assert.match(clientSource, /正在安装 \{providerLabel\(provider\)\}/);
});

test('deploy worker uses service user for build checks and candidate processes', () => {
  assert.match(ctlSource, /resolve_service_user\(\)/);
  assert.match(ctlSource, /run_as_service_user\(\)/);
  assert.match(ctlSource, /PLAYWRIGHT_BROWSERS_PATH="\$\{PLAYWRIGHT_BROWSERS_PATH:-\$DATA_DIR\/cache\/ms-playwright\}"/);
  assert.match(ctlSource, /ensure_playwright_browsers\(\)/);
  assert.match(ctlSource, /run_as_service_user npm ci/);
  assert.match(ctlSource, /run_as_service_user npm run typecheck/);
  assert.match(ctlSource, /run_as_service_user npm run lint/);
  assert.match(ctlSource, /run_as_service_user npm run build/);
  assert.match(ctlSource, /run_as_service_user npm test/);
  assert.match(ctlSource, /run_as_service_user npm run test:e2e/);
  assert.match(ctlSource, /run_as_service_user bash -c 'cd "\$1"; RUNTIME_MODE=candidate/);
  assert.match(ctlSource, /run_as_service_user bash -c 'set -a; \[ -f "\$8" \] && \. "\$8"; set \+a; cd "\$1"; PORT="\$2"/);
  assert.match(ctlSource, /"\$ENV_DIR\/web\.env"/);
});

test('deploy release id is not captured from noisy build stdout and cleanup is bounded', () => {
  assert.match(ctlSource, /CREATED_RELEASE_ID=""/);
  assert.match(ctlSource, /make_release \|\| exit \$\?\n\s+deploy_stage_set "\$stage_state" release_built\n\s+release_id="\$CREATED_RELEASE_ID"/);
  assert.doesNotMatch(ctlSource, /release_id="\$\(make_release\)"/);
  assert.match(ctlSource, /valid_release_id\(\)/);
  assert.match(ctlSource, /release_path_for\(\)/);
  assert.match(ctlSource, /safe_rm_tree\(\)/);
  assert.match(ctlSource, /case "\$real_path" in "\$real_root"\/\*/);
  assert.match(ctlSource, /require_git_source_root\(\)/);
  assert.match(ctlSource, /die "source root is not a Git repository: \$SOURCE_ROOT"/);
  assert.match(ctlSource, /git -c "safe\.directory=\$SOURCE_ROOT" -C "\$SOURCE_ROOT" rev-parse --show-toplevel/);
  assert.match(ctlSource, /commit="\$\(git -c "safe\.directory=\$SOURCE_ROOT" -C "\$SOURCE_ROOT" rev-parse HEAD\)"/);
  assert.doesNotMatch(ctlSource, /git rev-parse HEAD 2>\/dev\/null \|\| echo unknown/);
  assert.match(ctlSource, /release_id="\$ts-\$short"/);
  assert.match(ctlSource, /sourceCommit:process\.argv\[4\]/);
  assert.match(ctlSource, /sourceRoot:process\.argv\[5\]/);
  assert.match(ctlSource, /previousRelease:process\.argv\[7\]/);
  assert.match(ctlSource, /testResultSummary/);
});

test('provider installer has timeout, minimal env, and candidate cleanup on failure', () => {
  assert.match(indexSource, /const PROVIDER_INSTALL_TIMEOUT_MS = 15 \* 60 \* 1000/);
  assert.match(indexSource, /detached:true/);
  assert.match(indexSource, /process\.kill\(-child\.pid, signal\)/);
  assert.match(indexSource, /timed out after/);
  assert.match(indexSource, /await rm\(candidateDir, \{ recursive:true, force:true \}\)\.catch/);
  const providerEnv = indexSource.slice(indexSource.indexOf('function providerInstallEnv'), indexSource.indexOf('async function downloadProviderInstallScript'));
  assert.doesNotMatch(providerEnv, /\.\.\.process\.env/);
  assert.match(providerEnv, /HOME: home/);
  assert.match(providerEnv, /XDG_CACHE_HOME/);
  assert.match(providerEnv, /PATH: process\.env\.PATH/);
  assert.match(providerEnv, /\['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy'\]/);
  assert.doesNotMatch(providerEnv, /COOKIE_SECRET|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|GEMINI_API_KEY/);
});

test('systemd runtime and web inherit provider tool and shared Playwright paths', () => {
  for (const unit of [runtimeUnit, webUnit]) {
    assert.match(unit, /^Environment=PATH=@AGENTDECK_DATA_DIR@\/provider-tools\/bin:/m);
    assert.match(unit, /@AGENTDECK_HOME@\/\.local\/bin:\/usr\/local\/bin/m);
    assert.match(unit, /^Environment=CODEX_BIN=@CODEX_BIN@$/m);
    assert.match(unit, /^Environment=PLAYWRIGHT_BROWSERS_PATH=@AGENTDECK_DATA_DIR@\/cache\/ms-playwright$/m);
  }
});
