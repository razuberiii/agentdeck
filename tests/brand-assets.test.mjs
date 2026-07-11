import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

test('one canonical brand system drives browser and PWA icons', async () => {
  const root=new URL('../client/public/',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('manifest.webmanifest',root),'utf8'));
  const index=await readFile(new URL('../client/index.html',import.meta.url),'utf8');
  const icons=await readdir(new URL('icons/',root));
  assert.deepEqual(icons.sort(),['agentdeck-192.png','agentdeck-512.png','agentdeck.svg']);
  assert.deepEqual(manifest.icons.map(icon=>icon.src),['/icons/agentdeck-192.png','/icons/agentdeck-512.png','/icons/agentdeck-192.png','/icons/agentdeck-512.png']);
  assert.match(index,/rel="icon" href="\/icons\/agentdeck\.svg"/);
  assert.match(index,/rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
  await access(new URL('apple-touch-icon.png',root));
});

test('application header renders the canonical vector mark', async () => {
  const source=await readFile(new URL('../client/src/main.tsx',import.meta.url),'utf8');
  assert.match(source,/function Brand/);
  assert.match(source,/className="brandGlyph"/);
  assert.doesNotMatch(source,/className="mark">AD/);
});

test('PWA worker updates bypass the browser HTTP cache', async () => {
  const root=new URL('../client/public/',import.meta.url);
  const worker=await readFile(new URL('sw.js',root),'utf8');
  const source=await readFile(new URL('../client/src/main.tsx',import.meta.url),'utf8');
  assert.match(worker,/agentdeck-v56/);
  assert.match(worker,/cache:'reload'/);
  assert.match(source,/updateViaCache:'none'/);
});
