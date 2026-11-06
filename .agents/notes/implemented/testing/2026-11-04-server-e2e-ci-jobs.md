# Agent Note: Independent Server Coverage and E2E CI Jobs

Status: implemented

## Problem

Built-process acceptance and production package coverage shared one Go job despite
separate execution and resource lifetimes. Service and CLI processes overlapped
with production-package PostgreSQL tests, competing for build, CPU and database
resources. Go already overlapped package execution, so moving one package could
not be assumed to save its entire reported duration.

## Decision

The CI split originally created `verify-server` for coverage and
`verify-server-e2e` for the test-only process package, with separate PostgreSQL,
UniAuth, embedded Web build and installed CLI inputs. Both had 20-minute bounds
and contributed to the final job-result gate. The full local entrypoint ran both
modes sequentially. The [Go module validation boundary](2026-11-06-go-module-validation-boundary.md)
replaces that current division: the dedicated process package/job and installed
CLI/deadline orchestration are removed; the Go gate validates its own module.

The split preserved build, vet, pinned go-cov, critical-block and package/function
thresholds and exact total coverage. It excluded only the complete import path
of the test-only process package. Because the pinned tool used substring
matching, an exact `go list` match and recursive test-only-source check prevented
that exception from hiding production code. Those guards belonged to the removed
package; the current production scope retains no package exception.

The original coverage installation supported authentication assertions inside
`internal/server`. That package issued the normal PAT used by two installed-CLI
deadline probes. Keeping producer, private handoff, consumers and cleanup in one
job avoided transferring live credentials. E2E had its own installation,
`-count=1`, ten-minute test timeout, fresh service build, source/artifact proof,
refusals, competing writers and cleanup. The
[event-specific timing policy](2026-11-04-go-validation-timing.md) later disabled
race detection for PRs while retaining it locally and on main. The former local
stress-budget mode selected full-byte probes in coverage and then process E2E.

Initial routing conservatively selected both jobs for CLI source and packaging.
The [input-selection decision](2026-11-04-server-ci-input-selection.md) narrowed
lazy command inputs and semantic manifest equality; the
[version-only decision](2026-11-04-version-only-pr-ci.md) later skipped application
checks for strict whole-PR version changes. Current routing and commands belong
to the [README](../../../../README.md#ci-selection) and
[server guide](../../../../packages/daynight-server/README.md#go-module-validation-and-ci-evidence).
The former orchestration receipts recorded source revision/tree/dirty state,
actual packages, installation and cleanup; failure uploads preserved available
diagnostics. npm publication retained its own CLI verification responsibility.

## Alternatives

**Keep coverage and E2E in one job.** This avoided a second runner's preparation
but kept both resource workloads on one machine and waited for their full
lifetimes. Independent jobs made cost and evidence observable separately.

**Move all installed CLI validation and deadline probes to E2E.** Authentication
assertions contributed handler coverage and produced the probes' PAT. Moving
only the consumers required cross-job credentials; moving the producer changed
coverage ownership. The original split kept that chain together. The replacement
module boundary deliberately separates client and server assertions instead.

## Consequences

The split executed process E2E once and retained production gates, but duplicated
Web, UniAuth and CLI preparation. Aggregate work could grow while wall-clock time
fell; cache, queue and setup effects required source-bound measurements. The
slower job still determined server completion, and package costs were not
serially subtractable.

That optimization did not establish the final testing ownership. The replacement
boundary removes the process job and client coupling; this record preserves why
the original split kept them and why it made no guaranteed speedup claim.
