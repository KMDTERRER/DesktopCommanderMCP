#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { callBuiltinAcceleratorTool } from '../dist/tools/workspace-accelerators.js';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function initRepo(root) {
  await fs.mkdir(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'delta-state@example.invalid');
  git(root, 'config', 'user.name', 'Delta State Test');
  git(root, 'config', 'core.autocrlf', 'false');
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-delta-git-state-'));
try {
  const repo = path.join(temp, 'repo');
  await initRepo(repo);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'one\n', 'utf8');
  await fs.writeFile(path.join(repo, 'rename-me.txt'), 'rename\n', 'utf8');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'baseline');

  const initial = await callBuiltinAcceleratorTool('workspace_delta', { root: repo }, 10000);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'two\n', 'utf8');
  const unstaged = await callBuiltinAcceleratorTool('workspace_delta', { root: repo, cursor: initial.cursor }, 10000);
  assert.deepEqual(unstaged.changedFiles, ['tracked.txt']);

  git(repo, 'add', 'tracked.txt');
  const staged = await callBuiltinAcceleratorTool('workspace_delta', { root: repo, cursor: unstaged.cursor }, 10000);
  assert(staged.changedFiles.includes('tracked.txt'), JSON.stringify(staged));
  assert(staged.dirtyDelta.changed.includes('tracked.txt'), JSON.stringify(staged));

  git(repo, 'mv', 'rename-me.txt', 'renamed.txt');
  const renamed = await callBuiltinAcceleratorTool('workspace_delta', { root: repo, cursor: staged.cursor }, 10000);
  assert(renamed.workingTreeChangedFiles.includes('rename-me.txt'), JSON.stringify(renamed));
  assert(renamed.workingTreeChangedFiles.includes('renamed.txt'), JSON.stringify(renamed));

  const subSource = path.join(temp, 'sub-source');
  await initRepo(subSource);
  await fs.writeFile(path.join(subSource, 'library.txt'), 'library\n', 'utf8');
  git(subSource, 'add', '.');
  git(subSource, 'commit', '-qm', 'sub baseline');

  const parent = path.join(temp, 'parent');
  await initRepo(parent);
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'vendor/sub');
  git(parent, 'commit', '-qam', 'add submodule');

  const cleanParent = await callBuiltinAcceleratorTool('workspace_delta', { root: parent }, 10000);
  assert.deepEqual(cleanParent.workingTreeChangedFiles, []);
  await fs.writeFile(path.join(parent, 'vendor', 'sub', 'untracked.txt'), 'dirty\n', 'utf8');

  const [snapshot, dirtyParent] = await Promise.all([
    callBuiltinAcceleratorTool('workspace_snapshot', { root: parent, includeDiffStat: false }, 10000),
    callBuiltinAcceleratorTool('workspace_delta', { root: parent, cursor: cleanParent.cursor }, 10000),
  ]);
  assert(snapshot.changedFiles.includes('vendor/sub'), JSON.stringify(snapshot));
  assert(dirtyParent.workingTreeChangedFiles.includes('vendor/sub'), JSON.stringify(dirtyParent));
  assert(dirtyParent.changedFiles.includes('vendor/sub'), JSON.stringify(dirtyParent));
  console.log('workspace delta git-state/submodule: PASS');
} finally {
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
