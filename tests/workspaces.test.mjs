import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { scanProjects } from '../server/dist/workspaces.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-workspaces-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  return root;
}

test('finds a regular Git repository', async t => {
  const root = await fixture(t);
  const project = path.join(root, 'regular-project');
  await mkdir(path.join(project, '.git'), { recursive:true });

  const projects = await scanProjects([root]);

  assert.deepEqual(projects.map(item => item.path), [project]);
});

test('finds a Git worktree whose .git entry is a file', async t => {
  const root = await fixture(t);
  const project = path.join(root, 'release-worktree');
  await mkdir(project, { recursive:true });
  await writeFile(path.join(project, '.git'), 'gitdir: /tmp/example.git/worktrees/release\n');

  const projects = await scanProjects([root]);

  assert.deepEqual(projects.map(item => item.path), [project]);
});
