# Agent Note: Independent Server E2E Test Package

Status: implemented

## Problem

The service command's direct tests and cross-process acceptance had different
setup requirements. Sharing one package made selecting a direct `main` or `run`
test execute acceptance source checks, build a race-enabled server and initialize
an evidence receipt. Command test storage also depended on acceptance-global
state, obscuring resource ownership.

## Decision

The package extraction originally placed built-process and installed-CLI
acceptance, offline attachment migration, `TestMain` and their fixtures in the
test-only `cmd/e2e_tests` package. It built the actual service and retained
isolated PostgreSQL schemas, storage roots, process control, provenance,
concurrency barriers, error assertions and cleanup evidence. The later
[CI split](2026-11-04-server-e2e-ci-jobs.md) gave it independent execution;
[event-specific timing](2026-11-04-go-validation-timing.md) selected race mode,
with the child service matching its parent test binary's build tag.

The [Go module validation boundary](2026-11-06-go-module-validation-boundary.md)
replaces that package's current ownership and removes it. Direct tests of command
internals remain in `cmd/daynight-server`, with their own temporary storage,
addresses and authenticated-request helpers. Starting the Go service directly
still requires PostgreSQL and the normal UniAuth fixture.

At extraction, the Node orchestrator used
`--skip-result-packages cmd/e2e_tests` because the pinned `go-cov` interpreted the
test-only package's `[no statements]` result as 0%. That reporting exception used
[module-relative substring matching](https://github.com/codetreker/go-cov/blob/d6caf2759e330b48d69a543695e37002a48feb1d/internal/coverage/parse.go#L287-L301)
while retaining execution and production coverage. The later split excluded the
full package path from coverage execution after verifying the exact package match
and recursively rejecting production Go files in that directory. Those guards
were specific to the removed test-only package; the current gate has no such
production coverage exception.

The original command-package placement is recorded by the immutable
[built-process decision](../../archived/testing/2026-10-19-server-process-acceptance.md).
It kept lifecycle proof near the composition root and supplied the fixture for
the [installed-CLI extension](../../archived/testing/2026-10-20-installed-project-task-acceptance.md).
Package extraction preserved that assertion set while giving direct tests
independent setup; it did not yet separate assertions by product owner.

## Alternatives

**Keep every test in the command package.** Go invokes `TestMain` before filtering
individual tests, so direct tests would still pay for binary construction and
acceptance evidence initialization.

**Move only the scenario files.** Storage and address helpers would remain
coupled to acceptance globals or require another shared fixture layer. Separate
small helpers made the resource lifetimes explicit.

## Consequences

Extraction made the original suites independently selectable without changing
module, repository or migration path depth. It preserved production thresholds
and the original binary/artifact proof, but left cross-product assertion
ownership in the Go test package. The replacement boundary removes that coupling;
this record retains the reasons for the historical package extraction.

The [server validation guide](../../../../packages/daynight-server/README.md#go-module-validation-and-ci-evidence)
owns current commands. Historical process receipts remain bound to their tested
revisions and do not establish the current gate's execution or missing proof.
