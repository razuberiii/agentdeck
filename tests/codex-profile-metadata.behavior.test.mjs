import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  extractCodexProfileMetadata,
  resolveCodexProfileMetadataFromAuth,
} from '../server/dist/codex-profile-metadata.js';
import { Db } from '../server/dist/db.js';

function jwt(payload) {
  return `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`;
}

test('Codex metadata reads real email and display name from id_token claims', () => {
  const auth = {
    tokens:{
      id_token:jwt({ email:'person@example.test', name:'Example Person' }),
      access_token:jwt({ 'https://api.openai.com/profile':{ email:'fallback@example.test' } }),
    },
  };
  assert.deepEqual(extractCodexProfileMetadata(auth), {
    email:'person@example.test',
    displayName:'Example Person',
  });
  assert.deepEqual(resolveCodexProfileMetadataFromAuth(auth), {
    email:'person@example.test',
    displayName:'Example Person',
    status:'ready',
    error:null,
  });
});

test('missing JWT email is an explicit retryable metadata failure, not a fake identity', () => {
  const result = resolveCodexProfileMetadataFromAuth({ tokens:{ id_token:jwt({ name:'Example Person' }) } });
  assert.equal(result.status, 'failed');
  assert.equal(result.email, null);
  assert.match(result.error, /未找到邮箱/);
});

test('Codex email and metadata state survive database reopen for multiple profiles', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-codex-metadata-'));
  const file = path.join(dir, 'db.sqlite3');
  let db = new Db(file);
  try {
    await db.init();
    await db.run(
      "INSERT INTO codex_profiles (id,name,codex_home,active,status,email,display_name,metadata_status,created_at,updated_at) VALUES (?1,?2,?3,1,'authenticated',?4,?5,'ready',1,1)",
      ['one','person@example.test','/profiles/one','person@example.test','Example Person'],
    );
    await db.run(
      "INSERT INTO codex_profiles (id,name,codex_home,active,status,email,display_name,metadata_status,metadata_error,created_at,updated_at) VALUES (?1,?2,?3,0,'authenticated',NULL,NULL,'failed',?4,1,1)",
      ['two','Codex Account','/profiles/two','账户信息读取失败：认证凭据中未找到邮箱'],
    );
    db.close();
    db = new Db(file);
    const profiles = await db.all('SELECT id,email,display_name,metadata_status FROM codex_profiles ORDER BY id');
    assert.deepEqual(profiles, [
      { id:'one', email:'person@example.test', display_name:'Example Person', metadata_status:'ready' },
      { id:'two', email:null, display_name:null, metadata_status:'failed' },
    ]);
  } finally {
    db.close();
    await rm(dir, { recursive:true, force:true });
  }
});
