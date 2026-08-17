#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '..');
const skillPaths = [
  'skills/terminal/SKILL.md',
  'plugins/claude/skills/terminal/SKILL.md',
  'plugins/cursor/skills/terminal/SKILL.md',
];
const skills = await Promise.all(skillPaths.map((relative) =>
  fs.readFile(path.join(root, relative), 'utf8')));

for (let index = 1; index < skills.length; index++) {
  assert.equal(skills[index], skills[0], `${skillPaths[index]} drifted from canonical terminal skill`);
}
const canonical = skills[0];
for (const marker of [
  'executable + args[]',
  'execution_kind=finite',
  'execution_kind=interactive',
  'pty=auto',
  'set `cwd` directly',
]) assert(canonical.includes(marker), `terminal skill is missing structured guidance: ${marker}`);
assert(!canonical.includes('cd /abs/path && some-command'), 'terminal skill regressed to manual cwd shell chaining');
console.log('terminal skill sync: PASS');
