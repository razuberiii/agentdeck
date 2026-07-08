import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const client = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');

test('markdown links and images use the shared safeUrl sanitizer', () => {
  assert.match(client, /type SafeUrlKind = 'link' \| 'image'/);
  assert.match(client, /function safeUrl\(url:string, kind:SafeUrlKind\):string/);
  assert.match(client, /\(\?:javascript\|data\|file\|blob\):/);
  assert.match(client, /raw\.startsWith\('\/api\/'\)/);
  assert.match(client, /parsed\.protocol === 'http:' \|\| parsed\.protocol === 'https:'/);
});

test('unsafe markdown links render as text instead of anchors', () => {
  assert.match(client, /const href=safeUrl\(link\[2\], 'link'\)/);
  assert.match(client, /href \? <a key=\{i\} href=\{href\} target="_blank" rel="noopener noreferrer"/);
  assert.match(client, /: <React\.Fragment key=\{i\}>\{link\[1\]\}<\/React\.Fragment>/);
});

test('unsafe markdown images are not loaded', () => {
  assert.match(client, /const src=safeUrl\(img\[2\], 'image'\)/);
  assert.match(client, /src \? <img className="inlineImage" key=\{i\} alt=\{img\[1\]\} src=\{src\}\/>/);
  assert.match(client, /: <React\.Fragment key=\{i\}>\{img\[1\] \|\| 'image'\}<\/React\.Fragment>/);
});

test('attachment extraction filters urls through safeUrl', () => {
  assert.match(client, /function extractMarkdownImages\(text:string\):Attachment\[\]/);
  assert.match(client, /const url=safeUrl\(m\[2\], 'image'\)/);
  assert.match(client, /filter\(\(x\):x is Attachment=>!!x\)/);
  assert.match(client, /const url=safeUrl\(m\[2\], 'link'\); if\(url&&isDownloadUrl\(url\)\)/);
});
