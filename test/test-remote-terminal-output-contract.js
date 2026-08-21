#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const server = path.join(repoRoot, 'dist', 'index.js');
const integration = new DesktopCommanderIntegration();
const conversationMetadata = { conversation_id: 'remote-terminal-output-contract' };
integration.resolveMcpConfig = async () => ({
  command: process.execPath, args: [server, '--no-onboarding'], cwd: repoRoot,
  env: { DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true' },
});

try {
  await integration.initialize();
  const immediate = await integration.callClientTool('start_process', {
    executable: process.execPath,
    args: ['-e', "console.log('REMOTE_START_STRUCTURED')"],
    execution_kind: 'finite', pty: 'never', timeout_ms: 2000,
  }, conversationMetadata);
  assert(immediate.structuredContent?.initialOutput?.includes('REMOTE_START_STRUCTURED'),
    JSON.stringify(immediate.structuredContent));
  assert(!/MCP-STDIO|Notifications disabled/.test(immediate.structuredContent?.initialOutput ?? ''),
    'server/protocol log crossed into managed terminal output');

  const delayed = await integration.callClientTool('start_process', {
    executable: process.execPath,
    args: ['-e', "setTimeout(() => console.log('REMOTE_READ_STRUCTURED'), 60)"],
    execution_kind: 'finite', pty: 'never', timeout_ms: 5,
  }, conversationMetadata);
  const pid = delayed.structuredContent?.pid;
  assert(Number.isInteger(pid) && pid > 0, JSON.stringify(delayed.structuredContent));

  const read = await integration.callClientTool('read_process_output', {
    pid, timeout_ms: 2000, stall_timeout_ms: 0, offset: 0, length: 20,
  }, conversationMetadata);
  assert(read.structuredContent?.output?.includes('REMOTE_READ_STRUCTURED'),
    JSON.stringify(read.structuredContent));
  assert(!/MCP-STDIO|Notifications disabled/.test(read.structuredContent?.output ?? ''),
    'server/protocol log crossed into managed terminal output');
  assert.equal(read.structuredContent?.outputTruncated, false);
  assert.equal(read.structuredContent?.processSucceeded, true);

  console.log('remote terminal output contract: PASS');
} finally {
  await integration.shutdown().catch(() => {});
}
