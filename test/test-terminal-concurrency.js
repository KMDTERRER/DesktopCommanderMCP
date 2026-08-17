import assert from 'assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { terminalManager } from '../dist/terminal-manager.js';
import { interactWithProcess, readProcessOutput } from '../dist/tools/improved-process-tools.js';

const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

async function quotedPathProbe() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc terminal quoted-'));
  const script = path.join(root, 'script with spaces.mjs');
  const input = path.join(root, 'input with spaces.txt');
  try {
    await fs.writeFile(script, `import fs from 'node:fs';\nconsole.log(fs.readFileSync(process.argv[2], 'utf8'));\n`, 'utf8');
    await fs.writeFile(input, 'QUOTED_PATH_OK', 'utf8');
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(input)}`;
    const result = await terminalManager.executeCommand(command, 3000, shell, false);
    assert(result.pid > 0, JSON.stringify(result));
    assert(result.output.includes('QUOTED_PATH_OK'), `quoted executable/argument paths were corrupted: ${result.output}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function sharedCursorProbe() {
  const started = await terminalManager.executeCommand(`${JSON.stringify(process.execPath)} -i`, 1000, shell, false);
  assert(started.pid > 0, JSON.stringify(started));
  const pid = started.pid;
  const session = terminalManager.getSession(pid);
  assert(session && session.outputLines.length > 0, 'Node REPL did not expose retained output');

  // Preserve the legacy single-reader contract when reader_id is omitted.
  session.lastReadIndex = 0;
  session.lastReadRevision = 0;
  const legacyFirst = terminalManager.readOutputPaginated(pid, 0, 200);
  const legacySecond = terminalManager.readOutputPaginated(pid, 0, 200);
  assert(legacyFirst && legacySecond);
  const legacyReaders = Number(legacyFirst.readCount > 0) + Number(legacySecond.readCount > 0);

  // Explicit readers must not consume each other's cursor.
  const readerA = terminalManager.readOutputPaginated(pid, 0, 200, 'reader-a');
  const readerB = terminalManager.readOutputPaginated(pid, 0, 200, 'reader-b');
  assert(readerA && readerB);
  const independentReaders = Number(readerA.readCount > 0) + Number(readerB.readCount > 0);

  terminalManager.forceTerminate(pid);
  return { legacyReaders, independentReaders };
}

function paginatedText(result) {
  if (!result) return '';
  const parts = result.continuedLine !== undefined
    ? [result.continuedLine, ...result.lines]
    : [...result.lines];
  if (result.outputChangedWithoutNewLine && result.latestPartialLine !== undefined) parts.push(result.latestPartialLine);
  return parts.join('\n');
}

async function completedCursorTransitionProbe() {
  const started = await terminalManager.executeCommand(`${JSON.stringify(process.execPath)} -i`, 1000, shell, false);
  assert(started.pid > 0, JSON.stringify(started));
  const pid = started.pid;
  assert(terminalManager.sendInputToProcess(pid, `console.log('ACTIVE_A')`));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const legacyActive = terminalManager.readOutputPaginated(pid, 0, 200);
  const namedActive = terminalManager.readOutputPaginated(pid, 0, 200, 'transition-reader');
  assert(paginatedText(legacyActive).includes('ACTIVE_A'), 'legacy active cursor missed initial output');
  assert(paginatedText(namedActive).includes('ACTIVE_A'), 'named active cursor missed initial output');
  const toolActive = await readProcessOutput({ pid, reader_id: 'tool-reader', timeout_ms: 100, stall_timeout_ms: 0, offset: 0, length: 200 });
  assert(toolActive.content?.[0]?.text?.includes('ACTIVE_A'), 'read_process_output cursor missed initial output');

  assert(terminalManager.sendInputToProcess(pid, `console.log('ACTIVE_B')`));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const legacySecondActive = terminalManager.readOutputPaginated(pid, 0, 200);
  const namedSecondActive = terminalManager.readOutputPaginated(pid, 0, 200, 'transition-reader');
  const legacySecondActiveText = paginatedText(legacySecondActive);
  const namedSecondActiveText = paginatedText(namedSecondActive);
  assert(legacySecondActiveText.includes('ACTIVE_B'), 'legacy active cursor lost output appended to its previously-read partial line');
  assert(namedSecondActiveText.includes('ACTIVE_B'), 'named active cursor lost output appended to its previously-read partial line');
  assert(!legacySecondActiveText.includes('ACTIVE_A'), 'legacy active cursor replayed already-consumed output');
  assert(!namedSecondActiveText.includes('ACTIVE_A'), 'named active cursor replayed already-consumed output');
  const toolSecondActive = await readProcessOutput({ pid, reader_id: 'tool-reader', timeout_ms: 100, stall_timeout_ms: 0, offset: 0, length: 200 });
  const toolSecondActiveText = toolSecondActive.content?.[0]?.text ?? '';
  assert(toolSecondActiveText.includes('ACTIVE_B'), 'read_process_output lost output appended to its previously-read partial line');
  assert(!toolSecondActiveText.includes('ACTIVE_A'), 'read_process_output replayed already-consumed active output');

  assert(terminalManager.sendInputToProcess(pid, `console.log('COMPLETE_C')`));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(terminalManager.sendInputToProcess(pid, '.exit'));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const legacyCompleted = terminalManager.readOutputPaginated(pid, 0, 200);
  const namedCompleted = terminalManager.readOutputPaginated(pid, 0, 200, 'transition-reader');
  const legacyCompletedText = paginatedText(legacyCompleted);
  const namedCompletedText = paginatedText(namedCompleted);
  assert(legacyCompletedText.includes('COMPLETE_C'), 'legacy completed cursor missed final output');
  assert(namedCompletedText.includes('COMPLETE_C'), 'named completed cursor missed final output');
  assert(!legacyCompletedText.includes('ACTIVE_B'), 'legacy completed cursor replayed already-consumed output');
  assert(!namedCompletedText.includes('ACTIVE_B'), 'named completed cursor replayed already-consumed output');
  const toolCompleted = await readProcessOutput({ pid, reader_id: 'tool-reader', timeout_ms: 100, stall_timeout_ms: 0, offset: 0, length: 200 });
  const toolCompletedText = toolCompleted.content?.[0]?.text ?? '';
  assert(toolCompletedText.includes('COMPLETE_C'), 'read_process_output completed cursor missed final output');
  assert(!toolCompletedText.includes('ACTIVE_B'), 'read_process_output completed cursor replayed already-consumed output');
  assert.equal(terminalManager.readOutputPaginated(pid, 0, 200)?.readCount, 0, 'legacy completed cursor did not advance');
  assert.equal(terminalManager.readOutputPaginated(pid, 0, 200, 'transition-reader')?.readCount, 0, 'named completed cursor did not advance');
}

async function interactionProbe() {
  const started = await terminalManager.executeCommand(`${JSON.stringify(process.execPath)} -i`, 1000, shell, false);
  assert(started.pid > 0, JSON.stringify(started));
  const pid = started.pid;
  const [a, b] = await Promise.all([
    interactWithProcess({ pid, input: `console.log('INPUT_A')`, timeout_ms: 1200, wait_for_prompt: true }),
    interactWithProcess({ pid, input: `console.log('INPUT_B')`, timeout_ms: 1200, wait_for_prompt: true }),
  ]);
  const at = a.content?.[0]?.text ?? '';
  const bt = b.content?.[0]?.text ?? '';
  console.log(`INTERACT_A_HAS_B=${at.includes('INPUT_B')}`);
  console.log(`INTERACT_B_HAS_A=${bt.includes('INPUT_A')}`);
  terminalManager.forceTerminate(pid);
  return { aHasB: at.includes('INPUT_B'), bHasA: bt.includes('INPUT_A') };
}

await quotedPathProbe();
const cursors = await sharedCursorProbe();
await completedCursorTransitionProbe();
const interactions = await interactionProbe();
assert.equal(cursors.legacyReaders, 1, 'legacy offset=0 must remain a single shared cursor');
assert.equal(cursors.independentReaders, 2, 'reader_id cursors must read retained output independently');
assert.equal(interactions.aHasB, false, 'interaction A saw output from interaction B');
assert.equal(interactions.bHasA, false, 'interaction B saw output from interaction A');
console.log('terminal concurrent readers/interactions: PASS');
