#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const srcRoot = path.join(root, 'src');
const distRoot = path.join(root, 'dist');

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

function sourceCandidates(relative) {
  if (relative.endsWith('.d.ts')) {
    const base = relative.slice(0, -5);
    return [path.join(srcRoot, `${base}.ts`), path.join(srcRoot, `${base}.d.ts`)];
  }
  if (relative.endsWith('.js')) {
    const base = relative.slice(0, -3);
    return [path.join(srcRoot, `${base}.ts`), path.join(srcRoot, `${base}.d.ts`)];
  }
  return [];
}

function outputStem(relative) {
  if (relative.endsWith('.d.ts')) return relative.slice(0, -5);
  if (relative.endsWith('.js')) return relative.slice(0, -3);
  return null;
}

async function collectCompilerStems(dir, stems) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) { await collectCompilerStems(absolute, stems); continue; }
    const relative = path.relative(distRoot, absolute).replace(/\\/g, '/');
    if (relative.endsWith('.d.ts')) stems.add(relative.slice(0, -5));
  }
}

async function prune(dir, compilerStems) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) { await prune(absolute, compilerStems); continue; }
    const relative = path.relative(distRoot, absolute).replace(/\\/g, '/');
    const stem = outputStem(relative);
    if (!stem || !compilerStems.has(stem)) continue;
    const candidates = sourceCandidates(relative);
    let backedBySource = false;
    for (const candidate of candidates) {
      if (await exists(candidate)) { backedBySource = true; break; }
    }
    if (!backedBySource) {
      await fs.unlink(absolute);
      process.stdout.write(`pruned stale TypeScript output: ${relative}\n`);
    }
  }
}

(async () => {
  const compilerStems = new Set();
  await collectCompilerStems(distRoot, compilerStems);
  await prune(distRoot, compilerStems);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
