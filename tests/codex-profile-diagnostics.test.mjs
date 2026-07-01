import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/diagnose-codex-profiles.mjs', import.meta.url), 'utf8');

test('Codex profile diagnostic discovers runtime port configuration without exposing secrets', () => {
  assert.match(source, /readRuntimeEnvironment/);
  assert.match(source, /systemctl', \['show', 'agentdeck-runtime\.service', '-p', 'Environment'/);
  assert.match(source, /CODEX_APP_SERVER_PORT_BASE \|\| runtimeEnv\.CODEX_APP_SERVER_PORT_BASE \|\| 4520/);
  assert.match(source, /isSensitiveKey/);
  assert.match(source, /TOKEN\|SECRET\|KEY\|PASSWORD\|COOKIE\|AUTH\|OAUTH/);
});

test('Codex profile diagnostic reports profile, endpoint, owner, and mismatch summaries', () => {
  assert.match(source, /activeProvider/);
  assert.match(source, /activeProfileIds/);
  assert.match(source, /profile6063Email/);
  assert.match(source, /manual4733/);
  assert.match(source, /endpoint_owned_by_different_systemd_unit/);
  assert.match(source, /web_profile_name_email_differs_from_app_server_account/);
  assert.ok(source.includes('(?:[^/\\n]+\\/)*([^/\\n]+\\.service)'));
});
