import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSerenaLaunchProfile } from '../dist/serena/serena-launch-profile.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const expectedSerena = path.resolve(repoRoot, '..', 'serena');
const previousCwd = process.cwd();
const previousSource = process.env.DESKTOP_COMMANDER_SERENA_PROJECT;

try {
  delete process.env.DESKTOP_COMMANDER_SERENA_PROJECT;
  process.chdir(path.join(repoRoot, 'dist'));
  const profile = await buildSerenaLaunchProfile(repoRoot);
  assert.equal(path.resolve(profile.sourceRoot).toLowerCase(), expectedSerena.toLowerCase());
  assert.equal(path.resolve(profile.cwd).toLowerCase(), expectedSerena.toLowerCase());
  console.log('Serena launch cwd independence: PASS');
} finally {
  process.chdir(previousCwd);
  if (previousSource === undefined) delete process.env.DESKTOP_COMMANDER_SERENA_PROJECT;
  else process.env.DESKTOP_COMMANDER_SERENA_PROJECT = previousSource;
}
