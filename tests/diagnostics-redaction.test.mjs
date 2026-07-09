import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');

test('server uses a unified secret masker for diagnostics and logs', () => {
  assert.match(source, /function maskSecrets\(value:any\):any/);
  assert.match(source, /function maskSecretText\(text:string\)/);
  for (const keyword of ['token','secret','password','apiKey','api_key','cookie','authorization','deviceCode','device_code','auth code','login URL']) {
    assert.match(source, new RegExp(keyword.replace(' ', '\\s+'), 'i'));
  }
});

test('diagnostics are masked and local paths are hidden unless verbose is enabled', () => {
  assert.match(source, /const VERBOSE_DIAGNOSTICS = process\.env\.AGENTDECK_ENABLE_VERBOSE_DIAGNOSTICS === '1'/);
  assert.match(source, /return maskSecrets\(VERBOSE_DIAGNOSTICS \? payload : redactDiagnosticPaths\(payload\)\)/);
  assert.match(source, /function redactDiagnosticPaths\(value:any\):any/);
  assert.match(source, /profile\.\*path\|home\.\*path\|token\.\*path\|codexHome\|homeDir\|profileDir\|configDir/i);
  assert.match(source, /function maskEmail\(email:string\)/);
});

test('provider install logs and errors are redacted before reaching the UI', () => {
  assert.match(source, /output:job\.output\.slice\(-80\)\.map\(line => maskSecretText\(line\)\)/);
  assert.match(source, /error:job\.error \? maskSecretText\(job\.error\) : null/);
  assert.match(source, /job\.output\.push\(`\[\$\{new Date\(\)\.toISOString\(\)\}\] \$\{maskSecretText\(line\)\}`\)/);
  assert.match(source, /maskSecretText\(redactLine\(line\)\)\.slice\(0, 1000\)/);
});

test('common secret shapes are redacted from text', () => {
  assert.match(source, /Bearer \[redacted\]/);
  assert.match(source, /\[redacted-login-url\]/);
  assert.match(source, /\[redacted-api-key\]/);
  assert.match(source, /authorization code\|device code/);
});
