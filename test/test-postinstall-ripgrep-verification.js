import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '..');
const postinstall = path.join(root, 'postinstall.cjs');

const healthy = spawnSync(process.execPath, [postinstall, '--verify-only'], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(healthy.status, 0, healthy.stderr || healthy.stdout);
assert.match(`${healthy.stdout}${healthy.stderr}`, /ripgrep found at:/i);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-postinstall-rg-'));
try {
  fs.copyFileSync(postinstall, path.join(tempRoot, 'postinstall.cjs'));
  const missingVerifier = spawnSync(process.execPath, ['postinstall.cjs', '--verify-only'], {
    cwd: tempRoot,
    encoding: 'utf8',
  });
  assert.equal(missingVerifier.status, 1, `${missingVerifier.stdout}\n${missingVerifier.stderr}`);
  assert.match(`${missingVerifier.stdout}${missingVerifier.stderr}`, /ripgrep verification failed after build/i);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('postinstall ripgrep verification regression: PASS');
