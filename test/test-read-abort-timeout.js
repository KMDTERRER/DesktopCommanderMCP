import assert from 'assert';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import http from 'http';
import { runWithAbortableTimeout } from '../dist/utils/withTimeout.js';
import {
  READ_OPERATION_TIMEOUT_MS, READ_METADATA_TIMEOUT_MS, WRITE_OPERATION_TIMEOUT_MS,
  readFile, writeFile, getFileInfo,
} from '../dist/tools/filesystem.js';
import { configManager } from '../dist/config-manager.js';

/**
 * Regression tests for the abortable, 3-minute read timeout.
 *
 * Follow-up to the parallel-load hang fix: withTimeout() rejected on a timer
 * but left the underlying fs op running, holding its libuv thread until the OS
 * call returned. runWithAbortableTimeout() passes an AbortSignal into the op
 * and aborts it on timeout. The read timeout is a flat 3 minutes, chosen to sit
 * below the MCP client's ~4-minute hard cap so we abort + return a useful error
 * before the client reports an opaque timeout.
 */

let passed = 0;
const ok = (msg) => { passed++; console.log(`✓ ${msg}`); };

async function run() {
  // 1) A fast operation resolves normally and is NOT aborted.
  {
    let sawSignal;
    const val = await runWithAbortableTimeout(async (signal) => {
      sawSignal = signal;
      return 'done';
    }, 1000, 'fast op');
    assert.strictEqual(val, 'done');
    assert.strictEqual(sawSignal.aborted, false);
    ok('fast operation resolves and signal is not aborted');
  }

  // 2) A slow operation times out with code ETIMEDOUT AND its signal is aborted
  //    (this is the "cleanup" — the op is told to stop, not just abandoned).
  {
    let sawSignal;
    let err;
    try {
      await runWithAbortableTimeout((signal) => {
        sawSignal = signal;
        // Never settles on its own — only the timeout's abort should end the
        // race (mirrors a real fs read, which rejects asynchronously after
        // abort, so the ETIMEDOUT rejection wins).
        return new Promise(() => {});
      }, 100, 'slow op');
      assert.fail('expected timeout rejection');
    } catch (e) {
      err = e;
    }
    assert.strictEqual(err.code, 'ETIMEDOUT', `expected ETIMEDOUT, got ${err.code}`);
    assert.strictEqual(sawSignal.aborted, true, 'operation signal must be aborted on timeout');
    ok('slow operation rejects ETIMEDOUT and aborts the operation signal');
  }

  // 3) The read timeout is 3 minutes — safely below the client's ~4-min cap.
  {
    assert.strictEqual(READ_OPERATION_TIMEOUT_MS, 3 * 60 * 1000, 'read timeout must be 3 minutes');
    assert.ok(READ_OPERATION_TIMEOUT_MS < 4 * 60 * 1000, 'must stay below the ~4-min client cap');
    ok('read timeout is 3 minutes, below the client hard cap');
  }

  // 4) Metadata has its own short deadline before the main 3-minute read.
  {
    assert.strictEqual(READ_METADATA_TIMEOUT_MS, 10 * 1000, 'metadata timeout must be 10 seconds');
    ok('read metadata timeout is 10 seconds');
  }

  // 5) Integration: a normal read still works end-to-end (signal threading did
  //    not break the happy path). Hermetic: uses its own temp dir + allowed-dir
  //    config so it doesn't depend on the ambient allowedDirectories, and
  //    restores config afterward.
  {
    const original = await configManager.getConfig();
    const originalAllowed = original.allowedDirectories;
    // realpath so the allowed dir matches what validatePath resolves the file
    // to (e.g. macOS /tmp -> /private/tmp), avoiding a symlink mismatch.
    const tmpDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-read-abort-')));
    const tmpFile = path.join(tmpDir, 'sample.txt');
    await fsp.writeFile(tmpFile, 'line1\nMARKER runWithAbortableTimeout\nline3\n');
    try {
      await configManager.setValue('allowedDirectories', [tmpDir]);
      const res = await readFile(tmpFile, { offset: 0, length: 5 });
      const text = typeof res.content === 'string' ? res.content : res.content.toString('utf8');
      assert.ok(text.includes('MARKER runWithAbortableTimeout'), 'normal read returns file content');
      ok('normal read_file still works with the signal threaded through');
    } finally {
      await configManager.setValue('allowedDirectories', originalAllowed);
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }

  // 6) A never-resolving metadata stat is bounded before the main read starts.
  {
    const original = await configManager.getConfig();
    const originalAllowed = original.allowedDirectories;
    const tmpDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-read-metadata-')));
    const tmpFile = path.join(tmpDir, 'sample.txt');
    await fsp.writeFile(tmpFile, 'metadata timeout probe\n');
    const originalStat = fsp.stat;
    const originalSetTimeout = globalThis.setTimeout;
    let statCalls = 0;
    try {
      await configManager.setValue('allowedDirectories', [tmpDir]);
      fsp.stat = async (...args) => {
        statCalls++;
        if (statCalls === 1) {
          const value = await originalStat(...args);
          globalThis.setTimeout = (callback, ms, ...timerArgs) =>
            originalSetTimeout(callback, ms === READ_METADATA_TIMEOUT_MS ? 25 : ms, ...timerArgs);
          return value;
        }
        return new Promise(() => {});
      };

      const started = Date.now();
      let err;
      try {
        await readFile(tmpFile, { offset: 0, length: 5 });
        assert.fail('expected metadata timeout');
      } catch (e) {
        err = e;
      }
      const elapsed = Date.now() - started;
      assert.ok(String(err?.message).includes('ETIMEDOUT'), `expected ETIMEDOUT guidance, got: ${err?.message}`);
      assert.ok(elapsed < 1000, `metadata timeout test took too long: ${elapsed}ms`);
      assert.ok(statCalls >= 2, `expected validation + metadata stat, got ${statCalls}`);
      ok('never-resolving metadata stat is bounded before the main read');
    } finally {
      fsp.stat = originalStat;
      globalThis.setTimeout = originalSetTimeout;
      await configManager.setValue('allowedDirectories', originalAllowed);
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }
  // 7) get_file_info must not hang forever on the same stalled metadata path.
  {
    const original = await configManager.getConfig();
    const originalAllowed = original.allowedDirectories;
    const tmpDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-info-metadata-')));
    const tmpFile = path.join(tmpDir, 'sample.txt');
    await fsp.writeFile(tmpFile, 'info timeout probe\n');
    const originalStat = fsp.stat;
    const originalSetTimeout = globalThis.setTimeout;
    let statCalls = 0;
    try {
      await configManager.setValue('allowedDirectories', [tmpDir]);
      fsp.stat = async (...args) => {
        statCalls++;
        if (statCalls === 1) return originalStat(...args);
        return new Promise(() => {});
      };
      globalThis.setTimeout = (callback, ms, ...timerArgs) =>
        originalSetTimeout(callback, ms === READ_METADATA_TIMEOUT_MS ? 25 : ms, ...timerArgs);

      const outcome = await Promise.race([
        getFileInfo(tmpFile).then(() => 'settled', () => 'settled'),
        new Promise((resolve) => originalSetTimeout(() => resolve('hung'), 500)),
      ]);
      assert.strictEqual(outcome, 'settled', 'get_file_info remained unbounded on stalled fs.stat');
      ok('get_file_info metadata stat is bounded');
    } finally {
      fsp.stat = originalStat;
      globalThis.setTimeout = originalSetTimeout;
      await configManager.setValue('allowedDirectories', originalAllowed);
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }

  // 8) PDF URL reads must download the body once, then parse the captured bytes.
  //    The old path fetched once for MIME detection and a second time in pdf2md.
  {
    const pdfBytes = await fsp.readFile(new URL('./samples/01_sample_simple.pdf', import.meta.url));
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': String(pdfBytes.length),
      });
      res.end(pdfBytes);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try {
      const result = await readFile(`http://127.0.0.1:${address.port}/sample.pdf`, { isUrl: true });
      assert.strictEqual(result.metadata?.isPdf, true, 'URL PDF was not parsed as PDF');
      assert.strictEqual(requests, 1, `URL PDF body was downloaded ${requests} times`);
      ok('URL PDF is downloaded once and parsed from the captured bytes');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  // 9) The URL timeout must remain active through response body consumption.
  //    Headers alone do not complete fetch: a stalled body must still abort.
  {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('headers-and-prefix');
      // Intentionally never end the body.
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/stall`;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...timerArgs) =>
      originalSetTimeout(callback, ms === 30_000 ? 50 : ms, ...timerArgs);
    const observed = readFile(url, { isUrl: true }).then(
      () => ({ kind: 'resolved' }),
      (error) => ({ kind: 'rejected', error }),
    );
    try {
      const outcome = await Promise.race([
        observed,
        new Promise((resolve) => originalSetTimeout(() => resolve({ kind: 'hung' }), 500)),
      ]);
      assert.notStrictEqual(outcome.kind, 'hung', 'URL body remained unbounded after headers arrived');
      assert.strictEqual(outcome.kind, 'rejected', 'stalled URL body unexpectedly resolved');
      assert.ok(String(outcome.error?.message).includes('timed out'), `unexpected URL timeout error: ${outcome.error?.message}`);
      ok('URL fetch timeout remains active until the response body is consumed');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await Promise.race([observed, new Promise((resolve) => originalSetTimeout(resolve, 500))]);
    }
  }

  // 10) Even when AbortController.abort() is ineffective, the JS hard deadline
  //     must release a request that connected but never receives HTTP headers.
  {
    const server = http.createServer((_req, _res) => {
      // Intentionally never send headers or a body.
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/no-headers`;
    const RealAbortController = globalThis.AbortController;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.AbortController = class {
      constructor() { this.real = new RealAbortController(); this.signal = this.real.signal; }
      abort() { /* simulate a runtime/network stack that ignores abort */ }
    };
    globalThis.setTimeout = (callback, ms, ...timerArgs) =>
      originalSetTimeout(callback, ms === 30_000 ? 50 : ms, ...timerArgs);
    const observed = readFile(url, { isUrl: true }).then(
      () => ({ kind: 'resolved' }),
      (error) => ({ kind: 'rejected', error }),
    );
    try {
      const outcome = await Promise.race([
        observed,
        new Promise((resolve) => originalSetTimeout(() => resolve({ kind: 'hung' }), 500)),
      ]);
      assert.notStrictEqual(outcome.kind, 'hung', 'URL fetch escaped the JS hard deadline when abort was ineffective');
      assert.strictEqual(outcome.kind, 'rejected', 'never-settling URL request unexpectedly resolved');
      assert.ok(String(outcome.error?.message).includes('timed out'), `unexpected hard timeout error: ${outcome.error?.message}`);
      ok('URL fetch has a JS hard deadline even when AbortController is ineffective');
    } finally {
      globalThis.AbortController = RealAbortController;
      globalThis.setTimeout = originalSetTimeout;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await Promise.race([observed, new Promise((resolve) => originalSetTimeout(resolve, 500))]);
    }
  }

  // 11) A stalled staged write must time out without ever modifying the target.
  {
    const original = await configManager.getConfig();
    const originalAllowed = original.allowedDirectories;
    const tmpDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-write-atomic-timeout-')));
    const target = path.join(tmpDir, 'fallback.txt');
    await fsp.writeFile(target, 'ORIGINAL\n', 'utf8');
    const originalWriteFile = fsp.writeFile;
    const originalSetTimeout = globalThis.setTimeout;
    let stagedWriteSignal;
    try {
      await configManager.setValue('allowedDirectories', [tmpDir]);
      fsp.writeFile = async (file, data, options = {}) => {
        if (String(file).includes('.write.tmp') && data === 'replacement-that-must-not-commit') {
          stagedWriteSignal = options.signal;
          return new Promise((_resolve, reject) => {
            const abort = () => reject(stagedWriteSignal?.reason ?? new Error('aborted'));
            if (stagedWriteSignal?.aborted) abort();
            else stagedWriteSignal?.addEventListener('abort', abort, { once: true });
          });
        }
        return originalWriteFile(file, data, options);
      };
      globalThis.setTimeout = (callback, ms, ...timerArgs) =>
        originalSetTimeout(callback, ms > 170_000 && ms <= WRITE_OPERATION_TIMEOUT_MS ? 50 : ms, ...timerArgs);

      let error;
      try {
        await writeFile(target, 'replacement-that-must-not-commit', 'rewrite');
        assert.fail('expected staged write timeout');
      } catch (caught) {
        error = caught;
      }
      assert.equal(error?.code, 'ETIMEDOUT', `unexpected staged write error: ${error?.message}`);
      assert.equal(stagedWriteSignal?.aborted, true, 'staged file write did not receive AbortSignal cancellation');
      assert.equal(await fsp.readFile(target, 'utf8'), 'ORIGINAL\n', 'timed-out rewrite modified the target');
      await new Promise((resolve) => originalSetTimeout(resolve, 50));
      const leftovers = (await fsp.readdir(tmpDir)).filter((name) => name.includes('.write.tmp'));
      assert.deepEqual(leftovers, [], `staged write leaked temporary files: ${leftovers.join(', ')}`);
      ok('timed-out staged write preserves the original target and cancels staged I/O');
    } finally {
      fsp.writeFile = originalWriteFile;
      globalThis.setTimeout = originalSetTimeout;
      await configManager.setValue('allowedDirectories', originalAllowed);
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }

  // 12) Base write_file rewrite+append remains directly readable without semantic/external services.
  {
    const original = await configManager.getConfig();
    const originalAllowed = original.allowedDirectories;
    const tmpDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-write-fallback-')));
    const target = path.join(tmpDir, 'fallback.txt');
    try {
      await configManager.setValue('allowedDirectories', [tmpDir]);
      await writeFile(target, 'first\n', 'rewrite');
      await writeFile(target, 'second\n', 'append');
      assert.equal(await fsp.readFile(target, 'utf8'), 'first\nsecond\n');
      const result = await readFile(target, { offset: 0, length: 10, includeStatusMessage: false });
      const text = typeof result.content === 'string' ? result.content : result.content.toString('utf8');
      assert(text.includes('first') && text.includes('second'), `base read lost written content: ${text}`);
      assert.deepEqual((await fsp.readdir(tmpDir)).filter((name) => name.includes('.write.tmp')), []);
      ok('base write_file rewrite and append stay readable through the base read path');
    } finally {
      await configManager.setValue('allowedDirectories', originalAllowed);
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }

  // 13) Unsupported binary/document append modes must fail closed, never report false success.
  {
    const original = await configManager.getConfig();
    const originalAllowed = original.allowedDirectories;
    const tmpDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-write-append-contract-')));
    const imagePath = path.join(tmpDir, 'fallback.png');
    const pdfPath = path.join(tmpDir, 'fallback.pdf');
    await fsp.writeFile(imagePath, Buffer.from('IMAGE_ORIGINAL'));
    await fsp.writeFile(pdfPath, Buffer.from('PDF_ORIGINAL'));
    try {
      await configManager.setValue('allowedDirectories', [tmpDir]);
      await assert.rejects(
        () => writeFile(imagePath, 'eA==', 'append'),
        /Image append is not supported/,
      );
      await assert.rejects(
        () => writeFile(pdfPath, '# must not append', 'append'),
        /PDF append is not supported/,
      );
      assert.equal((await fsp.readFile(imagePath)).toString(), 'IMAGE_ORIGINAL');
      assert.equal((await fsp.readFile(pdfPath)).toString(), 'PDF_ORIGINAL');
      assert.deepEqual((await fsp.readdir(tmpDir)).filter((name) => name.includes('.write.tmp')), []);
      ok('unsupported image/PDF append fails closed without modifying the target');
    } finally {
      await configManager.setValue('allowedDirectories', originalAllowed);
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }
}

run()
  .then(() => { console.log(`\nPASS (${passed}/13)`); process.exit(0); })
  .catch((e) => { console.error(`\nFAIL: ${e.message}`); process.exit(1); });
