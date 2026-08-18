# Multi-toolchain Build Pipeline Plan

## Goal
Provide a compiler-agnostic CMake DAG pipeline that can run independent build lanes concurrently, resume long-running builds beyond MCP transport deadlines, and verify artifacts/ABI without duplicating CMake ownership.

## Ownership rules
- CMake presets/configured trees own compiler, linker, generator, runtime and build flags.
- MCP records actual toolchain identity; it does not select compilers through a fixed enum.
- `cpp_build_execute` remains the public single-lane fast path.
- Shared execution logic moves into a lower `CppBuildLaneRunner`.
- Long-running process lifetime is owned by `BuildRunOwner`, never by one MCP request.
- `cpp_build_pipeline` owns only DAG scheduling and aggregate result composition.
- `cpp_build_result` is observation-only and never advances the DAG itself.

## Required implementation order
1. Extend `build_metadata` with CMake File API `toolchains` and `cmakeFiles` evidence.
2. Add `BuildAccessPlanner` and granular `ResourceLeaseOwner` before pipeline work.
3. Extend build impact to classify source, CMake input, preset/toolchain and project-declared build inputs.
4. ✅ Extract `CppBuildLaneRunner` from `cpp_build_execute` without changing existing external behavior.
5. ✅ Add `BuildRunOwner` and resumable single-lane execution.
6. Add `cpp_build_pipeline` DAG validation/scheduling.
7. Add read-only `cpp_build_result`.
8. Add artifact manifests, hashing and generic C ABI/layout gates.

## Granular build access model
Each lane derives a `BuildAccessPlan` before execution:
- `configureInputs`: CMakeLists, included `.cmake`, preset closure, toolchain/config inputs.
- `sourceInputs`: selected C/C++/module sources.
- `dependencyInputs`: generated or compiler-discovered dependencies, preferably from generator metadata.
- `patternWatches`: CMake glob scopes that can change the graph when files are created/moved/removed.
- `writeRoots`: exact build/output roots owned exclusively by the lane.
- `coverage`: `exact | historical | conservative | incomplete`.

Lease compatibility:
- build reads acquire shared leases; unrelated writes remain unblocked.
- source mutation acquires exclusive leases and waits only for intersecting active build reads.
- different lanes may run concurrently when their write roots do not overlap.
- read/read overlaps are allowed; write/read and write/write overlaps conflict.
- topology mutations also check watched patterns/directories.

Do not materialize one filesystem lock per source file. Publish one bounded lease manifest per owner and index normalized paths/prefixes in memory; preserve the existing cross-process mutation lock for atomic filesystem ownership.

## Dependency evidence
Primary CMake evidence: `codemodel`, `cmakeFiles`, `toolchains`, cache and compile database.
Generator-specific providers may enrich the plan (for example Ninja dependency/input data) but must fall back conservatively rather than becoming mandatory.
Project-specific lock/build-script inputs belong in project-owned preset vendor metadata, not a hard-coded package-manager list in Desktop Commander.

## Green intermediate checkpoint
The current runnable checkpoint stops before multi-lane DAG scheduling. It contains:
- CMake File API metadata (`codemodel`, `cmakeFiles`, `toolchains`) with client query generation owned by configure execution.
- Shared CMake preset dependency ownership in `cmake-preset-dependencies`; build plan/impact/access/execute consume that leaf without importing one another's public adapters.
- `ResourceLeaseOwner` + coordinated mutation ownership for granular build/read/write/topology conflicts.
- `BuildAccessPlanner` with conservative fallback and generator-specific dependency provider ports.
- Build-system impact classification and explicit `configureMode=if_needed`.
- `CppBuildLaneRunner` as the single owner of single-lane CMake execution, `cpp_build_execute` as a thin public compatibility façade, and `cpp-build-entry` as the transport/lifetime adapter.
- Process-global `BuildRunOwner`, detached finite process adapter, `executionMode=auto|inline|resumable`, and observation-only `cpp_build_result`.
- Machine-enforced dependency/ownership boundaries in `test-build-architecture-boundaries.js`.

This checkpoint's resumability is intentionally scoped to MCP response/transport lifetime while the Desktop Commander server process remains alive; native MCP Tasks/crash-persistent task state is a later durability layer.

Still intentionally open before the multi-toolchain pipeline:
1. Build the validated multi-lane DAG scheduler on `CppBuildLaneRunner`.
2. Add artifact manifests/hashes and ABI/layout gates.
3. Evaluate native MCP Tasks as the durable cross-restart execution surface instead of expanding the compatibility result API.
