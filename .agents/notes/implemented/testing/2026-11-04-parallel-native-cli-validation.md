# Agent Note: Parallel Native CLI Validation

Status: implemented

## Problem

Ordinary CLI tests and installed acceptance consumed the same native job in
sequence even though installed scenarios did not consume ordinary-test outputs.
A platform's validation therefore waited for both complete suites before its
job finished. The runtime compatibility package was also published only after
both phases, coupling runtime checks to unrelated installed behavior.

## Decision

At adoption, the checks workflow ran two independent native matrices on Ubuntu,
macOS ARM64 and Windows. This allowed suites without an output dependency to
overlap and released runtime compatibility from installed acceptance. Each job
prepared its own checkout, Node.js 24, pinned pnpm, workspace dependencies,
environment/probes and compiled source.

The [single macOS allocation decision](2026-11-05-single-macos-native-allocation.md)
partially supersedes that physical topology after repeated hosted acquisition
failure. Linux and Windows retain the independent matrices; macOS uses one
required allocation with complete ordinary then installed phases. All six logical
OS phases remain required. Fail-fast, worker settings and case deadlines retain
their existing values.

The `verify` matrix owns type checking, the local development installer and all
ordinary compiled CLI tests. Its Ubuntu entry packs and uploads the unchanged
`daynight-runtime-package` artifact. Runtime compatibility depends on this
ordinary Linux/Windows producer matrix and module detection, without an installed
or macOS dependency. The Ubuntu entry remains the package producer; macOS remains
mandatory at the final gate.
The `verify-installed` matrix runs the complete installed configuration, which
retains its single canonical package preparation and real npm-update scenarios.

Ordinary environment receipts use `daynight-cli-tests-{os}` and probe diagnostics
use `daynight-cli-tests-probes-{os}`. Installed environment, curated acceptance
and canonical preparation/cleanup receipts use `daynight-cli-installed-{os}`;
its probe diagnostics use `daynight-cli-installed-probes-{os}`. These names give
each phase and platform exclusive artifact ownership. Environment receipts are
retained after environment discovery succeeds; diagnostic upload still runs
when that discovery fails.

The final `checks` job uses `always()`, waits for both Linux/Windows matrices,
`verify-macos` and every existing job, and rejects any failed or cancelled result. Unaffected jobs may skip.
Selected Web success guards, source-bound shard summary verification and the
main/PR cancellation policy retain their existing behavior. Builtin Node
workflow tests run the actual aggregate shell gate for each independent native
failure/cancellation and verify phase selection, producer and artifact ownership
before dependencies are installed.

The [development guide](../../../../docs/development.md#ci-selection) owns the
routing and validation commands. The [shared installation decision](2026-11-04-shared-installed-cli-preparation.md)
and [Worker fixture decision](2026-11-04-worker-git-fixture-seeds.md) own workload
reductions inside these phases; their measured results are independent of this
scheduling change.

## Alternatives

**Keep both phases in one job.** This avoids duplicate runner preparation, but
retains the serial dependency between suites that need no shared mutable state
or results.

**Split only the Windows lane.** This saves two additional runner preparations,
but Linux and macOS still combine ordinary and installed validation. Runtime
compatibility would wait for those combined lanes, and phase ownership would
vary by platform. Uniform matrices give every supported platform the same
producer, failure and artifact model at the additional bootstrap cost recorded
below.

**Run two Vitest processes on the same runner concurrently.** This shares the
machine's CPU, filesystem and process capacity. Native Git and installed CLI
workloads already have platform-dependent costs; independent runners preserve
the existing phase worker settings without adding in-runner contention.

**Share compiled or installed trees across native platforms.** Each platform
must exercise its own compiler/toolchain environment, native dependencies,
launchers and filesystem behavior. Each job builds current source and retains
its actual native evidence.

**Extract common setup into a new orchestration layer.** The two explicit YAML job
step lists make stage dependencies and artifact owners directly reviewable.
They do not require a separate composite action or cache protocol.

## Consequences

The original split gave each phase a 10-minute job limit, replacing the former
combined platform limit and expanding the aggregate budget. It duplicated
checkout, tool discovery, installation and build on another runner for each
platform. Linux and Windows retain that model. macOS now shares an allocation
with a 20-minute outer limit and separate 10-minute validation bounds, as owned
by the later decision. Wall-clock and runner execution-minute observations must
report the different preparation and scheduling costs.

The independent Linux/Windows phases may overlap when runners are available;
macOS validation phases execute in sequence. Queue delay, hosted load and
other selected modules can still dominate end-to-end workflow time. Successful
individual suites or theoretical overlap do not establish native hosted job
completion or a fixed speedup. Runtime checks follow the ordinary producer;
installed failure remains visible through the independent final gate.
