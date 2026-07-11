import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');

test('non-GET requests validate Origin or Referer before CSRF', () => {
  const hookStart = server.indexOf("app.addHook('preHandler'");
  const hookEnd = server.indexOf('function secureCookie', hookStart);
  assert.notEqual(hookStart, -1);
  const hook = server.slice(hookStart, hookEnd);
  assert.match(server, /function allowedRequestOrigin/);
  assert.match(hook, /!\['GET','HEAD'\]\.includes\(req\.method\).*allowedRequestOrigin/);
  assert.match(hook, /return reply\.code\(403\)\.send\(\{error:'origin'\}\)/);
  assert.match(hook, /x-csrf-token/);
});

test('allowed origins are strict when configured and compatible when unset', () => {
  assert.match(server, /ALLOWED_ORIGINS_CONFIGURED/);
  assert.match(server, /ALLOWED_ORIGINS\.includes\(candidate\) \|\| ALLOWED_ORIGINS\.includes\(candidateOrigin\)/);
  assert.match(server, /if \(ALLOWED_ORIGINS_CONFIGURED\) return false/);
  assert.match(server, /sameHostOrigin\(candidate, host\) \|\| localhostOrigin\(candidate\)/);
});

test('websocket upgrade requires session cookie and legal origin', () => {
  const routeStart = server.indexOf("app.get('/ws'");
  const routeEnd = server.indexOf('app.setNotFoundHandler', routeStart);
  assert.notEqual(routeStart, -1);
  const route = server.slice(routeStart, routeEnd);
  assert.match(route, /authSessionForRequest\(req\).*1008, 'auth'/s);
  assert.match(route, /allowedRequestOrigin\(req\).*1008, 'origin'/s);
});

test('websocket messages are size-limited JSON with schema validation', () => {
  assert.match(server, /const WS_MAX_MESSAGE_BYTES/);
  assert.match(server, /function validateWsMessage/);
  const routeStart = server.indexOf("app.get('/ws'");
  const routeEnd = server.indexOf('app.setNotFoundHandler', routeStart);
  const route = server.slice(routeStart, routeEnd);
  assert.match(route, /Buffer\.byteLength\(raw\) > WS_MAX_MESSAGE_BYTES/);
  assert.match(route, /wsClose\(ws, 1009, 'message_too_large'\)/);
  assert.match(route, /JSON\.parse\(raw\.toString\(\)\)/);
  assert.match(route, /wsClose\(ws, 1003, 'invalid_json'\)/);
  assert.match(route, /validateWsMessage\(msg\)/);
  assert.match(route, /wsClose\(ws, 1008, 'invalid_message'\)/);
});

test('websocket connection counts are limited per IP and session', () => {
  assert.match(server, /WS_MAX_CONNECTIONS_PER_SESSION/);
  assert.match(server, /WS_MAX_CONNECTIONS_PER_IP/);
  assert.match(server, /websocketIpCounts/);
  assert.match(server, /websocketSessionCounts/);
  assert.match(server, /too_many_connections/);
  assert.match(server, /too_many_session_connections/);
  assert.match(server, /cleanupWsConnection/);
});

test('websocket transport sends mobile-safe heartbeat pings and cleans them up', () => {
  const routeStart = server.indexOf("app.get('/ws'");
  const routeEnd = server.indexOf('app.setNotFoundHandler', routeStart);
  const route = server.slice(routeStart, routeEnd);
  assert.match(route, /setInterval\(\(\) =>/);
  assert.match(route, /ws\.ping\(\)/);
  assert.match(route, /15_000/);
  assert.match(route, /clearInterval\(heartbeat\)/);
  assert.match(route, /websocket closed/);
});
