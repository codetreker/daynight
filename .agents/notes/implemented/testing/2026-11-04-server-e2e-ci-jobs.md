# Agent Note: Independent Server Coverage and E2E CI Jobs

Status: implemented

## Problem

Built-process acceptance and production package coverage share a Go validation
job even though they have separate execution and resource lifetimes. The E2E
package starts real service and CLI processes, while coverage tests run production
packages against PostgreSQL. Their overlapping CPU, database and build demand
can increase validation latency. Package durations already overlap within Go's
test runner, so removing one package from a job does not imply a corresponding
reduction in elapsed time.

## Decision

The server selector enables two independent jobs in
[the checks workflow](../../../../.github/workflows/checks.yml):
`verify-server` runs `bash scripts/check.sh --coverage`, and
`verify-server-e2e` runs `bash scripts/check.sh --e2e`. Both have a 20-minute bound
and prepare their own PostgreSQL, pinned UniAuth, embedded Web build and installed
CLI. The final `checks` job waits for both and rejects failed or cancelled jobs.
The shared selector includes the CLI source, packaging/preparation inputs and Web
build inputs actually consumed by both jobs. Documentation exclusions and
unaffected-module skipping retain their existing semantics.

The complete local `bash scripts/check.sh` entrypoint runs coverage followed by
E2E. Coverage owns build, vet, race-enabled `go-cov`, critical-block enforcement,
package/function thresholds and the exact total statement comparison. The Node
orchestrator excludes only the full import path of the test-only `cmd/e2e_tests`
package from `go-cov` execution. The pinned tool matches exclusions by substring,
so `go list ./...` must show that the full-path match selects exactly that package;
extended or nested matches fail. Before validation it also recursively rejects
non-test Go source there. This preserves the
[package separation](2026-11-03-server-e2e-package.md) without a production
coverage exception. The checked-in coverage configuration keeps every production
package, file and function in scope.

The coverage installation also supports `internal/server` authentication
assertions. That package produces the normally issued PAT consumed by the two
installed-CLI deadline probes; their private credential handoff and cleanup stay
with the producer. E2E has its own installation and runs the complete test-only
package with race detection, `-count=1` and a ten-minute timeout, retaining fresh
server builds, source and artifact provenance, refusal paths, concurrent writes
and cleanup assertions. Neither job transfers credentials or live resources to
the other. Routine CI excludes stress tests; the explicit local stress-budget
entrypoint still runs complete coverage and E2E validation with full-byte probes
in the coverage phase.

The server guide owns
[commands and evidence](../../../../packages/daynight-server/README.md#built-process-acceptance-and-ci-evidence).
The coverage artifact retains its existing name and profile/deadline receipts;
the E2E artifact owns process/scenario and installation receipts. Each orchestration
receipt records the source revision, tree and dirty state and actual package list. Their failure
uploads retain available diagnostics. The manual npm publication workflow keeps
its existing CLI validation responsibilities.

## Alternatives

**Keep coverage and E2E in one job.** Go already executes package tests in
parallel, avoiding a second runner's preparation cost. It also keeps the two
resource workloads on one runner and requires waiting for both before the
coverage job completes. Independent jobs let their full lifetimes overlap and
make their durations and evidence separately observable.

**Move all installed CLI validation and deadline probes to E2E.** The installed
authentication assertions exercise production HTTP handlers and contribute to
production coverage. Their normally issued PAT is the deadline probes' required
input. Moving the probes alone would require a cross-job credential handoff;
moving their producer would alter production coverage ownership. Keeping this
chain within coverage preserves both contracts without shared live resources.

## Consequences

E2E executes once across the two CI jobs, and all production coverage gates
remain intact. Both jobs need their own Web, UniAuth and CLI preparation, so
aggregate runner work can grow even when elapsed validation time falls. Cache
state, preparation and queue delays affect comparisons. The slower of coverage
and E2E remains the server completion path; existing expensive production package
tests can still dominate it. Source-bound CI observations determine the actual
benefit; the split does not establish a guaranteed speedup or remove other test
bottlenecks.

Future production Go code placed under `cmd/e2e_tests` fails validation rather
than silently disappearing from coverage. It must move to its production owner
or require reconsidering the package boundary and execution selection together.
The split needs no general CI scheduler or broader production-test rewrite;
other bottlenecks can be evaluated independently using the separate durations.
