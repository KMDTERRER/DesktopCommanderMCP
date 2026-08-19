# Multi-toolchain Build Pipeline Plan

## Goal
Provide a compiler-agnostic CMake build pipeline that can run independent lanes concurrently, survive MCP response deadlines, expose progress without observer-driven execution, and verify declared build artifacts without duplicating CMake ownership.

## Current baseline
The following foundation already exists and is not future work:
- CMake File API metadata for `codemodel`, `cmakeFiles`, `toolchains`, cache and compile database.
- Shared preset dependency ownership in `cmake-preset-dependencies.ts`.
- `BuildAccessPlanner` plus `ResourceLeaseOwner` for granular read/write/watch conflicts.
- Build-system impact classification and `configureMode=if_needed`.
- `CppBuildLaneRunner` as the single owner of single-lane configure/build/test semantics.
- `cpp_build_execute` as the thin public single-lane facade.
- Process-global `BuildRunOwner`, detached finite execution, `executionMode=auto|inline|resumable`, and read-only `cpp_build_result`.
- Machine-enforced architecture boundaries in `test-build-architecture-boundaries.js`.

Current resumability is process-local: an MCP response may time out while a build continues, but restarting Desktop Commander loses active `BuildRunOwner` state. There is no multi-lane scheduler yet.

## Ownership invariants
- CMake presets/configured trees own compiler, linker, generator, runtime flags, toolchain selection, preset inheritance and macro semantics. MCP observes/asserts them; it does not reimplement them.
- `CppBuildLaneRunner` is the only owner of single-lane configure/build/test execution.
- Future `cpp_build_pipeline` composes the internal pipeline domain with `CppBuildLaneRunner`; it never calls the public `cpp_build_execute` tool and never copies its implementation.
- Public `cpp_build_pipeline` owns only schema/translation/composition and the aggregate API result. Internal `PipelineDagScheduler` owns DAG validation/readiness/failure propagation; `PipelineLaneAdmission` owns bounded lane-slot permits. Neither owns CMake/process/filesystem semantics.
- `BuildRunOwner` remains generic process/run ownership and must not gain CMake, C++ tool or DAG semantics.
- `cpp_build_result` is observation-only. Reading or waiting for a result must never schedule, retry or advance work.
- `ResourceLeaseOwner` remains below filesystem/build tools. No workspace-wide build mutex.
- `BuildAccessPlanner` owns access evidence and conservative fallback, not scheduling or toolchain choice.
- CMake File API query mutation belongs to configure execution; `build_metadata` remains read-only.
- `workspace-accelerators` is routing/composition only; resumable lifecycle stays at the C++ entry/run-owner boundary.
- Transport lifetime and build lifetime are separate contracts. A lost wait response is never evidence that the owned process failed.

## Cross-project architecture requirements adopted from Graph Planner
These invariants are adapted from the live `architecture-graph-planner/ARCHITECTURE_PLAN.md`. Graph-specific storage/UI semantics are intentionally not copied.

### Dependency and ownership shape
- The internal dependency graph is a directed linear-with-branching DAG: `MCP/entry -> application contract -> run/pipeline owners -> capability ports -> leaf process/filesystem/CMake effects`. Lower layers never depend upward on public facades, transport, or higher-level orchestration.
- Reverse module dependencies, reverse ownership, cyclic ownership and calls into a higher layer's private implementation are forbidden. If two layers need one type/contract, move that stable value/port to a lower neutral contract module instead of adding a reverse edge.
- Every mutable state machine, lifecycle and physical resource has exactly one authoritative owner. Owner granularity follows a real write-invariant/lifecycle/recovery boundary, not file count, interface count, caller count or test convenience.
- A cohesive owner may expose several narrow capability contracts. Interface segregation is by semantic capability/change axis, not by consumer name; forwarding-only `ForConsumerX` facades, duplicate DTO shapes and owner-per-interface splits are defects.
- Physical code decomposition follows change locality. Splitting a large implementation file into private helpers does not create a new owner, mutex, queue, cache or lifecycle unless an independent state/recovery authority is actually introduced.

### Planning, scheduling, admission and execution are distinct
- Pipeline validation/planning, dependency readiness scheduling, resource admission and lane execution are separate contracts. A future optimization must not collapse these roles into one mega-scheduler.
- The DAG scheduler owns dependency readiness, terminal propagation (`failed -> blocked descendants`) and deterministic result ordering. It does not own CMake execution, process internals, filesystem lease tables or artifact storage.
- Resource admission owns only bounded concurrency/budget decisions. Path/read/write conflicts remain with `ResourceLeaseOwner`; the scheduler must not duplicate that conflict state. Resource acquisition must avoid hold-and-wait across independent resource classes.
- `CppBuildLaneRunner` executes an already admitted single lane. It does not know pipeline dependencies, other lane states, cross-run fairness or observer semantics.
- `BuildRunOwner` owns run lifetime/change notification only. It does not become the scheduler, admission controller or CMake owner.
- Ready work is retained by the scheduler until admitted; do not flood the runner/process layer with a large background backlog. Queues and result buffers are bounded, backpressure is explicit, and retry after capacity wake/completion must not busy-spin.
- If cross-run priority/fairness is later required, it belongs to scheduler/admission policy with bounded aging/progress, never inside `CppBuildLaneRunner` or `ResourceLeaseOwner`. Do not create a new state owner until independent quota/budget state actually exists.

### Cross-owner consistency and publication
- Cross-owner workflows use immutable handoff: `captured basis/revision -> immutable intent -> owner-local atomic effect -> immutable outcome/event -> next owner`. Do not hold two owner locks or invent a shared mutable transaction to make the chain look atomic.
- A mutable owner follows `capture expected revision/state -> build and validate candidate -> persist physical effect -> no-fail publish/activate immutable state`. Validation that may reject the candidate happens before the durable effect.
- Composition/read models are stateless projections over captured immutable snapshots and must expose the basis/revision needed to detect stale or mixed state. Readers never receive mutable containers, queue internals, process handles or storage objects owned by another layer.
- Missing, stale, partial or truncated evidence is reported explicitly. No layer may silently upgrade incomplete dependency/toolchain/artifact evidence to an exact result.

### Multi-toolchain isolation
- Independent compiler/toolchain lanes use independent CMake build trees. The pipeline coordinates them through DAG dependencies plus artifact descriptors/manifests; it must not create one mixed CMake target graph whose correctness depends on sharing a C++ ABI across different compilers/runtimes.
- Scheduler/orchestration code remains compiler-agnostic. Compiler-specific behavior belongs to project-owned CMake/toolchain configuration and artifact verification, not scheduler branches.
- When a project intentionally crosses toolchain runtime boundaries in-process, the project owns a versioned C ABI contract. Pipeline verification may validate manifest/hash/build-id and bounded ABI/layout evidence, but it must not invent project ABI semantics.
- Cross-toolchain artifacts are consumed from declared/manifest-pinned paths/identities, not guessed from `PATH`, current directory or heuristic filename search.

### Machine enforcement and test topology
- Every critical dependency/ownership prohibition must have a machine guard and a negative regression. A locally green happy-path test is not permission to restore a reverse dependency or competing ownership path.
- For multi-module behavior, prefer the widest economical stable boundary: public/frozen MCP or P2P chain through the real owners before isolated unit tests. Unit tests remain for pure algorithms, deterministic fault injection and low-level race localization.
- Concurrency acceptance checks isolation and latency, not only absence of deadlock: unrelated work must progress, admission stays bounded, cancellation/shutdown are bounded, and no hidden global serialization appears.
- A cutover removes the competing old path instead of preserving dual ownership/fallback for convenience. Evidence is current only for the production boundary it was run against; changing that boundary invalidates the relevant gate.

## Remaining implementation order
1. Add generic run revision/change signaling to `BuildRunOwner` and `cpp_build_result`.
2. Implement an internal multi-lane pipeline domain: pure DAG readiness scheduler + bounded lane admission + coordinator invoking `CppBuildLaneRunner`.
3. Expose a thin public `cpp_build_pipeline` using one resumable run owner for the whole pipeline.
4. Add bounded artifact evidence manifests and generic ABI/layout verification.
5. Re-evaluate crash-persistent/native MCP task ownership only after pipeline semantics are stable.

## Slice 1: run progress / wait-any contract
`BuildRunOwner.wait()` currently wakes only when the whole run completes or `waitMs` expires. Multi-lane execution requires prompt visibility of partial terminal transitions.

Add a generic monotonically increasing `revision` (or equivalent generation) and a run-level change signal. Publish a new revision when:
- a lane becomes terminal (`succeeded | failed | blocked`);
- a terminal process failure changes run state;
- the whole run completes.

`cpp_build_result` waiting semantics:
- the caller supplies/observes a revision;
- waiting returns on the first newer revision or timeout;
- the returned overall run may still be `running`;
- multiple observers wake independently on the same transition;
- observing a transition cannot advance the scheduler;
- do not implement another polling loop over every PID.

Required P2P/E2E tests:
- lane A completes while lane B is still running and both waiters wake promptly;
- the same behavior when A fails;
- a waiter on the new revision remains pending until the next change/timeout;
- two observers both see one transition;
- observer code cannot start a dependent lane;
- no known terminal transition waits out the original timeout.

## Slice 2: internal multi-lane pipeline domain
Implement this as an internal domain module first, e.g. `cpp-build-pipeline.ts`, with three explicit roles: `PipelineDagScheduler` for validation/readiness, `PipelineLaneAdmission` for bounded lane-slot permits, and a small coordinator that invokes the existing runner port after admission. No MCP descriptor in this slice.

`PipelineLaneAdmission` is justified only as the owner of pipeline lane-slot state (`maxParallelLanes`/active permits). It does not duplicate path conflicts, build access evidence or process ownership. If future CPU/memory/external-process quotas are added, they extend this admission capability; they do not move into the DAG scheduler or lane runner.

### Input contract
Each lane has a bounded opaque `id`, `dependsOn[]`, an explicit `buildDir`, and the single-lane arguments required by `CppBuildLaneRunner`.

Validate before any lane starts:
- duplicate lane IDs;
- missing or self dependencies;
- cycles;
- lane/edge/concurrency/result-size limits;
- build paths outside the repository;
- duplicate or nested-overlapping build roots.

Do not add a compiler enum. Toolchain identity comes from CMake metadata and may be asserted, not selected by MCP.

### Scheduler semantics
- States: `pending | running | succeeded | failed | blocked`.
- A lane is ready only when all dependencies succeeded.
- Failure blocks descendants; unrelated ready lanes continue. No global fail-fast cancellation in the first slice.
- `PipelineLaneAdmission` enforces `maxParallelLanes`; actual path conflicts stay with `ResourceLeaseOwner`. A ready lane remains scheduler-owned until an admission permit is available.
- The scheduler advances autonomously. Observers never drive it.
- Final success requires every requested lane to succeed. Failed and blocked lanes are reported separately.
- Result ordering is deterministic and independent of completion order.

Required tests:
- cycle/missing dependency/overlapping build root rejected before any runner call;
- independent lanes overlap when parallelism allows;
- a dependent lane never starts early;
- failure blocks descendants but not unrelated lanes;
- concurrency never exceeds the configured admission permits;
- repeated observation cannot execute a lane twice;
- reversed completion order does not change result ordering.

Extend the architecture guard so `PipelineDagScheduler` depends only on pipeline-domain contracts and never on `CppBuildLaneRunner`, `ResourceLeaseOwner`, `BuildRunOwner`, `TerminalManager`, `workspace-accelerators`, MCP transport or the public execute facade. The small pipeline coordinator may depend downward on scheduler, admission and the runner port; no lower layer may depend back on that coordinator.

## Slice 3: public `cpp_build_pipeline`
Only after the internal scheduler is green:
- add a thin public descriptor/schema and route it through the existing C++ entry/composition boundary;
- make the whole pipeline one `BuildRunOwner` operation and register all lane PIDs on that run;
- prefer bounded `auto` observation followed by `buildRunId`, or immediate resumable mode;
- reuse `cpp_build_result` for both single-lane and pipeline runs;
- do not introduce a second polling/result state machine.

Frozen-MCP E2E must prove that a transport deadline may expire while the pipeline continues and that later observation returns the same run without re-executing lanes.

## Slice 4: artifact evidence / ABI gates
Keep evidence ownership separate from scheduling:
- produce bounded per-lane evidence containing actual CMake toolchain identity, relevant metadata fingerprints, deterministic build identity and SHA-256 of declared artifacts;
- project-specific ABI/API meaning remains project-owned and is only validated/compared by MCP;
- prefer project-owned C ABI/layout probes emitting bounded JSON (`sizeof`, `alignof`, offsets, ABI version) over compiler-specific binary parsing as the primary cross-toolchain contract;
- retain executable/CTest integration as the real cross-compiler integration gate;
- fence artifact paths to declared lane output roots and hash with streaming reads;
- build identity must be deterministic evidence, not timestamp/random identity.

## Later: crash durability
`BuildRunOwner` is process-local. After DAG and artifact semantics are stable, re-check current official MCP Tasks/SDK capabilities and decide whether to map the pipeline to native tasks or add an explicitly durable owner. This requires fresh primary-source research at implementation time.

## Acceptance rule for every slice
A slice is complete only when applicable checks are green:
1. reproduce the defect/contract with a negative regression before fixing it;
2. prefer E2E or point-to-point tests across real module boundaries; use unit tests only for truly local logic;
3. `npm run build`;
4. focused behavior tests;
5. `test-build-architecture-boundaries.js`;
6. frozen MCP routing/lifetime tests when public transport changes;
7. full `node test/run-all-tests.js` before a major checkpoint;
8. `workspace_snapshot.diffCheck.ok == true`;
9. no unknown dirty files or orphaned build/test sessions;
10. architecture audit confirms single ownership, no reverse imports, no duplicated lifecycle/timeout logic and no new workspace-global lock;
11. commit/push only on explicit user request.

## Hard prohibitions
- Do not call `cpp_build_execute` from `cpp_build_pipeline`; call the runner.
- Do not make `cpp_build_result` drive the scheduler.
- Do not introduce a global project/build queue when resource leases express the conflict.
- Do not parse CMake preset inheritance/macros to choose toolchains.
- Do not add compiler-specific orchestration branches to the scheduler.
- Do not treat missing generator dependency evidence as exact; downgrade coverage and expand conservatively.
- Do not restart/kill an owned long process solely because one MCP wait response was lost.
- Do not move process ownership back into `workspace-accelerators`.
- Do not weaken architecture guards to make a dependency pass; move responsibility to the correct owner.
