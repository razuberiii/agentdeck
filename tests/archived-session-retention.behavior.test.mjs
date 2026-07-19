import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const server=readFileSync(new URL('../server/src/index.ts',import.meta.url),'utf8');

test('archived sessions default to seven-day retention and hard deletion clears related data',()=>{
  assert.match(server,/ARCHIVED_SESSION_RETENTION_DAYS = Number\(process\.env\.ARCHIVED_SESSION_RETENTION_DAYS \|\| 7\)/);
  assert.match(server,/cleanupArchivedSessions\('scheduled'\)/);
  assert.match(server,/hardDeleteSessionData\(ids\)/);
  assert.match(server,/deleteSessionAttachmentDir\(id\)/);
  assert.match(server,/deleteSharedRolloutFiles\(id\)/);
});
