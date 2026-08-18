import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { callCppBuildAccessPlanner } from '../dist/tools/cpp-build-access-planner.js';
import { acquireMutationResourceLease, acquireResourceLease } from '../dist/utils/resource-lease-owner.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function metadata(root, buildDir) {
  const commonId = 'common::@1';
  return {
    repositoryRoot: root, buildDir, buildDirDiscovered: false, searchedDirectories: 1, requestedFiles: [],
    compileDatabase: { found: true, sha256: 'sha256:compile', totalEntries: 2, truncated: false },
    cmakeCache: {
      found: true, path: path.join(buildDir, 'CMakeCache.txt'), sha256: 'sha256:cache',
      values: { CMAKE_GENERATOR: 'Ninja', CMAKE_MAKE_PROGRAM: path.join(os.tmpdir(), 'ninja') },
    },
    cmake: {
      found: true, targetsTruncated: false, targetsByteTruncated: false,
      codemodel: { sha256: 'sha256:codemodel' },
      cmakeFiles: {
        found: true, sha256: 'sha256:cmakefiles', paths: { source: root, build: buildDir },
        inputs: [
          { path: 'CMakeLists.txt', absolutePath: path.join(root, 'CMakeLists.txt') },
          { path: 'cmake/options.cmake', absolutePath: path.join(root, 'cmake', 'options.cmake') },
        ],
        globsDependent: [{ expression: path.join(root, 'src', '*.cpp'), recurse: false }],
      },
      toolchains: {
        found: true, sha256: 'sha256:toolchains',
        toolchains: [{ language: 'CXX', compiler: { id: 'Clang', version: '22.0.0', path: 'clang++' } }],
      },
      targets: [
        {
          id: commonId, name: 'common', sources: ['src/common.cpp'], generatedSources: [],
          artifacts: ['lib/common.lib'], dependencies: [],
        },
        {
          id: 'backend::@2', name: 'backend',
          sources: ['src/backend.cpp', path.join(buildDir, 'generated.cpp')],
          generatedSources: [path.join(buildDir, 'generated.cpp')],
          artifacts: ['bin/backend.dll'], dependencies: [commonId],
        },
      ],
    },
  };
}

async function waitBlocked(promise, label) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await sleep(120);
  assert.equal(settled, false, label);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-build-access-'));
  const buildDir = path.join(root, 'build');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'cmake'), { recursive: true });
  await fs.mkdir(buildDir);
  const snapshot = metadata(root, buildDir);
  const header = path.join(root, 'include', 'common.hpp');
  const generatedHeader = path.join(buildDir, 'generated.hpp');
  const dependencyProvider = async (_metadata, targetNames) => {
    assert.deepEqual(targetNames, ['backend']);
    return { available: true, inputs: [header, generatedHeader], executable: 'fake-ninja' };
  };

  try {
    const plan = await callCppBuildAccessPlanner(
      { root, buildDir, targets: ['backend'] }, 5000, snapshot, { dependencyInputs: dependencyProvider },
    );
    assert.equal(plan.coverage, 'historical');
    assert.deepEqual(plan.includedTargets, ['backend', 'common']);
    assert(plan.configureInputs.some((item) => path.resolve(item) === path.join(root, 'CMakeLists.txt')));
    assert(plan.sourceInputs.some((item) => path.resolve(item) === path.join(root, 'src', 'backend.cpp')));
    assert(plan.sourceInputs.some((item) => path.resolve(item) === path.join(root, 'src', 'common.cpp')));
    assert(!plan.sourceInputs.some((item) => path.resolve(item) === path.join(buildDir, 'generated.cpp')));
    assert(plan.generatedOutputs.some((item) => path.resolve(item) === path.join(buildDir, 'generated.cpp')));
    assert(plan.artifactOutputs.some((item) => path.resolve(item) === path.join(buildDir, 'bin', 'backend.dll')));
    assert(plan.dependencyInputs.some((item) => path.resolve(item) === header));
    assert.equal(plan.readRoots.length, 0);
    assert(plan.patternWatches.some((item) => path.resolve(item.root) === path.join(root, 'src')));
    assert.equal(plan.toolchains.toolchains[0].compiler.id, 'Clang');

    const buildLease = await acquireResourceLease(plan.leaseRequest, Date.now() + 2000);
    const unrelated = path.join(root, 'docs', 'note.md');
    const unrelatedStarted = Date.now();
    const unrelatedLease = await acquireMutationResourceLease([unrelated], Date.now() + 1000, { label: 'docs-edit' });
    assert(Date.now() - unrelatedStarted < 500, 'historical plan blocked unrelated repository mutation');
    await unrelatedLease.release();

    const sourceWriter = acquireMutationResourceLease(
      [path.join(root, 'src', 'common.cpp')], Date.now() + 3000, { label: 'source-edit' },
    );
    await waitBlocked(sourceWriter, 'source mutation bypassed planned build read set');

    const existingUnrelatedSource = path.join(root, 'src', 'unrelated.cpp');
    const contentOnly = await acquireMutationResourceLease(
      [existingUnrelatedSource], Date.now() + 1000, { label: 'content-only' },
    );
    await contentOnly.release();

    const createSource = acquireMutationResourceLease(
      [path.join(root, 'src', 'new.cpp')], Date.now() + 3000,
      { label: 'new-glob-member', topologyPaths: [path.join(root, 'src', 'new.cpp')] },
    );
    await waitBlocked(createSource, 'glob topology mutation bypassed pattern watch');
    await buildLease.release();
    await (await sourceWriter).release();
    await (await createSource).release();

    const conservative = await callCppBuildAccessPlanner(
      { root, buildDir, targets: ['backend'] }, 5000, snapshot,
      { dependencyInputs: async () => ({ available: false, inputs: [], warning: 'provider unavailable' }) },
    );
    assert.equal(conservative.coverage, 'conservative');
    assert.deepEqual(conservative.readRoots.map((item) => path.resolve(item)), [path.resolve(root)]);
    const conservativeLease = await acquireResourceLease(conservative.leaseRequest, Date.now() + 2000);
    const docsWriter = acquireMutationResourceLease([unrelated], Date.now() + 3000, { label: 'docs-under-conservative' });
    await waitBlocked(docsWriter, 'conservative plan did not protect unknown repository inputs');
    await conservativeLease.release();
    await (await docsWriter).release();

    const changedPlan = await callCppBuildAccessPlanner(
      { root, buildDir, targets: ['backend'] }, 5000, snapshot, {
        dependencyInputs: async () => ({ available: true, inputs: [header, path.join(root, 'include', 'other.hpp')] }),
      },
    );
    assert.notEqual(changedPlan.accessFingerprint, plan.accessFingerprint);

    const incompleteSnapshot = metadata(root, buildDir);
    incompleteSnapshot.cmake.cmakeFiles = { found: false, inputs: [], globsDependent: [] };
    const incomplete = await callCppBuildAccessPlanner(
      { root, buildDir, targets: ['backend'] }, 5000, incompleteSnapshot, { dependencyInputs: dependencyProvider },
    );
    assert.equal(incomplete.coverage, 'incomplete');
    assert(incomplete.incompleteness.includes('cmake_files_reply_unavailable'));
    assert.deepEqual(incomplete.readRoots.map((item) => path.resolve(item)), [path.resolve(root)]);

    console.log('cpp build access planner tests: PASS');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
