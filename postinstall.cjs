#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const verifyOnly = process.argv.includes('--verify-only');

function runBestEffort(label, scriptPath) {
  if (!fs.existsSync(scriptPath)) return false;
  try {
    execFileSync(process.execPath, [scriptPath], { stdio: 'inherit', cwd: root });
  } catch (error) {
    if (process.env.DC_DEBUG === 'true' || process.env.NODE_ENV === 'development') {
      console.warn(`[Desktop Commander] ${label} failed during install: ${error?.message ?? error}`);
    }
  }
  return true;
}

if (!verifyOnly) {
  const compiledTracker = path.join(root, 'dist', 'track-installation.js');
  const sourceTracker = path.join(root, 'track-installation.js');
  runBestEffort('installation tracking', fs.existsSync(compiledTracker) ? compiledTracker : sourceTracker);
}

const verifier = path.join(root, 'dist', 'npm-scripts', 'verify-ripgrep.js');
const ripgrepVerified = runBestEffort('ripgrep verification', verifier);
if (!ripgrepVerified && verifyOnly) {
  console.error('[Desktop Commander] ripgrep verification failed after build.');
  process.exitCode = 1;
}
