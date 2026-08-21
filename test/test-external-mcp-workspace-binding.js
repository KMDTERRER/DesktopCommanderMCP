#!/usr/bin/env node
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { bindExternalMcpWorkspace, bindExternalMcpWorkspaceDefinition, resolveExternalMcpWorkspaceDefinition } from '../dist/tools/external-mcp-binding.js';

const __filename = fileURLToPath(import.meta.url);
const testDir = path.dirname(__filename);
const repoRoot = path.resolve(testDir, '..');
const configPath = path.join(testDir, '.tmp-external-mcp-binding.json');

async function expectReject(fn, fragment) {
  let error;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  assert(error, `Expected rejection containing: ${fragment}`);
  assert(String(error).includes(fragment), String(error));
}

async function main() {
  await fs.writeFile(configPath, JSON.stringify({
    mcpServers: {
      bound: { args: ['serve', '--repo', repoRoot] },
      relative: { cwd: '..', args: ['serve', '--repo', 'src'] },
      equals: { args: ['serve', `--repo=${repoRoot}`] },
      envBound: { env: { CRG_REPO_ROOT: repoRoot }, args: ['serve'] },
      envRelative: { cwd: '..', env: { CRG_REPO_ROOT: 'src' }, args: ['serve'] },
      cliOverEnv: { env: { CRG_REPO_ROOT: path.dirname(repoRoot) }, args: ['serve', '--repo', repoRoot] },
      unbound: { args: ['serve'] },
    },
  }), 'utf8');

  try {
    const injected = await bindExternalMcpWorkspace(configPath, 'bound', {
      changed_files: ['src/server.ts'],
    });
    assert.equal(path.resolve(injected.repo_root), repoRoot);
    assert.deepEqual(injected.changed_files, ['src/server.ts']);

    const sameRoot = await bindExternalMcpWorkspace(configPath, 'bound', {
      repo_root: repoRoot,
    });
    assert.equal(path.resolve(sameRoot.repo_root), repoRoot);

    const relativeConfig = await bindExternalMcpWorkspace(configPath, 'relative', {});
    assert.equal(path.resolve(relativeConfig.repo_root), path.join(repoRoot, 'src'));

    const relativeDefinition = await bindExternalMcpWorkspaceDefinition({
      name: 'relative-definition',
      command: { kind: 'stdio', command: 'node', args: ['--repo', 'src'], cwd: repoRoot },
    }, {});
    assert.equal(path.resolve(relativeDefinition.repo_root), path.join(repoRoot, 'src'));

    const serverOwnedRoot = await bindExternalMcpWorkspaceDefinition({
      name: 'server-owned-root',
      command: { kind: 'stdio', command: 'node', args: ['--repo', repoRoot], cwd: repoRoot },
    }, { changed_files: ['src/server.ts'] }, Date.now() + 30_000, false);
    assert.equal(Object.hasOwn(serverOwnedRoot, 'repo_root'), false);
    assert.deepEqual(serverOwnedRoot.changed_files, ['src/server.ts']);

    await expectReject(
      () => bindExternalMcpWorkspaceDefinition({
        name: 'server-owned-root',
        command: { kind: 'stdio', command: 'node', args: ['--repo', repoRoot], cwd: repoRoot },
      }, { changed_files: ['../outside.ts'] }, Date.now() + 30_000, false),
      'outside',
    );

    const equalsBound = await bindExternalMcpWorkspace(configPath, 'equals', {});
    assert.equal(path.resolve(equalsBound.repo_root), repoRoot);

    const envBound = await bindExternalMcpWorkspace(configPath, 'envBound', {});
    assert.equal(path.resolve(envBound.repo_root), repoRoot);
    const envRelative = await bindExternalMcpWorkspace(configPath, 'envRelative', {});
    assert.equal(path.resolve(envRelative.repo_root), path.join(repoRoot, 'src'));
    const cliOverEnv = await bindExternalMcpWorkspace(configPath, 'cliOverEnv', {});
    assert.equal(path.resolve(cliOverEnv.repo_root), repoRoot);

    await expectReject(
      () => bindExternalMcpWorkspaceDefinition({
        name: 'env-definition',
        command: { kind: 'stdio', command: 'node', args: [], cwd: repoRoot },
        env: { CRG_REPO_ROOT: repoRoot },
      }, { repo_root: path.dirname(repoRoot) }),
      'cannot switch repo_root',
    );
    await expectReject(
      () => bindExternalMcpWorkspaceDefinition({
        name: 'equals-definition',
        command: { kind: 'stdio', command: 'node', args: [`--repo=${repoRoot}`], cwd: repoRoot },
      }, { repo_root: path.dirname(repoRoot) }),
      'cannot switch repo_root',
    );

    await expectReject(
      () => bindExternalMcpWorkspace(configPath, 'bound', { repo_root: path.dirname(repoRoot) }),
      'cannot switch repo_root',
    );
    await expectReject(
      () => bindExternalMcpWorkspace(configPath, 'bound', { changed_files: ['../outside.ts'] }),
      'outside',
    );
    await expectReject(
      () => bindExternalMcpWorkspace(configPath, 'bound', { changed_files: [path.join(repoRoot, 'src', 'server.ts')] }),
      'relative',
    );

    await expectReject(
      () => bindExternalMcpWorkspace(configPath, 'bound', {}, Date.now() - 1),
      'deadline exceeded',
    );

    const untouched = await bindExternalMcpWorkspace(configPath, 'unbound', { repo_root: 'elsewhere' });
    assert.equal(untouched.repo_root, 'elsewhere');
    console.log('external MCP workspace binding: PASS');
  } finally {
    await fs.unlink(configPath).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
