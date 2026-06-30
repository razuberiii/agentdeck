import assert from 'node:assert/strict';
import test from 'node:test';

async function getJson(url) {
  const res = await fetch(url);
  assert.equal(res.ok, true, `${url} returned ${res.status}`);
  return res.json();
}

test('unauthenticated web status is minimal and runtime is healthy', async () => {
  const status = await getJson('http://127.0.0.1:3842/api/status');
  assert.equal(status.authed, false);
  assert.equal(status.authenticated, false);
  assert.equal(typeof status.serverTime, 'number');
  assert.deepEqual(status.capabilities, {});
  assert.equal(Object.hasOwn(status, 'roots'), false);
  assert.equal(Object.hasOwn(status, 'codexHome'), false);
  assert.equal(Object.hasOwn(status, 'providers'), false);

  const runtime = await getJson('http://127.0.0.1:3852/healthz');
  assert.equal(runtime.ok, true);
});
