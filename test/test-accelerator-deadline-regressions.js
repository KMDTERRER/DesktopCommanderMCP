#!/usr/bin/env node
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { callBuiltinAcceleratorTool } from '../dist/tools/workspace-accelerators.js';

async function main() {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-dc-deadline-'));
  const target = path.join(root, 'deadline-edit.txt');
  const realRealpath = fs.realpath;
  const realSetTimeout = globalThis.setTimeout;
  try {
    await fs.writeFile(target, 'BEFORE\n', 'utf8');
    fs.realpath = async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(target)) return new Promise(() => {});
      return realRealpath(...args);
    };
    globalThis.setTimeout = (callback, ms, ...timerArgs) =>
      realSetTimeout(callback, ms === 10_000 ? 700 : ms, ...timerArgs);

    const startedAt = Date.now();
    const outcome = await Promise.race([
      callBuiltinAcceleratorTool('edit_file', {
        path: target,
        edits: [{ oldText: 'BEFORE', newText: 'AFTER' }],
        dryRun: false,
      }, 300).then(() => ({ kind: 'resolved' }), (error) => ({ kind: 'rejected', error })),
      new Promise((resolve) => realSetTimeout(() => resolve({ kind: 'hung' }), 1000)),
    ]);
    assert.notEqual(outcome.kind, 'hung', 'edit_file path validation ignored the accelerator deadline');
    assert(Date.now() - startedAt < 600, 'edit_file path validation exceeded the accelerator deadline');
    assert.equal(await fs.readFile(target, 'utf8'), 'BEFORE\n');

    const buildDir = path.join(root, 'build');
    const srcDir = path.join(root, 'src');
    const responsePath = path.join(buildDir, 'args.rsp');
    await fs.mkdir(buildDir, { recursive: true });
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'main.cpp'), 'int main(){ return 0; }\n', 'utf8');
    await fs.writeFile(responsePath, '-DDEADLINE_TEST=1', 'utf8');
    await fs.writeFile(path.join(buildDir, 'compile_commands.json'), JSON.stringify([{
      directory: buildDir, file: '../src/main.cpp', arguments: ['clang++', '@args.rsp', '-c', '../src/main.cpp'],
    }]), 'utf8');
    fs.realpath = async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(responsePath)) return new Promise(() => {});
      return realRealpath(...args);
    };
    const buildOutcome = await callBuiltinAcceleratorTool('build_metadata', {
      root, buildDir, files: ['src/main.cpp'], includeArguments: true,
    }, 300).then(() => ({ kind: 'resolved' }), (error) => ({ kind: 'rejected', error }));
    assert.equal(buildOutcome.kind, 'rejected', 'build_metadata swallowed a response-file path validation deadline');
    assert.match(String(buildOutcome.error?.message ?? buildOutcome.error), /deadline|timed out/i);
    console.log('accelerator deadline propagation: PASS');
  } finally {
    fs.realpath = realRealpath;
    globalThis.setTimeout = realSetTimeout;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
