import assert from 'node:assert/strict';
import {
  forceTerminate, interactWithProcess, listSessions, readProcessOutput, startProcess,
} from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { runInToolCallContext } from '../dist/utils/client-context.js';
import { callBuiltinAcceleratorTool } from '../dist/tools/workspace-accelerators.js';

const remoteCall = (conversationId, operation) => runInToolCallContext({
  isRemote: true,
  remoteClient: { name: 'binding-test', version: '1' },
  requestMetadata: conversationId ? { conversation_id: conversationId } : {},
}, operation);

let ownedPid;
let unscopedPid;
try {
  const started = await remoteCall('conversation-a', () => startProcess({
    executable: process.execPath,
    args: ['-i'],
    execution_kind: 'interactive',
    pty: 'never',
    timeout_ms: 1500,
  }));
  ownedPid = started.structuredContent?.pid;
  const ownedSessionId = started.structuredContent?.terminalSessionId;
  assert(Number.isInteger(ownedPid) && ownedPid > 0, JSON.stringify(started));
  assert.match(ownedSessionId, /^[0-9a-f-]{36}$/i);

  const crossWrite = await remoteCall('conversation-b', () => interactWithProcess({
    pid: ownedPid,
    input: 'globalThis.CROSS_SESSION_WRITE = 1',
    timeout_ms: 300,
  }));
  assert.equal(crossWrite.isError, true, 'a different conversation wrote to the managed terminal by PID');

  const crossRead = await remoteCall('conversation-b', () => readProcessOutput({
    pid: ownedPid,
    timeout_ms: 0,
    stall_timeout_ms: 0,
    offset: -1,
    length: 10,
  }));
  assert.equal(crossRead.isError, true, 'a different conversation read the managed terminal by PID');

  const crossStop = await remoteCall('conversation-b', () => forceTerminate({ pid: ownedPid }));
  assert.equal(crossStop.isError, true, 'a different conversation terminated the managed terminal by PID');
  assert(terminalManager.getSession(ownedPid), 'denied termination still stopped the owner session');

  let crossWaitError;
  try {
    await remoteCall('conversation-b', () => callBuiltinAcceleratorTool('wait_process', {
      pid: ownedPid, timeout_ms: 0, stall_timeout_ms: 0, tail_lines: 10,
    }));
  } catch (error) { crossWaitError = error; }
  assert.match(crossWaitError?.message ?? '', /not available to this remote conversation/, 'wait_process bypassed terminal ownership');

  const ownerProbe = await remoteCall('conversation-a', () => interactWithProcess({
    pid: ownedPid,
    input: "console.log(typeof globalThis.CROSS_SESSION_WRITE)",
    timeout_ms: 1200,
  }));
  assert.equal(ownerProbe.isError, undefined, JSON.stringify(ownerProbe));
  assert.match(ownerProbe.content?.[0]?.text ?? '', /undefined/, 'denied cross-session input reached stdin');

  const listA = await remoteCall('conversation-a', () => listSessions());
  const listB = await remoteCall('conversation-b', () => listSessions());
  assert(listA.structuredContent?.sessions?.some((session) => session.pid === ownedPid), 'owner cannot list its terminal');
  assert(!listB.structuredContent?.sessions?.some((session) => session.pid === ownedPid), 'foreign terminal leaked through list_sessions');

  const delegatedRead = await remoteCall('conversation-b', () => readProcessOutput({
    pid: ownedPid,
    terminal_session_id: ownedSessionId,
    timeout_ms: 0,
    stall_timeout_ms: 0,
    offset: -1,
    length: 10,
  }));
  assert.equal(delegatedRead.isError, undefined, 'exact opaque terminal session id did not authorize explicit access');

  const unscoped = await remoteCall(undefined, () => startProcess({
    executable: process.execPath,
    args: ['-i'],
    execution_kind: 'interactive',
    pty: 'never',
    timeout_ms: 1500,
  }));
  unscopedPid = unscoped.structuredContent?.pid;
  const unscopedSessionId = unscoped.structuredContent?.terminalSessionId;
  assert(Number.isInteger(unscopedPid) && unscopedPid > 0, JSON.stringify(unscoped));

  const missingToken = await remoteCall(undefined, () => interactWithProcess({
    pid: unscopedPid,
    input: "console.log('MUST_NOT_RUN')",
    timeout_ms: 300,
  }));
  assert.equal(missingToken.isError, true, 'unscoped remote input was accepted without a terminal session id');

  const tokenWrite = await remoteCall(undefined, () => interactWithProcess({
    pid: unscopedPid,
    terminal_session_id: unscopedSessionId,
    input: "console.log('TOKEN_WRITE_OK')",
    timeout_ms: 1200,
  }));
  assert.equal(tokenWrite.isError, undefined, JSON.stringify(tokenWrite));
  assert.match(tokenWrite.content?.[0]?.text ?? '', /TOKEN_WRITE_OK/);

  console.log('terminal session binding: PASS');
} finally {
  if (ownedPid) await terminalManager.forceTerminate(ownedPid).catch(() => {});
  if (unscopedPid) await terminalManager.forceTerminate(unscopedPid).catch(() => {});
}
