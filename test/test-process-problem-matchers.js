#!/usr/bin/env node
import assert from 'node:assert';

import { matchProcessProblems } from '../dist/utils/process-problem-matcher.js';
import { startProcess, readProcessOutput } from '../dist/tools/improved-process-tools.js';
import { callBuiltinAcceleratorTool } from '../dist/tools/workspace-accelerators.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const fixture = [
  "C:/repo/main.cpp:12:7: error: expected ';' after expression",
  "src/lib.cpp:4:2: warning: unused variable 'x' [-Wunused-variable]",
  "C:\\repo\\win.cpp(8,3): error C2065: 'value': undeclared identifier",
  "LINK : fatal error LNK1104: cannot open file 'missing.lib'",
  'CMake Error at CMakeLists.txt:10 (message):',
  '  broken configuration',
  "ninja: error: loading 'build.ninja': No such file or directory",
  '1/2 Test #1: smoke ................***Failed    0.01 sec',
].join('\n');

const matched = matchProcessProblems(fixture);
assert.equal(matched.problems.length, 7, JSON.stringify(matched, null, 2));
assert.equal(matched.problems[0].matcher, 'gcc-clang');
assert.equal(matched.problems[0].file, 'C:/repo/main.cpp');
assert.equal(matched.problems[0].line, 12);
assert.equal(matched.problems[0].column, 7);
assert.equal(matched.problems[2].matcher, 'msvc');
assert.equal(matched.problems[2].code, 'C2065');
assert.equal(matched.problems[3].matcher, 'linker');
assert.equal(matched.problems[3].code, 'LNK1104');
assert.equal(matched.problems[4].matcher, 'cmake');
assert.equal(matched.problems[4].message, 'broken configuration');
assert.equal(matched.problems[5].matcher, 'ninja');
assert.equal(matched.problems[6].matcher, 'ctest');
assert.equal(matched.problems[6].code, 'CTEST_FAILED');
assert.equal(matched.truncated, false);

const ansi = matchProcessProblems('\x1b[31msrc/ansi.cpp:3:1: error: red\x1b[0m');
assert.equal(ansi.problems.length, 1);
assert.equal(ansi.problems[0].file, 'src/ansi.cpp');
assert.equal(ansi.problems[0].message, 'red');

const falsePositive = matchProcessProblems('Error: ordinary application message\nall good');
assert.deepEqual(falsePositive.problems, []);

const many = matchProcessProblems(Array.from(
  { length: 60 }, (_, index) => `src/a.cpp:${index + 1}:1: error: issue ${index}`
).join('\n'));
assert.equal(many.problems.length, 50);
assert.equal(many.truncated, true);
const longPrefix = 'x'.repeat(600 * 1024);
const bounded = matchProcessProblems(`${longPrefix}\nsrc/tail.cpp:5:4: warning: tail survives`);
assert.equal(bounded.truncated, true);
assert.equal(bounded.problems.at(-1)?.file, 'src/tail.cpp');

const script = [
  "setTimeout(() => {",
  "  console.error('src/live.cpp:9:2: error: live failure');",
  "  setTimeout(() => process.exit(3), 30);",
  "}, 40);",
].join('\n');

const started = await startProcess({
  executable: process.execPath,
  args: ['-e', script],
  execution_kind: 'finite',
  pty: 'never',
  timeout_ms: 5,
});
const pid = started.structuredContent?.pid;
assert(Number.isInteger(pid) && pid > 0, JSON.stringify(started));
assert.equal(started.structuredContent?.processSucceeded, null);

const read = await readProcessOutput({
  pid, timeout_ms: 1000, stall_timeout_ms: 0, offset: 0, length: 20,
});
assert.equal(read.structuredContent?.problems?.[0]?.file, 'src/live.cpp', JSON.stringify(read));
const waited = await callBuiltinAcceleratorTool('wait_process', {
  pid, timeout_ms: 5000, stall_timeout_ms: 0, tail_lines: 20,
}, 6000);
assert.equal(waited.completed, true, JSON.stringify(waited));
assert.equal(waited.exitCode, 3);
assert.equal(waited.processSucceeded, false);
assert.equal(waited.problems?.[0]?.matcher, 'gcc-clang', JSON.stringify(waited));
assert.equal(waited.problems?.[0]?.line, 9);
assert.equal(waited.problems?.[0]?.column, 2);

console.log('process problem matchers: PASS');
