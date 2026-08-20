import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const server = path.join(repoRoot, 'dist', 'index.js');
const textOf = (result) => result?.content?.map((part) => part?.text ?? '').join('') ?? '';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-remote-escape-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-remote-escape-home-'));
  const configDir = path.join(home, '.claude-server-commander');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    telemetryEnabled: false, allowedDirectories: [root], fileWriteLineLimit: 100,
  }), 'utf8');

  const integration = new DesktopCommanderIntegration();
  integration.resolveMcpConfig = async () => ({
    command: process.execPath, args: [server, '--no-onboarding'], cwd: repoRoot,
    env: { HOME: home, USERPROFILE: home, DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true' },
  });

  const file = path.join(root, 'escaping.txt');
  const original = [
    String.raw`literal-a=\a literal-r=\r literal-f=\f literal-n=\n literal-t=\t slash=\\`,
    String.raw`windows=C:\Users\agent\AGENTS.md`,
    String.raw`json={"regex":"\\d+\\s","path":"C:\\temp\\file.txt"}`,
    'actual-tab=\t actual-crlf-next=\r\nEND',
  ].join('\n');

  try {
    await integration.initialize();
    const wrote = await integration.callClientTool('write_file', { path: file, content: original, mode: 'rewrite' });
    assert.notEqual(wrote.isError, true, textOf(wrote));
    assert.equal(await fs.readFile(file, 'utf8'), original, 'write_file changed literal backslash/control sequences');

    const search = String.raw`literal-r=\r literal-f=\f literal-n=\n`;
    const replacement = String.raw`literal-r=\r literal-f=\f literal-a2=\a literal-backslash=\\`;
    const edited = await integration.callClientTool('edit_block', {
      file_path: file, old_string: search, new_string: replacement, expected_replacements: 1,
    });
    assert.notEqual(edited.isError, true, textOf(edited));

    const expected = original.replace(search, replacement);
    const bytes = await fs.readFile(file, 'utf8');
    assert.equal(bytes, expected, 'edit_block changed escaping across Remote parent -> stdio MCP -> filesystem');
    assert(bytes.includes(String.raw`\a`) && bytes.includes(String.raw`\r`) && bytes.includes(String.raw`\f`));
    assert(bytes.includes(String.raw`C:\Users\agent\AGENTS.md`));

    const siblingFile = path.join(root, 'remote-mcp-siblings.txt');
    const siblingBase = `LEFT_0\n${'payload'.repeat(20_000)}\nRIGHT_0\n`;
    const siblingHash = `sha256:${crypto.createHash('sha256').update(siblingBase, 'utf8').digest('hex')}`;
    await fs.writeFile(siblingFile, siblingBase, 'utf8');
    const siblingCall = (oldText, newText) => integration.callClientTool('write_file', {
      path: 'mcp://desktop-accelerators/edit_file?timeout_ms=30000',
      content: JSON.stringify({
        path: siblingFile, expectedHash: siblingHash, dryRun: false,
        edits: [{ oldText, newText, expectedReplacements: 1 }],
      }),
      mode: 'rewrite',
    }, { conversation_id: 'remote-sibling-e2e' });
    const siblings = await Promise.all([
      siblingCall('LEFT_0', 'LEFT_1'),
      siblingCall('RIGHT_0', 'RIGHT_1'),
    ]);
    assert(siblings.every((result) => result.isError !== true), siblings.map(textOf).join('\n'));
    const siblingResult = await fs.readFile(siblingFile, 'utf8');
    assert(siblingResult.startsWith('LEFT_1\n') && siblingResult.endsWith('\nRIGHT_1\n'),
      'Remote parent did not preserve both same-conversation sibling edits');
    assert(siblings.map((result) => JSON.parse(textOf(result))).some((result) => result.rebasedFromHash === siblingHash),
      'Remote parent did not propagate conversation metadata into the mcp:// mutation lineage');

    console.log('remote escaping e2e: PASS');
  } finally {
    await integration.shutdown().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
