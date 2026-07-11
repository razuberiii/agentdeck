import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const repo = new URL('..', import.meta.url).pathname;
const ctl = join(repo, 'scripts/agentdeckctl');

function shell(body) {
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-deploy-txn-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  try {
    return execFileSync('bash', ['-c', `set -euo pipefail; source "$CTL"; ensure_dirs; ${body}`], {
      encoding: 'utf8',
      env: { ...process.env, CTL: ctl, AGENTDECK_ROOT: root, AGENTDECK_SOURCE_ROOT: repo, DATA_DIR: join(root, 'data'), AGENTDECK_DEPLOY_STATE_DIR: join(root, 'state'), AGENTDECK_KEEP_RELEASES: '1' },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('pointer snapshot restores both components after a partial all cutover', () => {
  const out = shell(`
    mkdir -p "$RELEASES_DIR/old-web" "$RELEASES_DIR/old-runtime" "$RELEASES_DIR/new"
    ln -s releases/old-web "$CURRENT_WEB_LINK"; ln -s releases/old-runtime "$CURRENT_RUNTIME_LINK"
    snapshot="$STATE_DIR/before"; snapshot_deploy_pointers "$snapshot"
    ln -sfn releases/new "$CURRENT_RUNTIME_LINK"; ln -sfn releases/new "$CURRENT_WEB_LINK"
    restore_deploy_pointers "$snapshot"
    printf '%s|%s' "$(readlink "$CURRENT_WEB_LINK")" "$(readlink "$CURRENT_RUNTIME_LINK")"
  `);
  assert.equal(out, 'releases/old-web|releases/old-runtime');
});

test('cleanup protects every component pointer and a running job using normalized targets', () => {
  const out = shell(`
    for n in {0..9}; do mkdir -p "$RELEASES_DIR/r$n"; touch -d "2020-01-01 00:00:$n" "$RELEASES_DIR/r$n"; done
    links=("$CURRENT_LINK" "$PREVIOUS_LINK" "$CANDIDATE_LINK" "$CURRENT_WEB_LINK" "$PREVIOUS_WEB_LINK" "$CANDIDATE_WEB_LINK" "$CURRENT_RUNTIME_LINK" "$PREVIOUS_RUNTIME_LINK" "$CANDIDATE_RUNTIME_LINK")
    for n in {0..8}; do ln -s "./releases/../releases/r$n" "\${links[$n]}"; done
    writeFile="$JOBS_DIR/live.json"; printf '{"status":"running","release":"r9"}' > "$writeFile"
    cleanup_releases
    find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' '
  `);
  assert.equal(out.trim(), '10');
});

test('new release is removed only after candidate references are cleared', () => {
  const out = shell(`
    mkdir -p "$RELEASES_DIR/new"; ln -s releases/new "$CANDIDATE_RUNTIME_LINK"
    remove_release_if_unreferenced "$RELEASES_DIR/new"; [ -d "$RELEASES_DIR/new" ]
    clear_candidate_release_links "$RELEASES_DIR/new"; remove_release_if_unreferenced "$RELEASES_DIR/new"
    [ ! -e "$CANDIDATE_RUNTIME_LINK" ] && [ ! -e "$RELEASES_DIR/new" ]; echo ok
  `);
  assert.equal(out.trim(), 'ok');
});

test('candidate web is configured to call the candidate runtime port', () => {
  const source = readFileSync(ctl, 'utf8');
  const fn = source.slice(source.indexOf('start_candidate_web()'), source.indexOf('wait_http()'));
  assert.match(fn, /RUNTIME_CANDIDATE_PORT/);
  assert.doesNotMatch(fn, /127\.0\.0\.1:\$RUNTIME_PORT"/);
});
