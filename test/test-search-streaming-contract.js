#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configManager } from '../dist/config-manager.js';
import { handleGetMoreSearchResults, handleStartSearch, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { searchFiles } from '../dist/tools/filesystem.js';
import { searchManager } from '../dist/search-manager.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textOf(result) {
  return result.content?.map((item) => item.type === 'text' ? item.text : '').join('\n') ?? '';
}

async function main() {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-dc-search-contract-'));
  const originalAllowed = (await configManager.getConfig()).allowedDirectories;
  let sessionId;
  try {
    await configManager.setValue('allowedDirectories', [root]);
    const lines = Array.from({ length: 200 }, (_, index) => `MARKER deterministic-${index}`);
    await fs.writeFile(path.join(root, 'many.txt'), lines.join('\n'), 'utf8');

    const started = await handleStartSearch({
      path: root, pattern: 'MARKER', searchType: 'content', literalSearch: true,
      maxResults: 25, contextLines: 0, timeout_ms: 5000,
    });
    assert.equal(started.isError, undefined, textOf(started));
    const match = textOf(started).match(/session:\s*(search_[^\s]+)/);
    assert(match, `start_search did not publish a session id: ${textOf(started)}`);
    sessionId = match[1];

    let final;
    for (let attempt = 0; attempt < 100; attempt++) {
      final = await handleGetMoreSearchResults({ sessionId, offset: 0, length: 100 });
      if (textOf(final).includes('✅ Search completed.')) break;
      await sleep(20);
    }
    const finalText = textOf(final);
    assert(finalText.includes('✅ Search completed.'), `search did not complete: ${finalText}`);
    assert(finalText.includes('Total results found: 25 (25 matches)'), finalText);
    assert(finalText.includes('configured global maxResults limit'), 'global result cap was not surfaced at handler boundary');
    assert(!finalText.includes('deterministic-25'), 'handler returned content beyond maxResults');
    assert(Buffer.byteLength(finalText, 'utf8') < 100_000, 'bounded search response unexpectedly grew large');

    const page = await handleGetMoreSearchResults({ sessionId, offset: 10, length: 5 });
    const pageText = textOf(page);
    assert(pageText.includes('Showing results 10-14'), pageText);
    assert.equal((pageText.match(/📄/g) ?? []).length, 5, 'pagination returned the wrong number of results');

    const originalExcelSearch = searchManager.searchExcelFiles.bind(searchManager);
    const auxiliarySessionIds = [];
    try {
      // Model an Office parser that has entered a library call which ignores the
      // SearchManager AbortSignal. A full result set must not wait for it.
      searchManager.searchExcelFiles = async () => new Promise(() => {});
      await fs.writeFile(path.join(root, 'limit.xlsx'), 'AUX_LIMIT_MARKER\n', 'utf8');

      const limitStarted = await handleStartSearch({
        path: root, pattern: 'AUX_LIMIT_MARKER', searchType: 'content', literalSearch: true,
        filePattern: '*.xlsx', maxResults: 1, contextLines: 0, timeout_ms: 5000,
      });
      const limitMatch = textOf(limitStarted).match(/session:\s*(search_[^\s]+)/);
      assert(limitMatch, `limit search did not publish a session id: ${textOf(limitStarted)}`);
      auxiliarySessionIds.push(limitMatch[1]);
      let limitState;
      for (let attempt = 0; attempt < 50; attempt++) {
        limitState = searchManager.readSearchResults(limitMatch[1], 0, 10);
        if (limitState.isComplete) break;
        await sleep(20);
      }
      assert(limitState?.isComplete, 'maxResults search waited for a non-abortable auxiliary provider');
      assert.equal(limitState.limitReached, true, 'limit terminal state was not preserved');

      const deadlineStarted = await handleStartSearch({
        path: root, pattern: 'AUX_NEVER_MATCH', searchType: 'content', literalSearch: true,
        filePattern: '*.xlsx', maxResults: 10, contextLines: 0, timeout_ms: 150,
      });
      const deadlineMatch = textOf(deadlineStarted).match(/session:\s*(search_[^\s]+)/);
      assert(deadlineMatch, `deadline search did not publish a session id: ${textOf(deadlineStarted)}`);
      auxiliarySessionIds.push(deadlineMatch[1]);
      await sleep(250);
      const deadlineState = searchManager.readSearchResults(deadlineMatch[1], 0, 10);
      assert.equal(deadlineState.isComplete, true, 'search deadline waited for a non-abortable auxiliary provider');
      assert.equal(deadlineState.wasIncomplete, true, 'deadline completion did not retain incomplete evidence');
    } finally {
      searchManager.searchExcelFiles = originalExcelSearch;
      for (const id of auxiliarySessionIds) {
        await handleStopSearch({ sessionId: id }).catch(() => undefined);
      }
    }

    const originalStartSearch = searchManager.startSearch.bind(searchManager);
    const originalReadResults = searchManager.readSearchResults.bind(searchManager);
    const originalTerminate = searchManager.terminateSearch.bind(searchManager);
    const observedOffsets = [];
    try {
      searchManager.startSearch = async () => ({
        sessionId: 'compat-probe', isComplete: false, isError: false,
        results: [{ file: 'first.ts', type: 'file' }], totalResults: 1, runtime: 0,
      });
      searchManager.readSearchResults = (_id, offset) => {
        observedOffsets.push(offset);
        return { isComplete: true, results: [{ file: 'second.ts', type: 'file' }], returnedCount: 1 };
      };
      searchManager.terminateSearch = () => true;
      assert.deepEqual(await searchFiles(root, 'ts'), ['first.ts', 'second.ts']);
      assert.deepEqual(observedOffsets, [1], 'compatibility polling reread already-delivered search results');
    } finally {
      searchManager.startSearch = originalStartSearch;
      searchManager.readSearchResults = originalReadResults;
      searchManager.terminateSearch = originalTerminate;
    }

    console.log('search streaming contract: PASS');
  } finally {
    if (sessionId) await handleStopSearch({ sessionId }).catch(() => undefined);
    await configManager.setValue('allowedDirectories', originalAllowed);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
