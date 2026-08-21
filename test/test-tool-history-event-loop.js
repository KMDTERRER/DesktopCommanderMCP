import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-history-loop-'));
const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;

try {
  const { ToolHistory } = await import('../dist/utils/toolHistory.js');
  const history = new ToolHistory();
  history.addCall('probe', { value: 1 }, { content: [{ type: 'text', text: 'ok' }] }, 1);

  let syncTrimCalled = false;
  history.trimHistoryFileIfTooLarge = () => {
    syncTrimCalled = true;
    const until = Date.now() + 150;
    while (Date.now() < until) {}
    return false;
  };

  let timerFiredAt = 0;
  const startedAt = Date.now();
  const timer = new Promise((resolve) => setTimeout(() => { timerFiredAt = Date.now(); resolve(); }, 20));
  await history.flushToDisk();
  await timer;

  assert.equal(syncTrimCalled, false, 'background history flush still uses synchronous disk work');
  assert(timerFiredAt - startedAt < 100, `history flush blocked the event loop for ${timerFiredAt - startedAt}ms`);
  await history.cleanup();
  console.log('tool history event-loop regression: PASS');
} finally {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
}
