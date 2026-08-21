#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { configManager } from '../dist/config-manager.js';
import { handleTrashAction } from '../dist/handlers/filesystem-handlers.js';
import { validatePathAuthority } from '../dist/tools/path-security.js';
import { listDirectory, readFile } from '../dist/tools/filesystem.js';
import { TrashActionArgsSchema } from '../dist/tools/schemas.js';
import { TrashManager, trashManager } from '../dist/tools/trash-manager.js';
import { callBuiltinAcceleratorTool } from '../dist/tools/workspace-accelerators.js';
import {
  MANAGED_TRASH_DIRECTORY_NAME, MANAGED_TRASH_RETENTION_MS,
} from '../dist/utils/trash-contract.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

async function exists(filePath) {
  try { await fs.lstat(filePath); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function initRepo(root, label) {
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', `${label}@example.invalid`);
  git(root, 'config', 'user.name', label);
}

async function commitBaseline(root) {
  await fs.writeFile(path.join(root, 'README.txt'), 'baseline\n', 'utf8');
  git(root, 'add', 'README.txt');
  git(root, 'commit', '--quiet', '-m', 'baseline');
}

function textResult(result) {
  return (result?.content ?? []).map((item) => item?.text ?? '').join('\n');
}

async function removeLink(linkPath) {
  try { await fs.unlink(linkPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    await fs.rmdir(linkPath);
  }
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-trash-action-'));
  const root = path.join(temp, 'repo-a');
  const rootB = path.join(temp, 'repo-b');
  const outside = path.join(temp, 'outside');
  await Promise.all([fs.mkdir(root), fs.mkdir(rootB), fs.mkdir(outside)]);
  initRepo(root, 'trash-a');
  initRepo(rootB, 'trash-b');
  await commitBaseline(root);
  await commitBaseline(rootB);
  const originalConfig = await configManager.getConfig();
  const trashRegistryFile = path.join(os.homedir(), '.claude-server-commander', 'trash-workspaces-v1.json');
  await configManager.setValue('allowedDirectories', [root, rootB, outside]);

  try {
    assert.equal(MANAGED_TRASH_RETENTION_MS, 20 * 60 * 1000);
    assert.equal(TrashActionArgsSchema.safeParse({ action: 'purge', workspace: root }).success, false);
    assert.equal(TrashActionArgsSchema.safeParse({ action: 'put' }).success, false);
    assert.equal(TrashActionArgsSchema.safeParse({ action: 'read', workspace: root }).success, false);

    const basic = path.join(root, 'basic.txt');
    await fs.writeFile(basic, 'recover me\n', 'utf8');
    const put = await trashManager.action({ action: 'put', path: basic, workspace: root });
    assert.match(put.name, /^tr_[a-f0-9]{32}$/);
    assert.equal(await exists(basic), false);
    assert.equal(put.originalRelativePath, 'basic.txt');

    const listed = await trashManager.action({ action: 'list', workspace: root });
    assert(listed.entries.some((entry) => entry.name === put.name));
    const read = await trashManager.action({ action: 'read', name: put.name, workspace: root });
    assert.equal(read.encoding, 'utf8');
    assert.equal(read.content, 'recover me\n');

    const storage = path.join(root, MANAGED_TRASH_DIRECTORY_NAME);
    const payload = path.join(storage, 'entries', put.name, 'payload');
    await assert.rejects(() => validatePathAuthority(payload), /reserved for trash_action/);
    await assert.rejects(() => readFile(payload), /reserved for trash_action/);
    const rootListing = await listDirectory(root, 3);
    assert.equal(rootListing.some((line) => line.includes(MANAGED_TRASH_DIRECTORY_NAME)), false);

    const restored = await trashManager.action({ action: 'restore', name: put.name, workspace: root });
    assert.equal(restored.restored, true);
    assert.equal(await fs.readFile(basic, 'utf8'), 'recover me\n');
    await fs.unlink(basic);

    const directory = path.join(root, 'folder');
    await fs.mkdir(path.join(directory, 'nested'), { recursive: true });
    await fs.writeFile(path.join(directory, 'a.txt'), 'a', 'utf8');
    await fs.writeFile(path.join(directory, 'nested', 'b.txt'), 'b', 'utf8');
    const dirPut = await trashManager.action({ action: 'put', path: directory, workspace: root });
    const dirList = await trashManager.action({ action: 'list', name: dirPut.name, workspace: root });
    assert.deepEqual(dirList.children.map((item) => item.name).sort(), ['a.txt', 'nested']);
    await assert.rejects(
      () => trashManager.action({ action: 'read', name: dirPut.name, workspace: root }),
      /only reads file payloads/,
    );
    await trashManager.action({ action: 'restore', name: dirPut.name, workspace: root });
    assert.equal(await fs.readFile(path.join(directory, 'nested', 'b.txt'), 'utf8'), 'b');
    await fs.rm(directory, { recursive: true, force: true });

    const overwrite = path.join(root, 'overwrite.txt');
    await fs.writeFile(overwrite, 'original', 'utf8');
    const overwritePut = await trashManager.action({ action: 'put', path: overwrite, workspace: root });
    await fs.writeFile(overwrite, 'replacement', 'utf8');
    await assert.rejects(
      () => trashManager.action({ action: 'restore', name: overwritePut.name, workspace: root }),
      /destination already exists/,
    );
    assert.equal(await fs.readFile(overwrite, 'utf8'), 'replacement');
    await fs.unlink(overwrite);
    await trashManager.action({ action: 'restore', name: overwritePut.name, workspace: root });
    await fs.unlink(overwrite);

    await assert.rejects(() => trashManager.action({ action: 'put', path: root, workspace: root }));
    assert.equal(await exists(root), true);
    await assert.rejects(
      () => trashManager.action({ action: 'put', path: path.join(root, '.git', 'config'), workspace: root }),
    );
    assert.equal(await exists(path.join(root, '.git', 'config')), true);

    const outsideFile = path.join(outside, 'not-a-repo.txt');
    await fs.writeFile(outsideFile, 'outside', 'utf8');
    await assert.rejects(
      () => trashManager.action({ action: 'put', path: outsideFile, workspace: root }),
      /Git working tree|not requested workspace/,
    );
    assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside');

    const foreign = path.join(rootB, 'foreign.txt');
    await fs.writeFile(foreign, 'foreign', 'utf8');
    await assert.rejects(
      () => trashManager.action({ action: 'put', path: foreign, workspace: root }),
      /not requested workspace/,
    );
    assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign');
    await fs.unlink(foreign);

    const preexistingTrash = path.join(rootB, MANAGED_TRASH_DIRECTORY_NAME);
    await fs.mkdir(preexistingTrash);
    const preexistingTarget = path.join(rootB, 'preexisting-target.txt');
    await fs.writeFile(preexistingTarget, 'safe', 'utf8');
    await assert.rejects(
      () => trashManager.action({ action: 'put', path: preexistingTarget, workspace: rootB }),
      /ownership marker/,
    );
    assert.equal(await fs.readFile(preexistingTarget, 'utf8'), 'safe');
    await fs.unlink(preexistingTarget);
    await fs.rmdir(preexistingTrash);

    const racePath = path.join(root, 'race.txt');
    await fs.writeFile(racePath, 'race', 'utf8');
    const racePut = await trashManager.action({ action: 'put', path: racePath, workspace: root });
    const raceResults = await Promise.allSettled([
      trashManager.action({ action: 'restore', name: racePut.name, workspace: root }),
      trashManager.action({ action: 'restore', name: racePut.name, workspace: root }),
    ]);
    assert.equal(raceResults.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(raceResults.filter((item) => item.status === 'rejected').length, 1);
    assert.equal(await fs.readFile(racePath, 'utf8'), 'race');
    await fs.unlink(racePath);

    let symlinkSupported = true;
    const outsideDir = path.join(outside, 'linked-dir');
    await fs.mkdir(outsideDir);
    const outsideSecret = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(outsideSecret, 'TOP SECRET', 'utf8');
    const linkPath = path.join(root, 'outside-link');
    try {
      await fs.symlink(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') symlinkSupported = false;
      else throw error;
    }
    if (symlinkSupported) {
      const linkPut = await trashManager.action({ action: 'put', path: linkPath, workspace: root });
      assert.equal(await fs.readFile(outsideSecret, 'utf8'), 'TOP SECRET');
      const linkRead = await trashManager.action({ action: 'read', name: linkPut.name, workspace: root });
      assert.equal(linkRead.kind, 'symlink');
      assert.equal(linkRead.encoding, 'link-target');
      assert.equal(linkRead.content.includes('TOP SECRET'), false);
      await trashManager.action({ action: 'restore', name: linkPut.name, workspace: root });
      assert.equal(await fs.readFile(outsideSecret, 'utf8'), 'TOP SECRET');
      await removeLink(linkPath);
    }

    const parent = path.join(root, 'restore-parent');
    await fs.mkdir(parent);
    const parentFile = path.join(parent, 'item.txt');
    await fs.writeFile(parentFile, 'parent item', 'utf8');
    const parentPut = await trashManager.action({ action: 'put', path: parentFile, workspace: root });
    if (symlinkSupported) {
      const oldParent = path.join(root, 'restore-parent-old');
      await fs.rename(parent, oldParent);
      await fs.symlink(outsideDir, parent, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(
        () => trashManager.action({ action: 'restore', name: parentPut.name, workspace: root }),
        /restore parent|path fence|outside/,
      );
      assert.equal(await fs.readFile(outsideSecret, 'utf8'), 'TOP SECRET');
      await removeLink(parent);
      await fs.rename(oldParent, parent);
    }
    await trashManager.action({ action: 'restore', name: parentPut.name, workspace: root });
    assert.equal(await fs.readFile(parentFile, 'utf8'), 'parent item');
    await fs.rm(parent, { recursive: true, force: true });

    const visibility = path.join(root, 'visibility.txt');
    await fs.writeFile(visibility, 'hidden trash payload', 'utf8');
    const visibilityPut = await trashManager.action({ action: 'put', path: visibility, workspace: root });
    const snapshot = await callBuiltinAcceleratorTool('workspace_snapshot', { root, includeDiffStat: false });
    assert.equal(snapshot.dirty, false, `managed trash leaked into workspace snapshot: ${snapshot.statusShort}`);
    assert.equal(snapshot.changedFiles.some((file) => file.includes(MANAGED_TRASH_DIRECTORY_NAME)), false);
    assert.equal(snapshot.statusShort.includes(MANAGED_TRASH_DIRECTORY_NAME), false);
    const context = await callBuiltinAcceleratorTool('context_pack', {
      root,
      query: 'managed trash workspace.json recovery payload',
      seedFiles: [`${MANAGED_TRASH_DIRECTORY_NAME}/workspace.json`],
      maxFiles: 4,
      maxTotalChars: 12000,
    });
    assert.equal(context.files.some((file) => file.path.includes(MANAGED_TRASH_DIRECTORY_NAME)), false);
    assert(context.missingSeedFiles.includes(`${MANAGED_TRASH_DIRECTORY_NAME}/workspace.json`));

    const astVisibility = path.join(root, 'visibility.ts');
    await fs.writeFile(astVisibility, 'function trashLeakProbe(){ return 4815162342; }\n', 'utf8');
    const astPut = await trashManager.action({ action: 'put', path: astVisibility, workspace: root });
    const astSearch = await callBuiltinAcceleratorTool('ast_search', {
      project_folder: root, pattern: 'function trashLeakProbe() { $$$A }',
      language: 'TypeScript', max_results: 20, output_format: 'json', timeout_ms: 5000,
    });
    assert.equal(astSearch.returnedMatches, 0, 'ast_search exposed a managed trash payload');
    await trashManager.action({ action: 'restore', name: astPut.name, workspace: root });
    await fs.unlink(astVisibility);

    await trashManager.action({ action: 'restore', name: visibilityPut.name, workspace: root });
    await fs.unlink(visibility);

    const expiredDir = path.join(root, 'expired-dir');
    await fs.mkdir(expiredDir);
    await fs.writeFile(path.join(expiredDir, 'local.txt'), 'local', 'utf8');
    if (symlinkSupported) {
      await fs.symlink(
        outsideDir, path.join(expiredDir, 'outside-junction'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    const expiredPut = await trashManager.action({ action: 'put', path: expiredDir, workspace: root });
    const expiredEntry = path.join(storage, 'entries', expiredPut.name);
    const expiredManifestPath = path.join(expiredEntry, 'manifest.json');
    const expiredManifest = JSON.parse(await fs.readFile(expiredManifestPath, 'utf8'));
    expiredManifest.createdAt = Date.now() - MANAGED_TRASH_RETENTION_MS - 5000;
    expiredManifest.expiresAt = expiredManifest.createdAt + MANAGED_TRASH_RETENTION_MS;
    await fs.writeFile(expiredManifestPath, JSON.stringify(expiredManifest, null, 2), 'utf8');

    let registered = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const registry = JSON.parse(await fs.readFile(trashRegistryFile, 'utf8'));
        if (Array.isArray(registry.roots) && registry.roots.some((value) => path.resolve(value) === path.resolve(root))) {
          registered = true;
          break;
        }
      } catch {}
      await sleep(25);
    }
    assert.equal(registered, true, 'trash workspace registry was not persisted to the authoritative registry file');

    const pendingOrphan = path.join(storage, 'entries', `.pending-tr_${'a'.repeat(32)}`);
    await fs.mkdir(pendingOrphan, { recursive: false });

    const restartedManager = new TrashManager();
    await restartedManager.start();
    for (let attempt = 0; attempt < 40 && (await exists(expiredEntry) || await exists(pendingOrphan)); attempt += 1) {
      await sleep(50);
    }
    assert.equal(await exists(expiredEntry), false, 'cold-start autonomous sweep did not purge expired entry');
    assert.equal(await exists(pendingOrphan), false, 'cold-start autonomous sweep did not purge abandoned pending entry');
    assert.equal(await fs.readFile(outsideSecret, 'utf8'), 'TOP SECRET');

    const invalidHandler = await handleTrashAction({ action: 'restore', workspace: root });
    assert.equal(invalidHandler.isError, true);
    assert.match(textResult(invalidHandler), /requires name/);

    const finalList = await trashManager.action({ action: 'list', workspace: root });
    assert.equal(finalList.entries.length, 0, `test leaked restorable trash entries: ${JSON.stringify(finalList.entries)}`);
    const finalSnapshot = await callBuiltinAcceleratorTool('workspace_snapshot', { root, includeDiffStat: false });
    assert.equal(finalSnapshot.dirty, false, `test repository not clean: ${finalSnapshot.statusShort}`);

    console.log('trash_action security regression: PASS');
  } finally {
    try {
      await configManager.updateConfig(originalConfig);
    } catch {
      // Test cleanup is best-effort; isolated suite homes are removed by the runner.
    }
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
