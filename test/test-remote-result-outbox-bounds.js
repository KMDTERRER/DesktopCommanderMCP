#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RemoteResultOutbox } from '../dist/remote-device/result-outbox.js';

function entry(callId, userId, payload = 'ok') {
  return {
    version: 1, callId, userId, claimToken: `claim-${callId}`,
    status: 'completed', result: { payload }, errorMessage: null,
    createdAt: new Date().toISOString(),
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-result-outbox-'));
  try {
    const outbox = new RemoteResultOutbox(root, {
      maxEntryBytes: 1024, maxListBytes: 1400, maxListEntries: 2,
    });
    await outbox.put(entry('a1', 'user-a', 'x'.repeat(350)));
    await outbox.put(entry('b1', 'user-b', 'x'.repeat(350)));
    await outbox.put(entry('a2', 'user-a', 'x'.repeat(350)));
    await outbox.put(entry('a3', 'user-a', 'x'.repeat(350)));

    assert.equal((await outbox.get('a1'))?.callId, 'a1');
    const batch = await outbox.list('user-a');
    assert(batch.length > 0 && batch.length <= 2, `unexpected batch size ${batch.length}`);
    assert(batch.every((item) => item.userId === 'user-a'));

    await assert.rejects(
      () => outbox.put(entry('oversized', 'user-a', 'z'.repeat(2000))),
      (error) => error?.code === 'EFBIG',
      'oversized durable outcome must be rejected before writing the spool file',
    );
    await fs.writeFile(path.join(root, 'corrupt.json'), '{not-json', 'utf8');
    await fs.writeFile(path.join(root, 'oversized-manual.json'), 'q'.repeat(1500), 'utf8');
    await outbox.list('nobody');
    const names = await fs.readdir(root);
    assert(!names.includes('corrupt.json'), 'malformed entry remained in the active replay set');
    assert(!names.includes('oversized-manual.json'), 'oversized entry remained in the active replay set');
    assert(names.some((name) => name.startsWith('corrupt.json.invalid-')),
      'malformed entry was not preserved for forensic recovery');
    assert(names.some((name) => name.startsWith('oversized-manual.json.invalid-')),
      'oversized entry was not preserved for forensic recovery');

    const timeoutRoot = path.join(root, 'io-timeout');
    const timeoutOutbox = new RemoteResultOutbox(timeoutRoot, {
      maxEntryBytes: 1024, maxListBytes: 1024, maxListEntries: 2, ioTimeoutMs: 25,
    });
    const originalWriteFile = fs.writeFile;
    let writeSignal;
    try {
      fs.writeFile = async (file, data, options = {}) => {
        if (String(file).startsWith(timeoutRoot)) {
          writeSignal = options.signal;
          return new Promise((resolve, reject) => {
            if (writeSignal?.aborted) { reject(new Error('aborted')); return; }
            writeSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        return originalWriteFile(file, data, options);
      };
      await assert.rejects(
        () => timeoutOutbox.put(entry('stalled-write', 'user-a')),
        (error) => error?.code === 'ETIMEDOUT',
        'stalled durable spool write must respect the outbox I/O deadline',
      );
      assert.equal(writeSignal?.aborted, true, 'stalled spool write did not receive an aborted signal');
    } finally {
      fs.writeFile = originalWriteFile;
    }

    const originalOpenDir = fs.opendir;
    try {
      fs.opendir = async () => new Promise(() => {});
      await assert.rejects(
        () => timeoutOutbox.list('user-a'),
        (error) => error?.code === 'ETIMEDOUT',
        'stalled outbox enumeration must respect the outbox I/O deadline',
      );
    } finally {
      fs.opendir = originalOpenDir;
    }

    console.log('remote result outbox bounds: PASS');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
