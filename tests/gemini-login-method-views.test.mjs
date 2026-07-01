import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function loadLoginMethods() {
  const source = await readFile(new URL('../client/src/login-methods.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

test('raw Gemini auth methods are collapsed to one card per supported category', async () => {
  const { loginMethodViews } = await loadLoginMethods();
  const views = loginMethodViews([
    { id:'oauth-personal', name:'Google OAuth' },
    { id:'google', name:'Sign in with Google' },
    { id:'api-key', name:'API Key' },
    { id:'vertex-ai', name:'Vertex AI' },
  ]);

  assert.deepEqual(views.map(v => v.kind), ['oauth', 'api-key', 'vertex']);
  assert.deepEqual(views.map(v => v.methodId), ['oauth-personal', 'api-key', 'vertex-ai']);
});

test('multiple oauth ids show a single Google login method', async () => {
  const { loginMethodViews } = await loadLoginMethods();
  const views = loginMethodViews([
    { id:'oauth-personal', name:'Google OAuth' },
    { id:'sign-in-with-google', name:'Sign in with Google' },
    { id:'google', description:'Google account login' },
  ]);

  assert.equal(views.length, 1);
  assert.equal(views[0].kind, 'oauth');
  assert.equal(views[0].methodId, 'oauth-personal');
});

test('fallback methods appear only when ACP returns no raw methods', async () => {
  const { loginMethodViews } = await loadLoginMethods();
  const fallback = loginMethodViews([]);
  const raw = loginMethodViews([{ id:'oauth-personal', name:'Google OAuth' }]);

  assert.deepEqual(fallback.map(v => v.kind), ['oauth', 'api-key', 'vertex']);
  assert.deepEqual(raw.map(v => v.kind), ['oauth']);
});

test('gateway and unknown methods are each folded to at most one disabled category', async () => {
  const { loginMethodViews } = await loadLoginMethods();
  const views = loginMethodViews([
    { id:'gateway-a', name:'Gateway' },
    { id:'gateway-b', name:'Gateway login' },
    { id:'custom-a', name:'Custom auth' },
    { id:'custom-b', name:'Enterprise auth' },
  ]);

  assert.deepEqual(views.map(v => v.kind), ['gateway', 'unsupported']);
  assert.deepEqual(views.map(v => v.methodId), ['gateway-a', 'custom-a']);
});
