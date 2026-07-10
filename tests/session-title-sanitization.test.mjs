import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('internal recovery markers never appear as session titles', async () => {
  const source = await readFile(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
  assert.match(source, /function displaySessionTitle\(session:Session\)/);
  assert.match(source, /hasInternalProviderText\(title\).*'恢复的会话'/);
  const row = source.slice(source.indexOf('function SessionRow'), source.indexOf('function ProjectPicker'));
  assert.match(row, /const title=displaySessionTitle\(session\)/);
  assert.doesNotMatch(row, />\{session\.title\}<\/b>/);
});
