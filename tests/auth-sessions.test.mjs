import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const db = readFileSync(new URL('../server/src/db.ts', import.meta.url), 'utf8');

test('auth sessions are stored server-side with hashed tokens only', () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS auth_sessions/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS auth_sessions/);
  assert.match(server, /function authTokenHash\(token:string\)/);
  assert.match(server, /INSERT INTO auth_sessions \(id,token_hash,created_at,expires_at,last_seen_at,user_agent,ip_hint\)/);
  assert.match(server, /\[id, authTokenHash\(token\), now, expiresAt, now/);
  assert.doesNotMatch(server, /CREATE TABLE IF NOT EXISTS auth_sessions[^;]*\btoken TEXT/);
});

test('login issues a random token cookie and ensureAuth checks the database', () => {
  assert.match(server, /crypto\.randomBytes\(32\)\.toString\('base64url'\)/);
  assert.match(server, /reply\.setCookie\(COOKIE_NAME, token, secureCookie\(\)\)/);
  assert.doesNotMatch(server, /setCookie\(COOKIE_NAME,[\s\S]{0,80}signed:true/);
  assert.match(server, /SELECT \* FROM auth_sessions WHERE token_hash=\?1 AND revoked_at IS NULL AND expires_at>\?2/);
  assert.match(server, /async function ensureAuth\(req:any, reply:any\) \{ if \(!\(await authSessionForRequest\(req, reply\)\)\)/);
});

test('logout and revoke invalidate server-side sessions', () => {
  assert.match(server, /app\.post\('\/api\/logout'[\s\S]{0,260}UPDATE auth_sessions SET revoked_at=\?1 WHERE id=\?2/);
  assert.match(server, /app\.get\('\/api\/auth\/sessions'/);
  assert.match(server, /app\.delete\('\/api\/auth\/sessions\/:id'[\s\S]{0,220}UPDATE auth_sessions SET revoked_at=\?1 WHERE id=\?2/);
});

test('expired sessions are rejected and old signed cookies migrate once', () => {
  assert.match(server, /expires_at>\?2/);
  assert.match(server, /function legacySignedSessionCookie/);
  assert.match(server, /app\.unsignCookie\(value\)/);
  assert.match(server, /if \(legacy && reply\) \{[\s\S]{0,120}createAuthSession\(req, reply\)/);
});

test('admin password changes revoke old sessions', () => {
  assert.match(server, /function adminPasswordFingerprint/);
  assert.match(server, /adminPasswordFingerprint/);
  assert.match(server, /UPDATE users SET password_hash=\?1 WHERE username=\?2/);
  assert.match(server, /UPDATE auth_sessions SET revoked_at=\?1 WHERE revoked_at IS NULL/);
});
