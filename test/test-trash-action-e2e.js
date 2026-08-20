import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const SERVER = path.join(REPO_ROOT, 'dist', 'index.js');

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
    args: [SERVER, '--no-onboarding'],
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

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-trash-e2e-'));
  const root = path.join(temp, 'repo');
  const outside = path.join(temp, 'outside');
  const home = path.join(temp, 'home');
  await Promise.all([initRepo(root), fs.mkdir(outside), fs.mkdir(home)]);
  const configDir = path.join(home, '.claude-server-commander');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    telemetryEnabled: false,
    allowedDirectories: [root],
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
