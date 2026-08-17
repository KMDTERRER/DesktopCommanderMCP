import fs from 'fs/promises';

const WINDOWS_RENAME_RETRY_MS = 1_000;
const WINDOWS_RENAME_RETRY_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);

export interface RenameRetryOptions {
  deadlineAt?: number;
  beforeRetry?: () => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function renameReplacingWithRetry(
  source: string,
  destination: string,
  options: RenameRetryOptions = {},
): Promise<void> {
  const stopAt = Math.min(
    options.deadlineAt ?? Number.POSITIVE_INFINITY,
    Date.now() + WINDOWS_RENAME_RETRY_MS,
  );
  let backoffMs = 0;

  for (;;) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? '';
      if (process.platform !== 'win32' || !WINDOWS_RENAME_RETRY_CODES.has(code) || Date.now() >= stopAt) {
        throw error;
      }

      await sleep(Math.min(backoffMs, Math.max(0, stopAt - Date.now())));
      await options.beforeRetry?.();
      backoffMs = Math.min(backoffMs + 10, 100);
    }
  }
}
