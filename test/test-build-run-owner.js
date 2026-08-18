import assert from 'assert';
import os from 'os';
import path from 'path';

import { BuildRunOwner } from '../dist/tools/build-run-owner.js';
import {
  startDetachedBuildProcess, waitDetachedBuildProcess, terminateDetachedBuildProcess,
} from '../dist/tools/detached-build-process.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const owner = new BuildRunOwner();
  let releaseOperation;
  const gate = new Promise((resolve) => { releaseOperation = resolve; });
  const started = owner.start('unit-run', async (hooks) => {
    hooks.onPid(12345);
    await gate;
    return { ok: true };
  });
  assert.equal(started.status, 'running');
  await sleep(0);
  assert.deepEqual(owner.get(started.buildRunId).pids, [12345]);
  const stillRunning = await owner.wait(started.buildRunId, 20);
  assert.equal(stillRunning.status, 'running');
  releaseOperation();
  const completed = await owner.wait(started.buildRunId, 1000);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, { ok: true });

  const failed = owner.start('failed-run', async () => { throw new Error('owned failure'); });
  const failedResult = await owner.wait(failed.buildRunId, 1000);
  assert.equal(failedResult.status, 'failed');
  assert.match(failedResult.error, /owned failure/);

  const detached = await startDetachedBuildProcess({
    executable: process.execPath,
    args: ['-e', "setTimeout(() => { console.log('DETACHED_OK'); }, 1500)"],
    cwd: path.resolve(os.tmpdir()), execution_kind: 'finite', pty: 'never',
  });
  assert.equal(detached.isError, undefined);
  const pid = detached.structuredContent.pid;
  assert(Number.isInteger(pid) && pid > 0);
  const early = await waitDetachedBuildProcess({ pid, timeout_ms: 25, stall_timeout_ms: 0, tail_lines: 20 });
  assert.equal(early.completed, false);
  assert.equal(early.timedOut, true);
  const done = await waitDetachedBuildProcess({ pid, timeout_ms: 2000, stall_timeout_ms: 0, tail_lines: 20 });
  assert.equal(done.completed, true);
  assert.equal(done.processSucceeded, true);
  assert.match(done.tail, /DETACHED_OK/);

  const long = await startDetachedBuildProcess({
    executable: process.execPath,
    args: ['-e', "setInterval(() => {}, 1000)"],
    cwd: path.resolve(os.tmpdir()), execution_kind: 'finite', pty: 'never',
  });
  const longPid = long.structuredContent.pid;
  assert.equal(await terminateDetachedBuildProcess(longPid, 'client_cancelled', 'test cleanup'), true);
  const terminated = await waitDetachedBuildProcess({ longPid, pid: longPid, timeout_ms: 5000, stall_timeout_ms: 0, tail_lines: 20 });
  assert.equal(terminated.completed, true);
  assert.equal(terminated.processSucceeded, false);

  console.log('build run owner tests: PASS');
}

main().catch((error) => { console.error(error); process.exit(1); });
