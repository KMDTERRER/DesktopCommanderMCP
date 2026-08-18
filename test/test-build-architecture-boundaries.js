import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const files = {
  metadata: 'src/tools/build-metadata-accelerator.ts',
  preset: 'src/tools/cmake-preset-dependencies.ts',
  fileApi: 'src/tools/cmake-file-api-query.ts',
  plan: 'src/tools/cpp-build-plan-accelerator.ts',
  impact: 'src/tools/cpp-build-impact-accelerator.ts',
  context: 'src/tools/cpp-build-context-accelerator.ts',
  access: 'src/tools/cpp-build-access-planner.ts',
  execute: 'src/tools/cpp-build-execute-accelerator.ts',
  lane: 'src/tools/cpp-build-lane-runner.ts',
  entry: 'src/tools/cpp-build-entry.ts',
  runOwner: 'src/tools/build-run-owner.ts',
  detached: 'src/tools/detached-build-process.ts',
  wait: 'src/utils/terminal-process-wait.ts',
  lease: 'src/utils/resource-lease-owner.ts',
  workspace: 'src/tools/workspace-accelerators.ts',
};

async function read(relative) {
  return fs.readFile(path.join(root, relative), 'utf8');
}

function imports(source) {
  const result = [];
  const regex = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(source)) !== null) result.push(match[1]);
  return result;
}

function rejectImport(source, relative, pattern, message) {
  const offenders = imports(source).filter((value) => pattern.test(value));
  assert.deepEqual(offenders, [], `${relative}: ${message}: ${offenders.join(', ')}`);
}

function rejectText(source, relative, pattern, message) {
  assert.equal(pattern.test(source), false, `${relative}: ${message}`);
}

async function main() {
  const source = Object.fromEntries(await Promise.all(
    Object.entries(files).map(async ([key, relative]) => [key, await read(relative)]),
  ));
  const toolDirectory = path.join(root, 'src', 'tools');
  const toolNames = (await fs.readdir(toolDirectory)).filter((name) => name.endsWith('.ts')).sort();
  const toolSources = new Map(await Promise.all(toolNames.map(async (name) => [
    name, await fs.readFile(path.join(toolDirectory, name), 'utf8'),
  ])));
  const importersOf = (specifier) => [...toolSources.entries()]
    .filter(([, text]) => imports(text).includes(specifier)).map(([name]) => name).sort();

  assert.deepEqual(importersOf('./cmake-file-api-query.js'), ['cpp-build-lane-runner.ts'],
    'CMake File API query mutation must have one single-lane execution owner');
  assert.deepEqual(importersOf('./detached-build-process.js'), ['cpp-build-entry.ts'],
    'detached build process adapter must be private to cpp-build-entry');
  assert.deepEqual(importersOf('./build-run-owner.js'), ['cpp-build-entry.ts'],
    'BuildRunOwner must be private to cpp-build-entry');
  assert.deepEqual(importersOf('./cmake-preset-dependencies.js'), [
    'cpp-build-access-planner.ts', 'cpp-build-impact-accelerator.ts',
    'cpp-build-lane-runner.ts', 'cpp-build-plan-accelerator.ts',
  ], 'CMake preset dependency leaf must have an explicit bounded consumer set');
  assert.deepEqual(importersOf('./cpp-build-lane-runner.js'), ['cpp-build-entry.ts', 'cpp-build-execute-accelerator.ts'],
    'single-lane runner may be consumed only by the build entry and public compatibility facade');

  rejectImport(source.metadata, files.metadata, /\.\/filesystem\.js$/,
    'build metadata must depend on path-security authority, not filesystem tool facade');
  assert(imports(source.metadata).includes('./path-security.js'),
    'build metadata must use the shared path-security authority leaf');
  rejectImport(source.metadata, files.metadata, /cpp-build-|build-run-owner|detached-build-process/,
    'metadata leaf cannot depend on higher build runtime layers');
  assert.deepEqual([...new Set(imports(source.execute))], ['./cpp-build-lane-runner.js'],
    'cpp_build_execute public facade must depend only on the single-lane runner');
  rejectImport(source.lane, files.lane, /\.\/filesystem\.js$/,
    'single-lane runner must depend on path-security authority, not filesystem tool facade');
  assert(imports(source.lane).includes('./path-security.js'),
    'single-lane runner must use the shared path-security authority leaf');

  rejectImport(source.preset, files.preset, /cpp-build-|build-run-owner|detached-build-process|workspace-accelerators|terminal-manager/,
    'preset dependency leaf cannot depend on build orchestration/runtime');
  rejectImport(source.fileApi, files.fileApi, /cpp-build-|build-run-owner|detached-build-process|workspace-accelerators|terminal-manager/,
    'CMake File API query leaf cannot depend on build orchestration/runtime');
  rejectImport(source.lease, files.lease, /\.\.\/tools\/|terminal-manager|cpp-build|build-run-owner/,
    'resource lease owner cannot depend on tool/build implementations');
  rejectImport(source.wait, files.wait, /terminal-manager|\.\.\/tools\/|cpp-build|build-run-owner/,
    'terminal wait contract must depend only on its explicit port');
  rejectImport(source.runOwner, files.runOwner, /^\.|cpp-build|terminal-manager|workspace-accelerators/,
    'generic BuildRunOwner cannot depend on C++/terminal/tool adapters');
  rejectText(source.runOwner, files.runOwner, /cpp_build_|CPP_BUILD_/,
    'generic BuildRunOwner cannot own public C++ tool semantics');

  for (const key of ['impact', 'access', 'lane']) {
    rejectImport(source[key], files[key], /cpp-build-plan-accelerator\.js$/,
      `${key} cannot reuse semantics through the public build-plan adapter`);
  }
  for (const key of ['plan', 'impact', 'access', 'lane']) {
    assert(imports(source[key]).includes('./cmake-preset-dependencies.js'),
      `${files[key]} must use the shared CMake preset dependency leaf`);
  }

  assert(imports(source.workspace).includes('./cpp-build-entry.js'),
    'workspace router must route C++ execution through cpp-build-entry');
  for (const [pattern, label] of [
    [/buildRunOwner/, 'BuildRunOwner state'],
    [/startDetachedBuildProcess/, 'detached process implementation'],
    [/callCppBuildAccessPlanner/, 'build access planner implementation'],
    [/callCppBuildExecuteAcceleratorTool/, 'public single-lane compatibility call'],
    [/CppBuildLaneRunner|runCppBuildLane/, 'single-lane runner implementation'],
    [/CppBuildExecuteDependencies/, 'single-lane dependency contract'],
  ]) {
    rejectText(source.workspace, files.workspace, pattern, `workspace router must not own ${label}`);
  }

  const presetDefinitions = Object.entries(source).filter(([, text]) =>
    /export async function collectCmakePresetDependencies\s*\(/.test(text));
  assert.deepEqual(presetDefinitions.map(([key]) => key), ['preset'],
    'CMake preset dependency semantics must have one owner');
  const waitDefinitions = Object.entries(source).filter(([, text]) =>
    /export async function waitForTerminalProcess\s*\(/.test(text));
  assert.deepEqual(waitDefinitions.map(([key]) => key), ['wait'],
    'terminal process wait semantics must have one owner');
  const laneRunnerDefinitions = Object.entries(source).filter(([, text]) => /export class CppBuildLaneRunner\b/.test(text));
  assert.deepEqual(laneRunnerDefinitions.map(([key]) => key), ['lane'],
    'single-lane CMake execution semantics must have one owner');

  const buildGraphKeys = [
    'metadata', 'preset', 'fileApi', 'plan', 'impact', 'context',
    'access', 'execute', 'lane', 'entry', 'runOwner', 'detached',
  ];
  const byBasename = new Map(buildGraphKeys.map((key) => [path.basename(files[key], '.ts'), key]));
  const graph = new Map();
  for (const key of buildGraphKeys) {
    const edges = [];
    for (const specifier of imports(source[key])) {
      if (!specifier.startsWith('./')) continue;
      const base = path.basename(specifier).replace(/\.js$/, '');
      const target = byBasename.get(base);
      if (target) edges.push(target);
    }
    graph.set(key, [...new Set(edges)]);
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (key, stack) => {
    if (visiting.has(key)) {
      throw new Error(`Build architecture import cycle: ${[...stack, key].join(' -> ')}`);
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const next of graph.get(key) ?? []) visit(next, [...stack, key]);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of buildGraphKeys) visit(key, []);

  console.log('build architecture boundaries: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
