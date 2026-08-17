import fs from 'fs/promises';
import path from 'path';

import { runWithAbortableTimeout } from './withTimeout.js';

export type ConfiguredExecutableInspection = {
  path: string | null;
  trusted: boolean;
  reason?: string;
};

export type ConfiguredExecutableOptions = {
  repositoryRoot: string;
  buildDir: string;
  deadlineAt: number;
  label: string;
  expectedNames?: readonly string[];
  projectLocalPolicy?: 'allow' | 'reject';
};

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function remaining(deadlineAt: number, label: string): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error(`${label} deadline exceeded.`) as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return Math.max(1, Math.min(10_000, value));
}

export async function inspectConfiguredExecutable(
  value: unknown, options: ConfiguredExecutableOptions,
): Promise<ConfiguredExecutableInspection> {
  const { repositoryRoot, buildDir, deadlineAt, label } = options;
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    return { path: null, trusted: false, reason: `${label} is unavailable or not absolute.` };
  }
  let canonical: string;
  try {
    canonical = await runWithAbortableTimeout(
      (_signal) => fs.realpath(value), remaining(deadlineAt, `${label} resolution`), `Resolve ${label} ${value}`,
    );
  } catch (error) {
    return {
      path: null, trusted: false,
      reason: `${label} could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const normalizedExpected = options.expectedNames?.map((name) => name.toLowerCase().replace(/\.exe$/, ''));
  const basename = path.basename(canonical).toLowerCase().replace(/\.exe$/, '');
  if (normalizedExpected?.length && !normalizedExpected.includes(basename)) {
    return { path: canonical, trusted: false, reason: `${label} has unexpected executable name '${path.basename(canonical)}'.` };
  }
  if (options.projectLocalPolicy !== 'allow' && (isInside(repositoryRoot, canonical) || isInside(buildDir, canonical))) {
    return {
      path: canonical, trusted: false,
      reason: `${label} resolves inside the repository/build tree and is not trusted as a configured tool executable.`,
    };
  }
  try {
    const stats = await runWithAbortableTimeout(
      (_signal) => fs.stat(canonical), remaining(deadlineAt, `${label} stat`), `Stat ${label} ${canonical}`,
    );
    if (!stats.isFile()) return { path: canonical, trusted: false, reason: `${label} is not a file: ${canonical}` };
  } catch (error) {
    return {
      path: canonical, trusted: false,
      reason: `${label} could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { path: canonical, trusted: true };
}

export async function requireConfiguredExecutable(
  value: unknown, options: ConfiguredExecutableOptions,
): Promise<string> {
  const result = await inspectConfiguredExecutable(value, options);
  if (!result.trusted || !result.path) throw new Error(result.reason ?? `${options.label} is not trusted.`);
  return result.path;
}
