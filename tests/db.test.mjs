import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Db } from '../server/dist/db.js';

test('Db uses persistent sqlite connection with numbered parameters and transactions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-db-'));
  const db = new Db(path.join(dir, 'agentdeck.sqlite3'));
  try {
    await db.init();
    await db.run('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    await db.run('INSERT INTO kv (k,v) VALUES (?1,?2)', ['a', 'one']);
    assert.deepEqual(await db.get('SELECT v FROM kv WHERE k=?1', ['a']), { v: 'one' });
    db.transaction(() => {
      db['open']().prepare('INSERT INTO kv (k,v) VALUES (?,?)').run('b', 'two');
      db['open']().prepare('UPDATE kv SET v=? WHERE k=?').run('three', 'b');
    });
    assert.equal((await db.get('SELECT v FROM kv WHERE k=?1', ['b']))?.v, 'three');
  } finally {
    db.close();
    await rm(dir, { recursive:true, force:true });
  }
});
