import assert from'node:assert/strict';
import test from'node:test';
import{readFile}from'node:fs/promises';
import{importTypeScript}from'./helpers/import-typescript.mjs';

test('Codex advertises verified ordinary-file attachment support without changing other providers',async()=>{
  const registry=await importTypeScript(new URL('../server/src/provider-registry.ts',import.meta.url));
  const codex=registry.PROVIDER_DEFINITIONS.codex.capabilities.attachments;
  assert.equal(codex.supported,true);assert.deepEqual(codex.details,{imageInput:true,fileInput:true,fileTransport:'verified_path'});
  assert.equal(registry.PROVIDER_DEFINITIONS.claude.capabilities.attachments.details.fileTransport,'sdk_content_or_safe_path');
  assert.equal(registry.PROVIDER_DEFINITIONS.antigravity.capabilities.attachments.details.fileTransport,'verified_path_with_add_dir');
  assert.equal(registry.PROVIDER_DEFINITIONS.gemini.capabilities.attachments.details.fileTransport,'resource-link');
});

test('Codex file input is server-verified and the UI does not persist capability state',async()=>{
  const server=await readFile(new URL('../server/src/index.ts',import.meta.url),'utf8'),client=await readFile(new URL('../client/src/main.tsx',import.meta.url),'utf8');
  assert.match(server,/codex: \{ imageInput:true, fileInput:true, fileTransport:'verified_path' \}/);
  assert.match(server,/buildCodexTurnInput\(threadId, providerText, attachments\)/);
  assert.match(server,/const meta=await readAttachmentMeta\(threadId,id\)/);
  assert.match(server,/realpathSync\(String\(meta\.path\|\|''\)\)/);
  assert.match(server,/if \(!rp\.startsWith\(root \+ path\.sep\)\) throw new Error\('attachment outside session'\)/);
  assert.match(server,/MAX_ATTACHMENTS_PER_MESSAGE/);assert.match(server,/MAX_TOTAL_ATTACHMENT_BYTES/);
  assert.match(client,/disabled=\{!sessionCapabilities\?\.fileInput\}/);
  assert.doesNotMatch(client,/localStorage[^\n]{0,120}fileInput|fileInput[^\n]{0,120}localStorage/);
});
