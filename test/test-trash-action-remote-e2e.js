import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

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

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function initRepo(root) {
  await fs.mkdir(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'trash-remote-e2e@example.invalid');
  git(root, 'config', 'user.name', 'Trash Remote E2E');
  await fs.writeFile(path.join(root, 'README.md'), 'trash remote e2e baseline\n', 'utf8');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'baseline');
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-trash-remote-e2e-'));
  const root = path.join(temp, 'repo');
  const home = path.join(temp, 'home');
  await Promise.all([initRepo(root), fs.mkdir(home)]);
  const configDir = path.join(home, '.claude-server-commander');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    telemetryEnabled: false, allowedDirectories: [root], fileWriteLineLimit: 100,
  }), 'utf8');

  const integration = new DesktopCommanderIntegration();
  integration.resolveMcpConfig = async () => ({
    command: process.execPath,
    args: [SERVER, '--no-onboarding'],
    cwd: REPO_ROOT,
    env: { HOME: home, USERPROFILE: home, DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true' },
  });

  try {
    await integration.initialize();

    const noMetaPath = path.join(root, 'remote-no-meta.txt');
    await fs.writeFile(noMetaPath, 'remote metadata required\n', 'utf8');
    const noMetaPut = parseSuccess(await integration.callClientTool(
      'trash_action', { action: 'put', path: noMetaPath },
    ), 'remote no-metadata put');
    const noMetaRead = await integration.callClientTool('trash_action', { action: 'read', name: noMetaPut.name });
    assert.equal(noMetaRead.isError, true, `remote call reused an implicit process workspace: ${textOf(noMetaRead)}`);
    parseSuccess(await integration.callClientTool(
      'trash_action', { action: 'restore', name: noMetaPut.name, workspace: root },
    ), 'remote no-metadata explicit restore');
    await fs.unlink(noMetaPath);

    const directPath = path.join(root, 'remote-direct.txt');
    const chatA = { conversation_id: 'remote-chat-a' };
    const chatB = { conversation_id: 'remote-chat-b' };
    await fs.writeFile(directPath, 'remote direct recovery\n', 'utf8');
    const put = parseSuccess(await integration.callClientTool(
      'trash_action', { action: 'put', path: directPath }, chatA,
    ), 'remote metadata-scoped put');
    const wrongChatRead = await integration.callClientTool('trash_action', { action: 'read', name: put.name }, chatB);
    assert.equal(wrongChatRead.isError, true, `remote workspace leaked across chats: ${textOf(wrongChatRead)}`);
    const read = parseSuccess(await integration.callClientTool(
      'trash_action', { action: 'read', name: put.name }, chatA,
    ), 'remote metadata-scoped read');
    assert.equal(read.content, 'remote direct recovery\n');
    parseSuccess(await integration.callClientTool(
      'trash_action', { action: 'restore', name: put.name }, chatA,
    ), 'remote metadata-scoped restore');
    assert.equal(await fs.readFile(directPath, 'utf8'), 'remote direct recovery\n');
    await fs.unlink(directPath);

    const compatPath = path.join(root, 'remote-compat.txt');
    await fs.writeFile(compatPath, 'remote compat recovery\n', 'utf8');
    const compatPut = parseSuccess(await integration.callClientTool('write_file', {
      path: 'mcp://desktop-core/trash_action?timeout_ms=45000',
      content: JSON.stringify({ action: 'put', path: compatPath, workspace: root }),
      mode: 'rewrite',
    }), 'remote frozen compat put');
    const compatRead = parseSuccess(await integration.callClientTool('trash_action', {
      action: 'read', name: compatPut.name, workspace: root,
    }), 'remote frozen compat read');
    assert.equal(compatRead.content, 'remote compat recovery\n');
    parseSuccess(await integration.callClientTool('write_file', {
      path: 'mcp://desktop-core/trash_action?timeout_ms=45000',
      content: JSON.stringify({ action: 'restore', name: compatPut.name, workspace: root }),
      mode: 'rewrite',
    }), 'remote frozen compat restore');
    assert.equal(await fs.readFile(compatPath, 'utf8'), 'remote compat recovery\n');
    await fs.unlink(compatPath);

    const finalList = parseSuccess(await integration.callClientTool('trash_action', { action: 'list', workspace: root }), 'remote final list');
    assert.deepEqual(finalList.entries, []);
    assert.equal(git(root, 'status', '--short'), '', 'Remote E2E left the Git workspace dirty');
    console.log('trash_action remote parent-to-child e2e: PASS');
  } finally {
    await integration.shutdown().catch(() => {});
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
