# Agent Note: Independent Server E2E Test Package

Status: implemented

## Problem

The service command's direct tests and cross-process acceptance have different
setup requirements. Sharing one package made selecting a direct `main` or `run`
test execute acceptance source checks, build a race-enabled server and initialize
the evidence receipt. Command test storage also depended on acceptance-global
state. The package boundary obscured ownership of these resources and prevented
the direct tests from running independently of that setup.

## Decision

The test-only Go package `cmd/e2e_tests` owns all built-process and installed-CLI
acceptance scenarios, the offline attachment migration scenario, their `TestMain`
and their fixtures. It builds the actual `cmd/daynight-server` executable and
retains isolated PostgreSQL schemas, storage roots, process control, source and
artifact checks, concurrency barriers, error assertions and cleanup evidence.
`go test ./...` discovers the package. The
[CI split decision](2026-11-04-server-e2e-ci-jobs.md) places its complete
execution in a separate validation mode and CI job. The
[Go validation timing decision](2026-11-04-go-validation-timing.md) later makes
instrumentation event-specific: local validation and main CI use race detection,
while PR CI disables it. The freshly built service matches its test binary's
actual race build tag.

At package extraction, the central Node orchestrator used
`--skip-result-packages cmd/e2e_tests` with `go-cov`: the pinned tool otherwise
interpreted this test-only package's `[no statements]` result as 0% against its
package threshold. That reporting exception used
[module-relative substring matching](https://github.com/codetreker/go-cov/blob/d6caf2759e330b48d69a543695e37002a48feb1d/internal/coverage/parse.go#L287-L301)
and preserved execution and every production coverage check. Independent E2E execution now removes the package
from coverage execution after verifying recursively that it contains only test
Go source. Production code belongs to its owning package so the execution
exception cannot hide product coverage.

`cmd/daynight-server` retains the executable and tests that call its internal
functions directly. Its tests own temporary storage, address allocation and
authenticated-request helpers independently of the E2E package. Selecting this
package does not build the acceptance executable or initialize acceptance
evidence. Direct tests that start the service still require PostgreSQL and the
normal UniAuth fixture.

This replaces the command-package placement selected by the original
[built-process decision](2026-10-19-server-process-acceptance.md).
That placement kept executable lifecycle proof near the composition root and
provided the fixture reused by the
[installed-CLI extension](2026-10-20-installed-project-task-acceptance.md).
The separate package preserves those verification responsibilities while giving
direct command tests their own setup and resource ownership.

## Alternatives

**Keep every test in the command package.** Fixture reuse would remain local, but
Go runs the package's `TestMain` before filtering individual tests. Direct command
tests would keep paying for binary construction and evidence initialization.

**Move only the scenario files.** Leaving temporary storage or address helpers
dependent on the original acceptance globals would preserve the setup coupling
or require another shared fixture layer. Each suite owns the small helpers
appropriate to its resources.

## Consequences

The complete gate retains its scenarios, event-specific race detection,
production coverage thresholds, installed CLI artifact checks and built-process
evidence. The independent E2E validation mode runs the complete test-only package; production
coverage remains in its owning packages. The binary still
targets the production command, and its execution remains separate from the
owning packages' statement coverage. Directory depth is unchanged, so module,
repository and migration paths retain their existing resolution.

The suites can be selected independently after their required inputs are
prepared. The [server validation guide](../../../../packages/daynight-server/README.md#built-process-acceptance-and-ci-evidence)
owns commands and receipt interpretation. Maintaining small helpers separately
keeps their resource lifetimes explicit; a shared fixture is justified only by
an actual common resource contract.
