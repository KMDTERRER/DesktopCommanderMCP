#!/usr/bin/env node
import assert from 'node:assert';

import { startProcess, readProcessOutput } from '../dist/tools/improved-process-tools.js';
import { callBuiltinAcceleratorTool } from '../dist/tools/workspace-accelerators.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

async function runFinite(executable, args) {
  const started = await startProcess({
    executable,
    args,
    execution_kind: 'finite',
    pty: 'never',
    timeout_ms: 5000,
  });
  const pid = started.structuredContent?.pid;
  assert(Number.isInteger(pid) && pid > 0, JSON.stringify(started));

  const waited = await callBuiltinAcceleratorTool('wait_process', {
    pid, timeout_ms: 5000, stall_timeout_ms: 0, tail_lines: 40,
  }, 6000);
  assert.equal(waited.completed, true, JSON.stringify(waited));
  assert.equal(waited.exitCode, 0, JSON.stringify(waited));
  return { started, waited };
}
if (process.platform === 'win32') {
  const cases = [
    ['cmd.exe', ['/d', '/s', '/c', 'echo Привет']],
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Write-Output 'Привет'"]],
    ['pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', "Write-Output 'Привет'"]],
  ];

  for (const [executable, args] of cases) {
    const { started, waited } = await runFinite(executable, args);
    assert(started.content?.[0]?.text?.includes('Привет'), `${executable}: ${started.content?.[0]?.text}`);
    assert.equal(started.structuredContent?.outputDecoding?.mode, 'windows-adaptive', JSON.stringify(started));
    assert(waited.tail.includes('Привет'), `${executable}: ${waited.tail}`);
    assert.equal(waited.outputDecoding?.mode, 'windows-adaptive', JSON.stringify(waited));
    assert(Number.isInteger(waited.outputDecoding?.oemCodePage), JSON.stringify(waited));
    assert(Number.isInteger(waited.outputDecoding?.ansiCodePage), JSON.stringify(waited));
  }

  const mixed = await runFinite('cmd.exe', ['/d', '/s', '/c', 'echo Привет & chcp']);
  assert(mixed.waited.tail.includes('Привет'), mixed.waited.tail);
  assert(/\b\d{3,5}\b/.test(mixed.waited.tail), mixed.waited.tail);
  assert(mixed.waited.outputDecoding?.usedEncodings?.length > 0, JSON.stringify(mixed.waited));
}
const splitScript = [
  "const b = Buffer.from('Привет', 'utf8');",
  'process.stdout.write(b.subarray(0, 3));',
  'setTimeout(() => { process.stdout.write(b.subarray(3)); process.stdout.write("\\n"); }, 25);',
  'setTimeout(() => process.exit(0), 60);',
].join('\n');
const splitStart = await startProcess({
  executable: process.execPath,
  args: ['-e', splitScript],
  execution_kind: 'finite',
  pty: 'never',
  timeout_ms: 5,
});
const splitPid = splitStart.structuredContent?.pid;
assert(Number.isInteger(splitPid) && splitPid > 0, JSON.stringify(splitStart));
const splitRead = await readProcessOutput({
  pid: splitPid, timeout_ms: 1000, stall_timeout_ms: 0, offset: 0, length: 20,
});
assert(splitRead.content?.[0]?.text?.includes('Привет'), JSON.stringify(splitRead));
assert(splitRead.structuredContent?.outputDecoding, JSON.stringify(splitRead));
await callBuiltinAcceleratorTool('wait_process', {
  pid: splitPid, timeout_ms: 5000, stall_timeout_ms: 0, tail_lines: 20,
}, 6000);

console.log('process output encoding: PASS');
