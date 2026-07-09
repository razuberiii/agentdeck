import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('required open-source docs are present', () => {
  for (const path of [
    'docs/install.md',
    'docs/security.md',
    'docs/providers.md',
    'docs/backup-restore.md',
    'docs/troubleshooting.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
  ]) {
    assert.equal(existsSync(new URL(path, root)), true, `${path} missing`);
  }
});

test('README points users to VPN/private-network deployment and profile docs', () => {
  const readme = read('README.md');
  assert.match(readme, /不要把未加防护的 AgentDeck 直接暴露到公网/);
  assert.match(readme, /personal/);
  assert.match(readme, /standard/);
  assert.match(readme, /hardened/);
  assert.match(readme, /docs\/backup-restore\.md/);
});

test('CI runs the required validation commands without systemd install', () => {
  const ci = read('.github/workflows/ci.yml');
  for (const command of ['npm ci', 'npm run typecheck', 'npm run lint', 'npm test', 'npm run build']) {
    assert.match(ci, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(ci, /systemctl|install-units|sudo/);
});

