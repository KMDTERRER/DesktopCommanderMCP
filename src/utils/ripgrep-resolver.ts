import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runBoundedSubprocess } from './bounded-subprocess.js';
import { runWithAbortableTimeout } from './withTimeout.js';

const RIPGREP_RESOLVE_TIMEOUT_MS = 2_000;
const RIPGREP_LOOKUP_MAX_OUTPUT_BYTES = 64 * 1024;
let cachedRgPath: string | null = null;

async function executableExists(candidate: string): Promise<boolean> {
  try {
    const stats = await runWithAbortableTimeout(
      (_signal) => fs.stat(candidate),
      RIPGREP_RESOLVE_TIMEOUT_MS,
      `Resolve ripgrep candidate ${candidate}`,
    );
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve ripgrep binary path with multiple fallback strategies
 * This handles cases where @vscode/ripgrep postinstall fails in npx environments
 */
export async function getRipgrepPath(): Promise<string> {
  if (cachedRgPath) {
    return cachedRgPath;
  }

  // Strategy 1: Try @vscode/ripgrep package
  try {
    const { rgPath } = await import('@vscode/ripgrep');
    if (await executableExists(rgPath)) {
      // Ensure executable permissions on Unix systems without letting a slow
      // filesystem hold start_search before its session deadline exists.
      if (process.platform !== 'win32') {
        await runWithAbortableTimeout(
          (_signal) => fs.chmod(rgPath, 0o755),
          RIPGREP_RESOLVE_TIMEOUT_MS,
          `Make ripgrep executable ${rgPath}`,
        ).catch(() => undefined);
      }
      cachedRgPath = rgPath;
      return rgPath;
    }
  } catch (e) {
    // @vscode/ripgrep import or binary resolution failed, continue to fallbacks
  }

  // Strategy 2: Try system ripgrep using 'which' (Unix) or 'where' (Windows)
  try {
    const systemRg = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const whichCmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const lookup = await runBoundedSubprocess(whichCmd, [systemRg], {
      timeoutMs: RIPGREP_RESOLVE_TIMEOUT_MS,
      maxOutputBytes: RIPGREP_LOOKUP_MAX_OUTPUT_BYTES,
      label: 'Resolve system ripgrep',
    });
    const result = lookup.exitCode === 0 ? lookup.stdout.trim().split(/\r?\n/)[0] : '';
    if (result && await executableExists(result)) {
      cachedRgPath = result;
      return result;
    }
  } catch (e) {
    // System rg not found via which
  }

  // Strategy 3: Try common installation paths
  const commonPaths: string[] = [];

  if (process.platform === 'win32') {
    commonPaths.push(
      'C:\\Program Files\\Ripgrep\\rg.exe',
      'C:\\Program Files (x86)\\Ripgrep\\rg.exe',
      path.join(os.homedir(), 'scoop', 'apps', 'ripgrep', 'current', 'rg.exe'),
      path.join(os.homedir(), '.cargo', 'bin', 'rg.exe')
    );
  } else {
    commonPaths.push(
      '/usr/local/bin/rg',
      '/usr/bin/rg',
      path.join(os.homedir(), '.cargo', 'bin', 'rg'),
      '/opt/homebrew/bin/rg' // Apple Silicon Homebrew
    );
  }

  for (const possiblePath of commonPaths) {
    if (await executableExists(possiblePath)) {
      cachedRgPath = possiblePath;
      return possiblePath;
    }
  }

  // No ripgrep found - provide helpful error message
  throw new Error(
    'ripgrep binary not found. Desktop Commander requires ripgrep to perform searches. ' +
    'Please install ripgrep:\n' +
    '  macOS: brew install ripgrep\n' +
    '  Linux: See https://github.com/BurntSushi/ripgrep#installation\n' +
    '  Windows: choco install ripgrep or download from https://github.com/BurntSushi/ripgrep/releases'
  );
}

/**
 * Clear the cached ripgrep path (useful for testing)
 */
export function clearRipgrepCache(): void {
  cachedRgPath = null;
}
