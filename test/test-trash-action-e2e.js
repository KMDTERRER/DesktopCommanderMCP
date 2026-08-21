import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { acquireMutationResourceLocks } from '../dist/utils/mutation-resource-lock.js';
import { acquireResourceLease } from '../dist/utils/resource-lease-owner.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const DIST_SERVER = path.join(REPO_ROOT, 'dist', 'index.js');
const SOURCE_SERVER = path.join(REPO_ROOT, 'src', 'index.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SOURCE_MODE = process.env.TRASH_E2E_SOURCE === '1';

function textOf(result) {
  return (result?.content ?? []).map((item) => item?.type === 'text' ? item.text ?? '' : '').join('\n');
}

function parseSuccess(result, label) {
  assert.notEqual(result?.isError, true, `${label}: ${textOf(result)}`);
  return JSON.parse(textOf(result));
}

async function call(client, name, args, timeout = 60_000) {
  return client.callTool({ name, arguments: args }, undefined, { timeout, maxTotalTimeout: timeout });
}

async function trash(client, args) {
  return call(client, 'trash_action', args);
}

async function trashWithMeta(client, args, meta) {
  return client.callTool(
    { name: 'trash_action', arguments: args, _meta: meta },
    undefined,
    { timeout: 60_000, maxTotalTimeout: 60_000 },
  );
}

async function compatTrash(client, args) {
  return call(client, 'write_file', {
    path: 'mcp://desktop-core/trash_action?timeout_ms=45000',
    content: JSON.stringify(args),
    mode: 'rewrite',
  });
}

async function openClient(home, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: SOURCE_MODE ? [TSX_CLI, SOURCE_SERVER, '--no-onboarding'] : [DIST_SERVER, '--no-onboarding'],
    cwd: REPO_ROOT,
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
    },
  });
  const client = new Client({ name: `trash-e2e-${label}`, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport, { timeout: 30_000 });
  return client;
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function initRepo(root) {
  await fs.mkdir(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'trash-e2e@example.invalid');
  git(root, 'config', 'user.name', 'Trash E2E');
  await fs.writeFile(path.join(root, 'README.md'), 'trash e2e baseline\n', 'utf8');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'baseline');
}

async function initEmptyRepo(root) {
  await fs.mkdir(root, { recursive: true });
  git(root, 'init', '-q');
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-trash-e2e-'));
  const root = path.join(temp, 'repo');
  const markerRoot = path.join(temp, 'marker-repo');
  const outside = path.join(temp, 'outside');
  const home = path.join(temp, 'home');
  await Promise.all([initRepo(root), initRepo(markerRoot), fs.mkdir(outside), fs.mkdir(home)]);
  const configDir = path.join(home, '.claude-server-commander');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    telemetryEnabled: false,
    allowedDirectories: [root, markerRoot],
    fileWriteLineLimit: 100,
  }), 'utf8');

  let clientA;
  let clientB;
  try {
    clientA = await openClient(home, 'a');
    const tools = await clientA.listTools(undefined, { timeout: 15_000 });
    const definition = tools.tools.find((tool) => tool.name === 'trash_action');
    assert(definition, 'trash_action is missing from the public MCP catalog');
    assert.equal(definition.annotations?.readOnlyHint, false, 'trash_action lost mutating metadata');
    assert.equal(definition.annotations?.destructiveHint, true, 'trash_action lost destructive metadata');

    const invalidPurge = await trash(clientA, { action: 'purge', workspace: root });
    assert.equal(invalidPurge.isError, true, `public schema accepted purge: ${textOf(invalidPurge)}`);

    const forgedTrashRoot = path.join(markerRoot, '.desktop-commander-trash');
    const forgedMarkerTarget = path.join(outside, 'forged-workspace.json');
    const forgedMarkerPath = path.join(forgedTrashRoot, 'workspace.json');
    await fs.mkdir(forgedTrashRoot);
    const missingMarkerVictim = path.join(markerRoot, 'missing-marker-must-survive.txt');
    await fs.writeFile(missingMarkerVictim, 'missing marker must fail closed\n', 'utf8');
    const missingMarkerPut = await trash(clientA, { action: 'put', path: missingMarkerVictim, workspace: markerRoot });
    assert.equal(missingMarkerPut.isError, true, `pre-existing trash root without marker was claimed: ${textOf(missingMarkerPut)}`);
    assert.match(textOf(missingMarkerPut), /ownership marker/);
    assert.equal(await fs.readFile(missingMarkerVictim, 'utf8'), 'missing marker must fail closed\n');
    await fs.unlink(missingMarkerVictim);
    await fs.writeFile(forgedMarkerTarget, JSON.stringify({ version: 1, workspaceRoot: markerRoot }, null, 2), 'utf8');
    await fs.link(forgedMarkerTarget, forgedMarkerPath);
    const forgedMarkerVictim = path.join(markerRoot, 'must-survive.txt');
    await fs.writeFile(forgedMarkerVictim, 'ownership marker must be private\n', 'utf8');
    const forgedMarkerPut = await trash(clientA, { action: 'put', path: forgedMarkerVictim, workspace: markerRoot });
    assert.equal(forgedMarkerPut.isError, true, `hardlinked ownership marker was accepted: ${textOf(forgedMarkerPut)}`);
    assert.equal(await fs.readFile(forgedMarkerVictim, 'utf8'), 'ownership marker must be private\n');

    const directPath = path.join(root, 'direct.txt');
    await fs.writeFile(directPath, 'direct recovery\n', 'utf8');
    const directPut = parseSuccess(await trash(clientA, { action: 'put', path: directPath }), 'direct put');
    assert.equal(await fs.access(directPath).then(() => true, () => false), false);
    const directList = await trash(clientA, { action: 'list' });
    assert.equal(directList.isError, true, `metadata-free stdio call reused implicit workspace state: ${textOf(directList)}`);
    const directRead = parseSuccess(await trash(
      clientA, { action: 'read', name: directPut.name, workspace: root },
    ), 'explicit-workspace read');
    assert.equal(directRead.content, 'direct recovery\n');
    parseSuccess(await trash(
      clientA, { action: 'restore', name: directPut.name, workspace: root },
    ), 'explicit-workspace restore');
    assert.equal(await fs.readFile(directPath, 'utf8'), 'direct recovery\n');
    await fs.unlink(directPath);

    if (process.platform !== 'win32') {
      const literalBackslashName = 'literal\\name.txt';
      const literalBackslashPath = path.join(root, literalBackslashName);
      await fs.writeFile(literalBackslashPath, 'literal backslash survives trash round trip\n', 'utf8');
      const literalBackslashPut = parseSuccess(await trash(clientA, {
        action: 'put', path: literalBackslashPath, workspace: root,
      }), 'literal backslash put');
      assert.equal(literalBackslashPut.originalRelativePath, literalBackslashName, 'POSIX backslash filename was rewritten as a path separator');
      parseSuccess(await trash(clientA, {
        action: 'restore', name: literalBackslashPut.name, workspace: root,
      }), 'literal backslash restore');
      assert.equal(await fs.readFile(literalBackslashPath, 'utf8'), 'literal backslash survives trash round trip\n');
      await fs.unlink(literalBackslashPath);
    }

    const manifestProbePath = path.join(root, 'manifest-probe.txt');
    await fs.writeFile(manifestProbePath, 'manifest metadata must be private\n', 'utf8');
    const manifestProbePut = parseSuccess(await trash(clientA, { action: 'put', path: manifestProbePath, workspace: root }), 'manifest probe put');
    const manifestProbeEntry = path.join(root, '.desktop-commander-trash', 'entries', manifestProbePut.name);
    const manifestProbeManifest = path.join(manifestProbeEntry, 'manifest.json');
    const manifestProbeBytes = await fs.readFile(manifestProbeManifest);
    const forgedManifestTarget = path.join(outside, 'forged-manifest.json');
    await fs.writeFile(forgedManifestTarget, manifestProbeBytes);
    await fs.unlink(manifestProbeManifest);
    await fs.link(forgedManifestTarget, manifestProbeManifest);
    const forgedManifestRead = await trash(clientA, { action: 'read', name: manifestProbePut.name, workspace: root });
    assert.equal(forgedManifestRead.isError, true, `hardlinked trash manifest was accepted: ${textOf(forgedManifestRead)}`);
    await fs.unlink(manifestProbeManifest);
    await fs.writeFile(manifestProbeManifest, manifestProbeBytes);
    parseSuccess(await trash(clientA, { action: 'restore', name: manifestProbePut.name, workspace: root }), 'manifest probe restore');
    await fs.unlink(manifestProbePath);

    const kindProbePath = path.join(root, 'kind-probe.txt');
    await fs.writeFile(kindProbePath, 'kind probe\n', 'utf8');
    const kindProbePut = parseSuccess(await trash(clientA, { action: 'put', path: kindProbePath, workspace: root }), 'kind probe put');
    const kindProbePayload = path.join(root, '.desktop-commander-trash', 'entries', kindProbePut.name, 'payload');
    const kindProbeBackup = `${kindProbePayload}.test-backup`;
    await fs.rename(kindProbePayload, kindProbeBackup);
    await fs.mkdir(kindProbePayload);
    const tamperedSummary = parseSuccess(await trash(clientA, { action: 'list', workspace: root }), 'tampered summary list');
    assert.equal(tamperedSummary.entries.some((entry) => entry.name === kindProbePut.name), false, 'summary list exposed a payload whose kind no longer matches its manifest');
    assert(tamperedSummary.warnings?.some((warning) => warning.includes(kindProbePut.name) && warning.includes('kind mismatch')), JSON.stringify(tamperedSummary));
    await fs.rmdir(kindProbePayload);
    await fs.rename(kindProbeBackup, kindProbePayload);
    parseSuccess(await trash(clientA, { action: 'restore', name: kindProbePut.name, workspace: root }), 'kind probe restore');
    await fs.unlink(kindProbePath);

    const lockProbePath = path.join(root, 'lock-probe.txt');
    await fs.writeFile(lockProbePath, 'shared read waits for mutation owner\n', 'utf8');
    const lockProbePut = parseSuccess(await trash(clientA, { action: 'put', path: lockProbePath, workspace: root }), 'lock probe put');
    const lockProbePayload = path.join(root, '.desktop-commander-trash', 'entries', lockProbePut.name, 'payload');
    const releaseProbeLock = await acquireMutationResourceLocks(
      [lockProbePayload], Date.now() + 5_000, { topologyMode: 'none', resourceMode: 'exclusive' },
    );
    let readSettled = false;
    let listSettled = false;
    const lockedRead = trash(clientA, { action: 'read', name: lockProbePut.name, workspace: root }).finally(() => { readSettled = true; });
    const lockedList = trash(clientA, { action: 'list', name: lockProbePut.name, workspace: root }).finally(() => { listSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const settledWhileLocked = { readSettled, listSettled };
    await releaseProbeLock();
    const [lockedReadResult, lockedListResult] = await Promise.all([lockedRead, lockedList]);
    assert.deepEqual(settledWhileLocked, { readSettled: false, listSettled: false }, `trash read/list bypassed an active mutation lock: ${JSON.stringify(settledWhileLocked)}`);
    assert.equal(parseSuccess(lockedReadResult, 'locked read').content, 'shared read waits for mutation owner\n');
    assert.equal(parseSuccess(lockedListResult, 'locked list').kind, 'file');
    parseSuccess(await trash(clientA, { action: 'restore', name: lockProbePut.name, workspace: root }), 'lock probe restore');
    await fs.unlink(lockProbePath);

    const wideDirectory = path.join(root, 'wide-directory');
    await fs.mkdir(wideDirectory);
    await Promise.all(Array.from({ length: 550 }, (_, index) =>
      fs.writeFile(path.join(wideDirectory, `child-${String(index).padStart(3, '0')}.txt`), `child ${index}\n`, 'utf8')
    ));
    const widePut = parseSuccess(await trash(clientA, { action: 'put', path: wideDirectory, workspace: root }), 'wide directory put');
    const wideList = parseSuccess(await trash(clientA, { action: 'list', name: widePut.name, workspace: root }), 'wide directory list');
    assert.equal(wideList.kind, 'directory');
    assert.equal(wideList.children.length, 500, 'wide directory listing did not enforce its 500-child response bound');
    assert.equal(wideList.truncated, true);
    assert.equal(wideList.totalChildren, 550);
    const wideEntry = path.join(root, '.desktop-commander-trash', 'entries', widePut.name);
    const wideManifestPath = path.join(wideEntry, 'manifest.json');
    const wideManifest = JSON.parse(await fs.readFile(wideManifestPath, 'utf8'));
    wideManifest.createdAt = Date.now() - (20 * 60 * 1000) - 1_000;
    wideManifest.expiresAt = wideManifest.createdAt + (20 * 60 * 1000);
    await fs.writeFile(wideManifestPath, JSON.stringify(wideManifest, null, 2), 'utf8');
    parseSuccess(await trash(clientA, { action: 'list', workspace: root }), 'wide directory expiry trigger');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!(await fs.access(wideEntry).then(() => true, () => false))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await fs.access(wideEntry).then(() => true, () => false), false, 'streaming expiry sweep did not purge the wide directory entry');
    assert.equal(await fs.access(wideDirectory).then(() => true, () => false), false, 'expired wide directory unexpectedly reappeared in the workspace');

    const topLevelEntries = path.join(root, '.desktop-commander-trash', 'entries');
    const syntheticEntryPaths = Array.from({ length: 1001 }, (_, index) =>
      path.join(topLevelEntries, `tr_${'f'.repeat(28)}${index.toString(16).padStart(4, '0')}`)
    );
    await Promise.all(syntheticEntryPaths.map((entryPath) => fs.mkdir(entryPath)));
    const boundedTopLevelList = parseSuccess(await trash(clientA, { action: 'list', workspace: root }), 'bounded top-level list');
    assert.equal(boundedTopLevelList.truncated, true, 'top-level list did not report the 1000-entry processing bound');
    assert.equal(boundedTopLevelList.totalEntryDirectories, 1001);
    assert((boundedTopLevelList.warnings?.length ?? 0) <= 20, 'top-level list warning output exceeded its bound');
    await Promise.all(syntheticEntryPaths.map((entryPath) => fs.rmdir(entryPath)));

    const trashIgnore = path.join(root, '.desktop-commander-trash', '.gitignore');
    const outsideIgnoreTarget = path.join(outside, 'ignore-target.txt');
    await fs.writeFile(outsideIgnoreTarget, 'outside ignore target must survive', 'utf8');
    await fs.unlink(trashIgnore);
    await fs.link(outsideIgnoreTarget, trashIgnore);
    const hardlinkProbe = await trash(clientA, { action: 'list', workspace: root });
    assert.equal(hardlinkProbe.isError, true, `tampered owner .gitignore was accepted: ${textOf(hardlinkProbe)}`);
    assert.equal(await fs.readFile(outsideIgnoreTarget, 'utf8'), 'outside ignore target must survive');
    await fs.unlink(trashIgnore);
    await fs.writeFile(trashIgnore, '*\n', 'utf8');

    try {
      await fs.unlink(trashIgnore);
      await fs.symlink(outsideIgnoreTarget, trashIgnore, 'file');
      const symlinkProbe = await trash(clientA, { action: 'list', workspace: root });
      assert.equal(symlinkProbe.isError, true, `symlinked owner .gitignore was accepted: ${textOf(symlinkProbe)}`);
      assert.equal(await fs.readFile(outsideIgnoreTarget, 'utf8'), 'outside ignore target must survive');
      await fs.unlink(trashIgnore);
      await fs.writeFile(trashIgnore, '*\n', 'utf8');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error;
      await fs.rm(trashIgnore, { force: true });
      await fs.writeFile(trashIgnore, '*\n', 'utf8');
    }

    const metadataPath = path.join(root, 'metadata.txt');
    await fs.writeFile(metadataPath, 'metadata isolation\n', 'utf8');
    const metadataPut = parseSuccess(await trashWithMeta(
      clientA, { action: 'put', path: metadataPath }, { conversation_id: 'chat-a' },
    ), 'metadata-scoped put');
    const wrongChatRead = await trashWithMeta(
      clientA, { action: 'read', name: metadataPut.name }, { conversation_id: 'chat-b' },
    );
    assert.equal(wrongChatRead.isError, true, `workspace leaked across chat metadata: ${textOf(wrongChatRead)}`);
    const metadataRead = parseSuccess(await trashWithMeta(
      clientA, { action: 'read', name: metadataPut.name }, { conversation_id: 'chat-a' },
    ), 'metadata-scoped read');
    assert.equal(metadataRead.content, 'metadata isolation\n');
    parseSuccess(await trashWithMeta(
      clientA, { action: 'restore', name: metadataPut.name }, { conversation_id: 'chat-a' },
    ), 'metadata-scoped restore');
    await fs.unlink(metadataPath);

    const compatPath = path.join(root, 'compat.txt');
    await fs.writeFile(compatPath, 'compat recovery\n', 'utf8');
    const compatPut = parseSuccess(await compatTrash(clientA, { action: 'put', path: compatPath, workspace: root }), 'frozen compat put');
    const compatRead = parseSuccess(await compatTrash(clientA, { action: 'read', name: compatPut.name, workspace: root }), 'frozen compat read');
    assert.equal(compatRead.content, 'compat recovery\n');
    parseSuccess(await compatTrash(clientA, { action: 'restore', name: compatPut.name, workspace: root }), 'frozen compat restore');
    assert.equal(await fs.readFile(compatPath, 'utf8'), 'compat recovery\n');
    await fs.unlink(compatPath);

    const collisionPath = path.join(root, 'collision.txt');
    await fs.writeFile(collisionPath, 'original collision', 'utf8');
    const collisionPut = parseSuccess(await trash(clientA, { action: 'put', path: collisionPath, workspace: root }), 'collision put');
    await fs.writeFile(collisionPath, 'replacement collision', 'utf8');
    const blockedRestore = await trash(clientA, { action: 'restore', name: collisionPut.name, workspace: root });
    assert.equal(blockedRestore.isError, true, `restore overwrote a live destination: ${textOf(blockedRestore)}`);
    assert.equal(await fs.readFile(collisionPath, 'utf8'), 'replacement collision');
    const preservedRead = parseSuccess(await trash(clientA, { action: 'read', name: collisionPut.name, workspace: root }), 'collision preserved read');
    assert.equal(preservedRead.content, 'original collision');
    await fs.unlink(collisionPath);
    parseSuccess(await trash(clientA, { action: 'restore', name: collisionPut.name, workspace: root }), 'collision restore after release');
    assert.equal(await fs.readFile(collisionPath, 'utf8'), 'original collision');
    await fs.unlink(collisionPath);

    const crashRestorePath = path.join(root, 'crash-restore.txt');
    await fs.writeFile(crashRestorePath, 'restore commit survived metadata cleanup crash\n', 'utf8');
    const crashRestorePut = parseSuccess(await trash(clientA, { action: 'put', path: crashRestorePath, workspace: root }), 'crash restore put');
    const crashRestoreEntry = path.join(root, '.desktop-commander-trash', 'entries', crashRestorePut.name);
    const crashRestorePayload = path.join(crashRestoreEntry, 'payload');
    await fs.rename(crashRestorePayload, crashRestorePath);
    const crashStateList = parseSuccess(await trash(clientA, { action: 'list', workspace: root }), 'crash restore recovery trigger');
    assert.equal(crashStateList.entries.some((entry) => entry.name === crashRestorePut.name), false, 'metadata-only restore state was exposed as restorable');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!(await fs.access(crashRestoreEntry).then(() => true, () => false))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await fs.access(crashRestoreEntry).then(() => true, () => false), false, 'metadata-only restore state was not reclaimed');
    assert.equal(await fs.readFile(crashRestorePath, 'utf8'), 'restore commit survived metadata cleanup crash\n');
    await fs.unlink(crashRestorePath);

    const outsidePath = path.join(outside, 'forbidden.txt');
    await fs.writeFile(outsidePath, 'outside must survive', 'utf8');
    const outsidePut = await trash(clientA, { action: 'put', path: outsidePath, workspace: root });
    assert.equal(outsidePut.isError, true, `trash_action escaped configured authority: ${textOf(outsidePut)}`);
    assert.equal(await fs.readFile(outsidePath, 'utf8'), 'outside must survive');

    const restartPath = path.join(root, 'restart.txt');
    await fs.writeFile(restartPath, 'survive server restart\n', 'utf8');
    const restartPut = parseSuccess(await trash(clientA, { action: 'put', path: restartPath, workspace: root }), 'restart put');
    await clientA.close();
    clientA = undefined;

    clientA = await openClient(home, 'restart');
    const restartList = parseSuccess(await trash(clientA, { action: 'list', workspace: root }), 'restart list');
    assert(restartList.entries.some((entry) => entry.name === restartPut.name), 'trash entry did not survive MCP server restart');
    const restartRead = parseSuccess(await trash(clientA, { action: 'read', name: restartPut.name, workspace: root }), 'restart read');
    assert.equal(restartRead.content, 'survive server restart\n');
    parseSuccess(await trash(clientA, { action: 'restore', name: restartPut.name, workspace: root }), 'restart restore');
    assert.equal(await fs.readFile(restartPath, 'utf8'), 'survive server restart\n');
    await fs.unlink(restartPath);

    clientB = await openClient(home, 'b');

    const groupPaths = Array.from({ length: 12 }, (_, index) => path.join(root, `group-${index}.txt`));
    await Promise.all(groupPaths.map((filePath, index) => fs.writeFile(filePath, `group payload ${index}\n`, 'utf8')));
    const groupPutResults = await Promise.all(groupPaths.map((filePath, index) =>
      trash(index % 2 === 0 ? clientA : clientB, { action: 'put', path: filePath, workspace: root })
    ));
    assert.equal(groupPutResults.filter((result) => result.isError === true).length, 0, groupPutResults.map(textOf).join('\n'));
    const groupEntries = groupPutResults.map((result, index) => parseSuccess(result, `group put ${index}`));
    assert.equal(new Set(groupEntries.map((entry) => entry.name)).size, groupPaths.length, 'concurrent group put reused a trash entry id');
    assert.equal((await Promise.all(groupPaths.map((filePath) => fs.access(filePath).then(() => true, () => false)))).some(Boolean), false);
    const groupList = parseSuccess(await trash(clientA, { action: 'list', workspace: root }), 'group list');
    for (const entry of groupEntries) {
      assert(groupList.entries.some((listed) => listed.name === entry.name), `group entry missing from list: ${entry.name}`);
    }
    const groupRestoreResults = await Promise.all(groupEntries.map((entry, index) =>
      trash(index % 2 === 0 ? clientB : clientA, { action: 'restore', name: entry.name, workspace: root })
    ));
    assert.equal(groupRestoreResults.filter((result) => result.isError === true).length, 0, groupRestoreResults.map(textOf).join('\n'));
    for (let index = 0; index < groupPaths.length; index += 1) {
      assert.equal(await fs.readFile(groupPaths[index], 'utf8'), `group payload ${index}\n`);
    }
    await Promise.all(groupPaths.map((filePath) => fs.unlink(filePath)));

    const raceRestorePath = path.join(root, 'race-restore.txt');
    await fs.writeFile(raceRestorePath, 'restore exactly once', 'utf8');
    const raceRestorePut = parseSuccess(await trash(clientA, { action: 'put', path: raceRestorePath, workspace: root }), 'race restore put');
    const restoreResults = await Promise.all([
      trash(clientA, { action: 'restore', name: raceRestorePut.name, workspace: root }),
      trash(clientB, { action: 'restore', name: raceRestorePut.name, workspace: root }),
    ]);
    assert.equal(restoreResults.filter((result) => result.isError !== true).length, 1, restoreResults.map(textOf).join('\n'));
    assert.equal(restoreResults.filter((result) => result.isError === true).length, 1, restoreResults.map(textOf).join('\n'));
    assert.equal(await fs.readFile(raceRestorePath, 'utf8'), 'restore exactly once');
    await fs.unlink(raceRestorePath);

    const racePutPath = path.join(root, 'race-put.txt');
    await fs.writeFile(racePutPath, 'put exactly once', 'utf8');
    const putResults = await Promise.all([
      trash(clientA, { action: 'put', path: racePutPath, workspace: root }),
      trash(clientB, { action: 'put', path: racePutPath, workspace: root }),
    ]);
    const putSuccesses = putResults.filter((result) => result.isError !== true);
    assert.equal(putSuccesses.length, 1, putResults.map(textOf).join('\n'));
    assert.equal(putResults.filter((result) => result.isError === true).length, 1, putResults.map(textOf).join('\n'));
    const racePut = parseSuccess(putSuccesses[0], 'cross-process race put');
    assert.equal(await fs.access(racePutPath).then(() => true, () => false), false);
    parseSuccess(await trash(clientA, { action: 'restore', name: racePut.name, workspace: root }), 'cross-process race put restore');
    assert.equal(await fs.readFile(racePutPath, 'utf8'), 'put exactly once');
    await fs.unlink(racePutPath);

    const registryParent = path.join(temp, 'registry-workspaces');
    const registryHome = path.join(temp, 'registry-home');
    await Promise.all([fs.mkdir(registryParent), fs.mkdir(registryHome)]);
    const reusableRegistryRoot = path.join(registryParent, 'active-reusable');
    await initEmptyRepo(reusableRegistryRoot);
    const reusableEntryName = `tr_${'0'.repeat(32)}`;
    await fs.mkdir(path.join(reusableRegistryRoot, '.desktop-commander-trash', 'entries', reusableEntryName), { recursive: true });
    const registryRoots = [
      reusableRegistryRoot,
      ...Array.from({ length: 127 }, (_, index) => path.join(outside, `registry-unknown-${String(index).padStart(3, '0')}`)),
    ];
    const overflowRoot = path.join(registryParent, 'overflow');
    await initEmptyRepo(overflowRoot);
    const overflowTarget = path.join(overflowRoot, 'must-not-move.txt');
    await fs.writeFile(overflowTarget, 'registry overflow must fail closed\n', 'utf8');
    const registryConfigDir = path.join(registryHome, '.claude-server-commander');
    await fs.mkdir(registryConfigDir, { recursive: true });
    await fs.writeFile(path.join(registryConfigDir, 'config.json'), JSON.stringify({
      telemetryEnabled: false, allowedDirectories: [registryParent], trashWorkspaceRootsV1: registryRoots,
    }), 'utf8');
    let registryClient;
    try {
      registryClient = await openClient(registryHome, 'registry-limit');
      const overflowPut = await trash(registryClient, { action: 'put', path: overflowTarget, workspace: overflowRoot });
      assert.equal(overflowPut.isError, true, `129th active trash workspace was silently admitted: ${textOf(overflowPut)}`);
      assert.match(textOf(overflowPut), /at most 128 active workspaces/);
      assert.equal(await fs.readFile(overflowTarget, 'utf8'), 'registry overflow must fail closed\n');
    } finally {
      if (registryClient) await registryClient.close().catch(() => {});
    }
    const reusableEntry = path.join(
      reusableRegistryRoot, '.desktop-commander-trash', 'entries', reusableEntryName,
    );
    await fs.rmdir(reusableEntry);
    let compactingRegistryClient;
    try {
      compactingRegistryClient = await openClient(registryHome, 'registry-compaction');
      const admittedPut = parseSuccess(await trash(compactingRegistryClient, {
        action: 'put', path: overflowTarget, workspace: overflowRoot,
      }), 'registry compaction put');
      parseSuccess(await trash(compactingRegistryClient, {
        action: 'restore', name: admittedPut.name, workspace: overflowRoot,
      }), 'registry compaction restore');
      assert.equal(await fs.readFile(overflowTarget, 'utf8'), 'registry overflow must fail closed\n');
      await fs.unlink(overflowTarget);
    } finally {
      if (compactingRegistryClient) await compactingRegistryClient.close().catch(() => {});
    }

    const registryRaceRoots = [
      path.join(registryParent, 'race-a'),
      path.join(registryParent, 'race-b'),
    ];
    await Promise.all(registryRaceRoots.map((registryRoot) => initEmptyRepo(registryRoot)));
    const registryRaceTargets = registryRaceRoots.map((registryRoot, index) =>
      path.join(registryRoot, `race-${index}.txt`)
    );
    await Promise.all(registryRaceTargets.map((target, index) =>
      fs.writeFile(target, `registry race ${index}\n`, 'utf8')
    ));
    let registryRaceClientA;
    let registryRaceClientB;
    let registryRaceAdmittedIndex = -1;
    try {
      [registryRaceClientA, registryRaceClientB] = await Promise.all([
        openClient(registryHome, 'registry-race-a'),
        openClient(registryHome, 'registry-race-b'),
      ]);
      const registryRaceResults = await Promise.all([
        trash(registryRaceClientA, { action: 'put', path: registryRaceTargets[0], workspace: registryRaceRoots[0] }),
        trash(registryRaceClientB, { action: 'put', path: registryRaceTargets[1], workspace: registryRaceRoots[1] }),
      ]);
      assert.equal(registryRaceResults.filter((result) => result.isError !== true).length, 1,
        `two MCP processes consumed one recovery-registry slot: ${registryRaceResults.map(textOf).join('\n')}`);
      assert.equal(registryRaceResults.filter((result) => result.isError === true).length, 1,
        `registry slot race did not fail closed: ${registryRaceResults.map(textOf).join('\n')}`);
      for (let index = 0; index < registryRaceResults.length; index += 1) {
        const result = registryRaceResults[index];
        if (result.isError === true) {
          assert.equal(await fs.readFile(registryRaceTargets[index], 'utf8'), `registry race ${index}\n`);
          await fs.unlink(registryRaceTargets[index]);
          continue;
        }
        registryRaceAdmittedIndex = index;
        const admitted = parseSuccess(result, `registry race admitted ${index}`);
        parseSuccess(await trash(index === 0 ? registryRaceClientA : registryRaceClientB, {
          action: 'restore', name: admitted.name, workspace: registryRaceRoots[index],
        }), `registry race restore ${index}`);
        assert.equal(await fs.readFile(registryRaceTargets[index], 'utf8'), `registry race ${index}\n`);
        await fs.unlink(registryRaceTargets[index]);
      }
    } finally {
      if (registryRaceClientB) await registryRaceClientB.close().catch(() => {});
      if (registryRaceClientA) await registryRaceClientA.close().catch(() => {});
    }
    assert(registryRaceAdmittedIndex >= 0, 'registry race did not leave one tracked empty workspace for the follow-up race');

    const existingEmptyRoot = registryRaceRoots[registryRaceAdmittedIndex];
    const registryRaceRegistryFile = path.join(registryConfigDir, 'trash-workspaces-v1.json');
    const registryRaceRegistry = JSON.parse(await fs.readFile(registryRaceRegistryFile, 'utf8'));
    registryRaceRegistry.roots = [
      existingEmptyRoot,
      ...registryRaceRegistry.roots.filter((candidate) =>
        path.resolve(candidate).toLowerCase() !== path.resolve(existingEmptyRoot).toLowerCase()
      ),
    ];
    await fs.writeFile(registryRaceRegistryFile, JSON.stringify(registryRaceRegistry, null, 2), 'utf8');
    const existingEmptyTarget = path.join(existingEmptyRoot, 'existing-empty-race.txt');
    const existingEmptyCompetitorRoot = path.join(registryParent, 'existing-empty-competitor');
    await initEmptyRepo(existingEmptyCompetitorRoot);
    const existingEmptyCompetitorTarget = path.join(existingEmptyCompetitorRoot, 'competitor.txt');
    await Promise.all([
      fs.writeFile(existingEmptyTarget, 'existing tracked empty root wins its reservation\n', 'utf8'),
      fs.writeFile(existingEmptyCompetitorTarget, 'competitor must fail closed\n', 'utf8'),
    ]);
    const holdExistingPut = await acquireResourceLease({
      kind: 'build', readPaths: [existingEmptyTarget], coverage: 'exact', label: 'trash registry existing-empty E2E hold',
    }, Date.now() + 5_000);
    let existingEmptyClient;
    let existingEmptyCompetitorClient;
    try {
      [existingEmptyClient, existingEmptyCompetitorClient] = await Promise.all([
        openClient(registryHome, 'registry-existing-empty'),
        openClient(registryHome, 'registry-existing-empty-competitor'),
      ]);
      const existingPutPromise = trash(existingEmptyClient, {
        action: 'put', path: existingEmptyTarget, workspace: existingEmptyRoot,
      });
      await new Promise((resolve) => setTimeout(resolve, 750));
      let competitorSettled = false;
      const competitorPutPromise = trash(existingEmptyCompetitorClient, {
        action: 'put', path: existingEmptyCompetitorTarget, workspace: existingEmptyCompetitorRoot,
      }).finally(() => { competitorSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const competitorSettledBeforeCommit = competitorSettled;
      await holdExistingPut.release();
      const [existingPutResult, competitorPutResult] = await Promise.all([existingPutPromise, competitorPutPromise]);
      assert.equal(competitorSettledBeforeCommit, false,
        'a competing workspace evicted an already-tracked empty workspace while its put was waiting to commit');
      const existingPut = parseSuccess(existingPutResult, 'existing empty tracked workspace put');
      assert.equal(competitorPutResult.isError, true,
        `competitor consumed the tracked workspace reservation: ${textOf(competitorPutResult)}`);
      assert.equal(await fs.readFile(existingEmptyCompetitorTarget, 'utf8'), 'competitor must fail closed\n');
      parseSuccess(await trash(existingEmptyClient, {
        action: 'restore', name: existingPut.name, workspace: existingEmptyRoot,
      }), 'existing empty tracked workspace restore');
      assert.equal(await fs.readFile(existingEmptyTarget, 'utf8'), 'existing tracked empty root wins its reservation\n');
      await Promise.all([fs.unlink(existingEmptyTarget), fs.unlink(existingEmptyCompetitorTarget)]);
    } finally {
      await holdExistingPut.release().catch(() => {});
      if (existingEmptyCompetitorClient) await existingEmptyCompetitorClient.close().catch(() => {});
      if (existingEmptyClient) await existingEmptyClient.close().catch(() => {});
    }

    const unknownRegistryHome = path.join(temp, 'registry-unknown-home');
    const unknownRegistryRoot = path.join(registryParent, 'unknown-overflow');
    await Promise.all([fs.mkdir(unknownRegistryHome), initEmptyRepo(unknownRegistryRoot)]);
    const unknownRegistryTarget = path.join(unknownRegistryRoot, 'must-stay.txt');
    await fs.writeFile(unknownRegistryTarget, 'unknown registry roots must fail closed\n', 'utf8');
    const unknownRegistryConfigDir = path.join(unknownRegistryHome, '.claude-server-commander');
    await fs.mkdir(unknownRegistryConfigDir, { recursive: true });
    const unvalidatedRoots = Array.from({ length: 128 }, (_, index) =>
      path.join(outside, `unvalidated-${String(index).padStart(3, '0')}`)
    );
    await fs.writeFile(path.join(unknownRegistryConfigDir, 'config.json'), JSON.stringify({
      telemetryEnabled: false, allowedDirectories: [registryParent], trashWorkspaceRootsV1: unvalidatedRoots,
    }), 'utf8');
    let unknownRegistryClient;
    try {
      unknownRegistryClient = await openClient(unknownRegistryHome, 'registry-unknown');
      const unknownRegistryPut = await trash(unknownRegistryClient, {
        action: 'put', path: unknownRegistryTarget, workspace: unknownRegistryRoot,
      });
      assert.equal(unknownRegistryPut.isError, true,
        `unverifiable tracked roots were converted into free recovery capacity: ${textOf(unknownRegistryPut)}`);
      assert.match(textOf(unknownRegistryPut), /at most 128 active workspaces/);
      assert.equal(await fs.readFile(unknownRegistryTarget, 'utf8'), 'unknown registry roots must fail closed\n');
    } finally {
      if (unknownRegistryClient) await unknownRegistryClient.close().catch(() => {});
      await fs.unlink(unknownRegistryTarget).catch(() => {});
    }

    const corruptRegistryHome = path.join(temp, 'registry-corrupt-home');
    const corruptRegistryRoot = path.join(temp, 'registry-corrupt-repo');
    await Promise.all([fs.mkdir(corruptRegistryHome), initRepo(corruptRegistryRoot)]);
    const corruptRegistryConfigDir = path.join(corruptRegistryHome, '.claude-server-commander');
    await fs.mkdir(corruptRegistryConfigDir, { recursive: true });
    await fs.writeFile(path.join(corruptRegistryConfigDir, 'config.json'), JSON.stringify({
      telemetryEnabled: false, allowedDirectories: [corruptRegistryRoot],
    }), 'utf8');
    const recoverAfterCorruption = path.join(corruptRegistryRoot, 'recover-after-corruption.txt');
    await fs.writeFile(recoverAfterCorruption, 'recovery must survive registry corruption\n', 'utf8');
    let corruptRegistryClient;
    let recoverAfterCorruptionPut;
    try {
      corruptRegistryClient = await openClient(corruptRegistryHome, 'registry-corrupt-prime');
      recoverAfterCorruptionPut = parseSuccess(await trash(corruptRegistryClient, {
        action: 'put', path: recoverAfterCorruption, workspace: corruptRegistryRoot,
      }), 'registry corruption prime put');
    } finally {
      if (corruptRegistryClient) await corruptRegistryClient.close().catch(() => {});
      corruptRegistryClient = undefined;
    }
    const corruptRegistryFile = path.join(corruptRegistryConfigDir, 'trash-workspaces-v1.json');
    await fs.writeFile(corruptRegistryFile, '{"version":1,"roots":[', 'utf8');
    const blockedByCorruptRegistry = path.join(corruptRegistryRoot, 'blocked-put.txt');
    await fs.writeFile(blockedByCorruptRegistry, 'new put must fail closed\n', 'utf8');
    try {
      corruptRegistryClient = await openClient(corruptRegistryHome, 'registry-corrupt-recover');
      const recoverRead = parseSuccess(await trash(corruptRegistryClient, {
        action: 'read', name: recoverAfterCorruptionPut.name, workspace: corruptRegistryRoot,
      }), 'read survives corrupt registry');
      assert.equal(recoverRead.content, 'recovery must survive registry corruption\n');
      const corruptRegistryPut = await trash(corruptRegistryClient, {
        action: 'put', path: blockedByCorruptRegistry, workspace: corruptRegistryRoot,
      });
      assert.equal(corruptRegistryPut.isError, true, `corrupt recovery registry admitted a new put: ${textOf(corruptRegistryPut)}`);
      assert.match(textOf(corruptRegistryPut), /registry|JSON/i);
      assert.equal(await fs.readFile(blockedByCorruptRegistry, 'utf8'), 'new put must fail closed\n');
      parseSuccess(await trash(corruptRegistryClient, {
        action: 'restore', name: recoverAfterCorruptionPut.name, workspace: corruptRegistryRoot,
      }), 'restore survives corrupt registry');
      assert.equal(await fs.readFile(recoverAfterCorruption, 'utf8'), 'recovery must survive registry corruption\n');
      await Promise.all([fs.unlink(recoverAfterCorruption), fs.unlink(blockedByCorruptRegistry)]);
    } finally {
      if (corruptRegistryClient) await corruptRegistryClient.close().catch(() => {});
    }

    const linkedRegistryHome = path.join(temp, 'registry-hardlink-home');
    const linkedRegistryRoot = path.join(temp, 'registry-hardlink-repo');
    await Promise.all([fs.mkdir(linkedRegistryHome), initRepo(linkedRegistryRoot)]);
    const linkedRegistryConfigDir = path.join(linkedRegistryHome, '.claude-server-commander');
    await fs.mkdir(linkedRegistryConfigDir, { recursive: true });
    await fs.writeFile(path.join(linkedRegistryConfigDir, 'config.json'), JSON.stringify({
      telemetryEnabled: false, allowedDirectories: [linkedRegistryRoot, linkedRegistryConfigDir, outside],
    }), 'utf8');
    const linkedRegistryPrime = path.join(linkedRegistryRoot, 'prime.txt');
    await fs.writeFile(linkedRegistryPrime, 'prime linked registry\n', 'utf8');
    let linkedRegistryClient;
    try {
      linkedRegistryClient = await openClient(linkedRegistryHome, 'registry-hardlink-prime');
      const linkedRegistryPrimePut = parseSuccess(await trash(linkedRegistryClient, {
        action: 'put', path: linkedRegistryPrime, workspace: linkedRegistryRoot,
      }), 'registry hardlink prime put');
      parseSuccess(await trash(linkedRegistryClient, {
        action: 'restore', name: linkedRegistryPrimePut.name, workspace: linkedRegistryRoot,
      }), 'registry hardlink prime restore');
      await fs.unlink(linkedRegistryPrime);
    } finally {
      if (linkedRegistryClient) await linkedRegistryClient.close().catch(() => {});
      linkedRegistryClient = undefined;
    }
    const linkedRegistryFile = path.join(linkedRegistryConfigDir, 'trash-workspaces-v1.json');
    const linkedRegistryOriginal = await fs.readFile(linkedRegistryFile);
    let linkedRegistryGuardClient;
    try {
      linkedRegistryGuardClient = await openClient(linkedRegistryHome, 'registry-base-tool-guard');
      const registryBaseWrite = await call(linkedRegistryGuardClient, 'write_file', {
        path: linkedRegistryFile, content: '{\"version\":1,\"roots\":[]}\n', mode: 'rewrite',
      });
      assert.equal(registryBaseWrite.isError, true,
        `base write_file modified the authoritative trash registry: ${textOf(registryBaseWrite)}`);
      assert.match(textOf(registryBaseWrite), /reserved|trash.*registry|internal/i);
      assert.deepEqual(await fs.readFile(linkedRegistryFile), linkedRegistryOriginal,
        'base write_file changed the authoritative trash registry bytes');
    } finally {
      if (linkedRegistryGuardClient) await linkedRegistryGuardClient.close().catch(() => {});
    }
    const linkedRegistryOutside = path.join(outside, 'linked-trash-workspaces-v1.json');
    await fs.copyFile(linkedRegistryFile, linkedRegistryOutside);
    await fs.unlink(linkedRegistryFile);
    await fs.link(linkedRegistryOutside, linkedRegistryFile);
    const linkedRegistryVictim = path.join(linkedRegistryRoot, 'must-not-move-through-hardlinked-registry.txt');
    await fs.writeFile(linkedRegistryVictim, 'hardlinked registry must fail closed\n', 'utf8');
    try {
      linkedRegistryClient = await openClient(linkedRegistryHome, 'registry-hardlink-attack');
      const linkedRegistryPut = await trash(linkedRegistryClient, {
        action: 'put', path: linkedRegistryVictim, workspace: linkedRegistryRoot,
      });
      assert.equal(linkedRegistryPut.isError, true,
        `hardlinked authoritative trash registry was accepted: ${textOf(linkedRegistryPut)}`);
      assert.match(textOf(linkedRegistryPut), /private real file|link|registry/i);
      assert.equal(await fs.readFile(linkedRegistryVictim, 'utf8'), 'hardlinked registry must fail closed\n');
      assert.deepEqual(await fs.readFile(linkedRegistryOutside), await fs.readFile(linkedRegistryFile),
        'registry hardlink target changed during rejected admission');
      const registryAliasBefore = await fs.readFile(linkedRegistryFile);
      const aliasWrite = await call(linkedRegistryClient, 'write_file', {
        path: linkedRegistryOutside, content: '{\"version\":1,\"roots\":[]}\n', mode: 'rewrite',
      });
      assert.equal(aliasWrite.isError, true,
        `base write_file modified authoritative registry through a hardlink alias: ${textOf(aliasWrite)}`);
      assert.match(textOf(aliasWrite), /reserved|trash.*registry|hardlink|internal/i);
      assert.deepEqual(await fs.readFile(linkedRegistryFile), registryAliasBefore,
        'hardlink alias write changed authoritative registry bytes');
      await fs.unlink(linkedRegistryVictim);
    } finally {
      if (linkedRegistryClient) await linkedRegistryClient.close().catch(() => {});
    }

    const finalList = parseSuccess(await trash(clientA, { action: 'list', workspace: root }), 'final list');
    assert.deepEqual(finalList.entries, [], `E2E leaked restorable trash entries: ${JSON.stringify(finalList.entries)}`);
    assert.equal(git(root, 'status', '--short'), '', 'E2E left the Git workspace dirty');

    console.log('trash_action public MCP e2e: PASS');
  } finally {
    if (clientB) await clientB.close().catch(() => {});
    if (clientA) await clientA.close().catch(() => {});
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
