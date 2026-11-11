# Agent Note: Verified Windows CLI Shards

Status: implemented

## Problem

The complete ordinary CLI workload can exhaust the Windows runner's ten-minute
job budget before Vitest reports every test file. In
[run 42927386183](https://github.com/codetreker/daynight/actions/runs/42927386183/job/130217297306),
preparation took 74 seconds and the test step took 527 seconds before
cancellation. A suite still completed about two seconds before cancellation;
the incomplete result cannot establish that the remaining files passed. The
observed slowdown affects several native Git suites, and these observations do
not identify its infrastructure cause.

## Decision

The ordinary `verify` matrix allocates two independent Windows runners. Vitest's
built-in `--shard=1/2` and `--shard=2/2` partition the complete ordinary file
collection. Ubuntu and macOS retain their complete ordinary commands, and all
installed CLI phases retain their independent runners. Every native job keeps
its ten-minute budget, locked dependency installation, build, environment
recording and existing test deadlines. Both Windows entries also retain source
type checking and development-installer tests.

A Windows-only configuration inherits the ordinary configuration and appends the
built-in JSON reporter. Default reporters, immediate failure diagnostics,
unhandled-error propagation, isolation, concurrency and discovery rules remain
unchanged. Each Windows runner saves an unsharded file discovery, its actual
execution report and source metadata. The metadata includes the installed
Vitest version, package root, clean source revision and tree, and the GitHub
Actions outcome of the single native test command.

The final gate requires all selected CLI jobs to succeed. It downloads both
current-run Windows artifacts and checks their revision and tree against its
own checkout and their Vitest version against the pinned package dependency.
Normalized Windows file paths must remain inside each runner's package root.
The two complete discoveries must agree, each executed file must be discovered,
and the execution sets must be nonempty, disjoint and cover the full discovery.
Missing, malformed or inconsistent evidence fails the gate. Existing skipped or
todo cases remain represented; incomplete or failed assertions are rejected.
JSON success alone does not establish a successful command, so the recorded
native step outcome and successful matrix result remain independent requirements.

This partially replaces the Windows ordinary allocation in the
[independent native validation decision](2026-11-07-independent-macos-cli-validation.md).
The [development guide](../../../../docs/development.md#cli-development)
owns commands, artifacts and phase dependencies.

## Alternatives

**Increase the Windows job budget.** This would relax the existing ten-minute
boundary while retaining one serial allocation for the complete workload.

**Further cache immutable Git fixtures.** Worker worktree tests already reuse
immutable repository seeds. Reusing an immutable bare origin could remove fixture
clone overhead, but does not account for the complete multi-file workload. That
optimization requires its own measurements and proof of independent objects.

**Use discovery with `--shard` as execution evidence.** Vitest 5.0.5 applies
sharding when executing tests; `list --filesOnly` returns the full collection.
Two discovery lists therefore cannot establish what either runner executed.

**Select named groups of slow tests.** A maintained file allowlist could omit new
files. Built-in partitioning and a full-discovery comparison retain automatic
selection without changing the assertions or mechanisms exercised.

## Consequences

Windows ordinary tests use one additional runner and repeat preparation work.
File sharding divides file counts, not measured durations; an expensive file
still executes entirely on one runner. Queueing, host load and native Git costs
can limit elapsed-time improvement. Native Windows results determine whether the
workload finishes within budget; local or container measurements do not replace
that evidence or establish the historical timeout's cause.

Runtime compatibility still waits for the entire ordinary matrix and consumes
only the Ubuntu package. Installed acceptance remains independent. Per-shard
artifact names prevent Windows uploads from colliding, while other native
artifact identities and macOS termination diagnostics remain unchanged.
