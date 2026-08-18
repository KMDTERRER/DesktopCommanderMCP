import path from 'path';

export const MANAGED_TRASH_DIRECTORY_NAME = '.desktop-commander-trash';
export const MANAGED_TRASH_ENTRIES_DIRECTORY_NAME = 'entries';
export const MANAGED_TRASH_RETENTION_MS = 20 * 60 * 1000;
export const MANAGED_TRASH_SWEEP_INTERVAL_MS = 30 * 1000;
export const MANAGED_TRASH_ENTRY_NAME = /^tr_[a-f0-9]{32}$/;

export function pathContainsManagedTrashSegment(value: string): boolean {
  const normalized = path.normalize(value);
  const parts = normalized.split(path.sep).filter(Boolean);
  return parts.some((part) => process.platform === 'win32'
    ? part.toLowerCase() === MANAGED_TRASH_DIRECTORY_NAME.toLowerCase()
    : part === MANAGED_TRASH_DIRECTORY_NAME);
}

export function isManagedTrashRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === MANAGED_TRASH_DIRECTORY_NAME
    || normalized.startsWith(`${MANAGED_TRASH_DIRECTORY_NAME}/`);
}
