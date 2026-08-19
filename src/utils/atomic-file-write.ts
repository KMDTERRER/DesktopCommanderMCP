import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { renameReplacingWithRetry } from './atomic-rename.js';

export interface AtomicReplaceFileOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

function stagedPath(targetPath: string): string {
  const extension = path.extname(targetPath);
  const stem = path.basename(targetPath, extension);
  return path.join(
    path.dirname(targetPath),
    `.${stem}.${process.pid}.${randomUUID()}.atomic.tmp${extension}`,
  );
}

function throwIfUnavailable(options: AtomicReplaceFileOptions, label: string): void {
  options.signal?.throwIfAborted();
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
    const error = new Error(`${label} deadline exceeded before atomic publish.`) as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
}

export async function atomicReplaceFileBytes(
  targetPath: string, bytes: Uint8Array, options: AtomicReplaceFileOptions = {},
): Promise<void> {
  const tempPath = stagedPath(targetPath);
  let published = false;
  let targetMode: number | undefined;
  try {
    try {
      const stats = await fs.stat(targetPath);
      if (!stats.isFile()) throw new Error(`Atomic replace target is not a file: ${targetPath}`);
      targetMode = stats.mode;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }

    throwIfUnavailable(options, `Write ${targetPath}`);
    await fs.writeFile(tempPath, bytes, {
      flag: 'wx', flush: true, signal: options.signal,
      ...(targetMode === undefined ? {} : { mode: targetMode }),
    });
    throwIfUnavailable(options, `Write ${targetPath}`);
    await renameReplacingWithRetry(tempPath, targetPath, {
      deadlineAt: options.deadlineAt,
      beforeRetry: async () => throwIfUnavailable(options, `Write ${targetPath}`),
    });
    published = true;
  } finally {
    if (!published) await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
