import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function transpile(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  return ts.transpileModule(source, { compilerOptions:{ module:ts.ModuleKind.ES2022, target:ts.ScriptTarget.ES2022 } }).outputText;
}

test('API client accepts empty success responses and preserves explicit content type', async () => {
  const errorSource = await transpile('../client/src/api-error.ts');
  const errorUrl = `data:text/javascript;base64,${Buffer.from(errorSource).toString('base64')}`;
  const clientSource = (await transpile('../client/src/api/client.ts')).replace("'../api-error'", JSON.stringify(errorUrl));
  const { api } = await import(`data:text/javascript;base64,${Buffer.from(clientSource).toString('base64')}`);
  globalThis.document = { cookie:'agentdeck_csrf=token%3Dvalue' };
  let request;
  globalThis.fetch = async (_url, options) => {
    request = options;
    return new Response(null, { status:204 });
  };

  assert.equal(await api('/empty', { method:'POST', body:'plain', headers:{ 'Content-Type':'text/plain' } }), undefined);
  assert.equal(request.headers.get('content-type'), 'text/plain');
  assert.equal(request.headers.get('x-csrf-token'), 'token=value');
});

test('draft storage helpers tolerate browsers that deny localStorage', async () => {
  const source = (await transpile('../client/src/utils/storage.ts')).replace("import type { Attachment } from '../api/types';\n", '');
  globalThis.localStorage = {
    getItem(){ throw new DOMException('denied', 'SecurityError'); },
    setItem(){ throw new DOMException('denied', 'SecurityError'); },
    removeItem(){ throw new DOMException('denied', 'SecurityError'); },
  };
  const storage = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

  assert.equal(storage.storageGet('key'), null);
  assert.equal(storage.storageSet('key', 'value'), false);
  assert.doesNotThrow(()=>storage.storageRemove('key'));
  assert.deepEqual(storage.loadDraftAttachments('session'), []);
  assert.doesNotThrow(()=>storage.saveDraftAttachments('session', []));
});
