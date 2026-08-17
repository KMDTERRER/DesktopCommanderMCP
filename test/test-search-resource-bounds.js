#!/usr/bin/env node
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { StartSearchArgsSchema, GetMoreSearchResultsArgsSchema } from '../dist/tools/schemas.js';
import { handleStartSearch, handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { configManager } from '../dist/config-manager.js';
import { SearchManager } from '../dist/search-manager.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sessionIdFrom(result) {
  const match = result.content?.[0]?.text?.match(/session: (search_[^\n]+)/);
  assert(match, `missing search session id: ${result.content?.[0]?.text}`);
  return match[1];
}

async function waitComplete(sessionId) {
  for (let i = 0; i < 60; i++) {
    const result = await handleGetMoreSearchResults({ sessionId, offset: 0, length: 1000 });
    const text = result.content?.[0]?.text ?? '';
    if (text.includes('✅ Search completed')) return text;
    await sleep(50);
  }
  throw new Error('search did not complete');
}
async function main() {
  assert.equal(StartSearchArgsSchema.safeParse({ path: '.', pattern: 'x', maxResults: 10001 }).success, false);
  assert.equal(StartSearchArgsSchema.safeParse({ path: '.', pattern: 'x', contextLines: 21 }).success, false);
  assert.equal(StartSearchArgsSchema.safeParse({ path: '.', pattern: 'x', timeout_ms: 45001 }).success, false);
  assert.equal(StartSearchArgsSchema.safeParse({ path: '.', pattern: 'x', timeout_ms: -1 }).success, false);
  assert.equal(GetMoreSearchResultsArgsSchema.safeParse({ sessionId: 'x', length: 1001 }).success, false);

  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-dc-search-budget-'));
  const original = await configManager.getConfig();
  try {
    await configManager.setValue('allowedDirectories', [root]);
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      fs.writeFile(path.join(root, `file-${index}.txt`), 'needle one\nneedle two\nneedle three\n', 'utf8')));
    const started = await handleStartSearch({
      path: root, pattern: 'needle', searchType: 'content', maxResults: 5, contextLines: 0, timeout_ms: 5000,
    });
    assert.notEqual(started.isError, true, started.content?.[0]?.text);
    const sessionId = sessionIdFrom(started);
    const completed = await waitComplete(sessionId);
    const match = completed.match(/\((\d+) matches\)/);
    assert(match, completed);
    assert(Number(match[1]) <= 5, `global maxResults leaked ${match[1]} matches`);
    await handleStopSearch({ sessionId });

    const manager = new SearchManager();
    manager.searchExcelFiles = async () => {
      await sleep(300);
      return [{ file: path.join(root, 'late.xlsx'), line: 1, match: 'late provider result', type: 'content' }];
    };
    const multiProvider = await manager.startSearch({
      rootPath: root, pattern: 'never-present', searchType: 'content', filePattern: '*.xlsx',
      maxResults: 10, contextLines: 0, timeout: 5000,
    });
    await sleep(100);
    const early = manager.readSearchResults(multiProvider.sessionId, 0, 100);
    assert.equal(early.isComplete, false, 'search reported complete while an auxiliary provider was still running');
    await sleep(300);
    const final = manager.readSearchResults(multiProvider.sessionId, 0, 100);
    assert.equal(final.isComplete, true, 'search never completed after auxiliary provider finished');
    assert(final.results.some((result) => result.match === 'late provider result'));
    manager.terminateSearch(multiProvider.sessionId);

    const timedManager = new SearchManager();
    let auxiliaryAborted = false;
    timedManager.searchExcelFiles = async (...args) => {
      const signal = args.at(-1);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        signal.addEventListener('abort', () => {
          auxiliaryAborted = true;
          clearTimeout(timer);
          const error = new Error('fixture auxiliary search aborted');
          error.code = 'ABORT_ERR';
          reject(error);
        }, { once: true });
      });
      return [];
    };
    const timed = await timedManager.startSearch({
      rootPath: root, pattern: 'never-present', searchType: 'content', filePattern: '*.xlsx',
      maxResults: 10, contextLines: 0, timeout: 100,
    });
    let timedFinal;
    for (let i = 0; i < 20; i++) {
      await sleep(50);
      timedFinal = timedManager.readSearchResults(timed.sessionId, 0, 100);
      if (timedFinal.isComplete) break;
    }
    assert.equal(auxiliaryAborted, true, 'composite search deadline did not abort the Office provider');
    assert.equal(timedFinal?.isComplete, true, 'timed composite search did not reach a terminal state');
    assert.equal(timedFinal?.wasIncomplete, true, 'timed composite search was falsely reported complete');

    // A filesystem metadata call may ignore AbortSignal entirely. The composite
    // search owner must still release pendingAuxiliary when its deadline fires.
    const originalReaddir = fs.readdir;
    const stalledManager = new SearchManager();
    try {
      fs.readdir = async (target, ...args) => {
        if (path.resolve(String(target)) === path.resolve(root)) return new Promise(() => {});
        return originalReaddir(target, ...args);
      };
      const stalled = await stalledManager.startSearch({
        rootPath: root, pattern: 'never-present', searchType: 'content', filePattern: '*.xlsx',
        maxResults: 10, contextLines: 0, timeout: 100,
      });
      let stalledFinal;
      for (let i = 0; i < 20; i++) {
        await sleep(50);
        stalledFinal = stalledManager.readSearchResults(stalled.sessionId, 0, 100);
        if (stalledFinal.isComplete) break;
      }
      assert.equal(stalledFinal?.isComplete, true, 'stalled Office readdir held search completion after deadline');
      assert.equal(stalledFinal?.wasIncomplete, true, 'stalled Office readdir was not marked incomplete');
    } finally {
      fs.readdir = originalReaddir;
    }

    console.log('search resource bounds: PASS');
  } finally {
    await configManager.updateConfig(original);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => { console.error(error); process.exit(1); },
);
