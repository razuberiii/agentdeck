import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function loadApiErrorModule() {
  const source = await readFile(new URL('../client/src/api-error.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions:{ module:ts.ModuleKind.ES2022, target:ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

test('HTML 502 response is not exposed to the user', async () => {
  const { apiErrorFromResponse } = await loadApiErrorModule();
  const response = new Response('<html><body>Cloudflare Ray ID<script>secret()</script></body></html>', {
    status: 502,
    headers: { 'content-type':'text/html; charset=UTF-8' },
  });

  const error = await apiErrorFromResponse(response);

  assert.equal(error.userMessage, '服务器暂时不可用，请稍后重试。');
  assert.equal(error.message.includes('<html>'), false);
  assert.equal(error.message.includes('Cloudflare'), false);
});

test('JSON structured error returns message and detail', async () => {
  const { apiErrorFromResponse } = await loadApiErrorModule();
  const response = new Response(JSON.stringify({
    error: { code:'gemini_session_create_failed', message:'Gemini 会话初始化失败', detail:'safe detail' },
  }), {
    status: 502,
    headers: { 'content-type':'application/json' },
  });

  const error = await apiErrorFromResponse(response);

  assert.equal(error.code, 'gemini_session_create_failed');
  assert.equal(error.userMessage, 'Gemini 会话初始化失败：safe detail');
});
