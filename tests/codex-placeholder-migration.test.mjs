import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/migrate-codex-placeholder-identities.mjs', import.meta.url), 'utf8');

test('Codex placeholder migration defaults to dry-run and requires explicit apply', () => {
  assert.match(source, /const apply = process\.argv\.includes\('--apply'\)/);
  assert.match(source, /readonly:!apply/);
  assert.match(source, /mode:apply \? 'apply' : 'dry-run'/);
});

test('Codex placeholder migration resolves identity read-only before changing profiles', () => {
  assert.match(source, /method:'account\/read'/);
  assert.match(source, /refreshToken:false/);
  assert.match(source, /action = !identity\.email\s+\? 'mark_unresolved_identity'/);
  assert.match(source, /update_placeholder_identity/);
  assert.match(source, /merge_into_existing_profile/);
});

test('Codex placeholder migration moves references instead of deleting history', () => {
  assert.match(source, /moveWebReferences/);
  assert.match(source, /moveRuntimeReferences/);
  assert.match(source, /UPDATE sessions SET account_id=\?/);
  assert.doesNotMatch(source, /DELETE FROM sessions/);
  assert.doesNotMatch(source, /DELETE FROM events/);
});

test('Codex placeholder migration does not print credential contents', () => {
  assert.doesNotMatch(source, /refresh_token|access_token|id_token|client_secret/);
  const consoleBlock = source.slice(source.indexOf('console.log(JSON.stringify({'), source.indexOf('webDb.close();'));
  assert.doesNotMatch(consoleBlock, /auth\.json|token|secret|password/i);
});
