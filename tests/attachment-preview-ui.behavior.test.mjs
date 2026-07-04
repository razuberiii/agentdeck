import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clientSource = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8');

function runPreviewScenario(source) {
  const script = `
    import assert from 'node:assert/strict';
    import {
      attachmentIconLabel,
      isImageAttachment,
    } from ${JSON.stringify(new URL('../client/src/attachment-preview.ts', import.meta.url).href)};
    ${source}
  `;
  execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio:'pipe' });
}

test('Markdown and text attachments use file icons, not image previews', () => {
  runPreviewScenario(`
    assert.equal(isImageAttachment({ name:'agentdeck-worthwhile-cleanup-prompt.md', type:'text/plain; charset=utf-8', previewUrl:'/api/preview' }), false);
    assert.equal(attachmentIconLabel({ name:'agentdeck-worthwhile-cleanup-prompt.md', type:'text/plain; charset=utf-8' }), 'MD');
    assert.equal(attachmentIconLabel({ name:'notes.txt', type:'text/plain' }), 'TXT');
    assert.equal(attachmentIconLabel({ name:'data.json', type:'application/json' }), 'JSON');
    assert.equal(attachmentIconLabel({ name:'report.pdf', type:'application/pdf' }), 'PDF');
    assert.equal(attachmentIconLabel({ name:'bundle.zip', type:'application/zip' }), 'ZIP');
  `);
});

test('image attachments are the only attachments rendered as thumbnails', () => {
  runPreviewScenario(`
    assert.equal(isImageAttachment({ name:'photo.png', type:'image/png', previewUrl:'blob:local' }), true);
    assert.equal(isImageAttachment({ name:'photo.png', type:'', previewUrl:'blob:local' }), true);
    assert.equal(isImageAttachment({ name:'photo.png', type:'application/octet-stream', previewUrl:'blob:local' }), false);
    assert.equal(isImageAttachment({ name:'bad.md', type:'text/markdown', previewUrl:'blob:local' }), false);
  `);
});

test('attachment tray falls back on broken image and keeps mobile chip columns stable', () => {
  assert.match(clientSource, /const image=isImageAttachment\(a\) && !failedPreviews\[a\.id\]/);
  assert.match(clientSource, /onError=\{\(\)=>setFailedPreviews/);
  assert.match(clientSource, /<span className="fileIcon">\{label\}<\/span>/);
  assert.match(cssSource, /\.attachItem\{[^}]*grid-template-columns:58px minmax\(0,1fr\) 28px/);
  assert.match(cssSource, /\.attachItem\{[^}]*grid-template-columns:42px minmax\(0,1fr\) 32px/);
  assert.match(cssSource, /\.attachName\{[^}]*text-overflow:ellipsis/);
  assert.match(cssSource, /\.attachRemove\{[^}]*width:32px/);
});
