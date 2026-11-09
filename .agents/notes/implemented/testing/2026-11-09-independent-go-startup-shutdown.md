# Agent Note: Independent Go Startup and Shutdown Validation

Status: implemented

## Problem

Command tests start real Server and authentication processes, initialize
PostgreSQL schemas, observe migration and shutdown races, and read persistent
state after restart. Running these mechanisms inside module coverage gives
ordinary Go tests and process lifecycle tests one result and one execution
queue. A normal Project/Task API flow in the command package also repeats the
assembled API suite while mixing protocol refusals with lifecycle assertions.

## Decision

`verify-server-startup-shutdown` is an independent job named
`verify (Go server startup & shutdown)`. It shares the module job's server
selection and waits only for change detection. It owns its PostgreSQL service
and invokes `scripts/startup-shutdown.sh`. The final gate requires actual success
from both selected Go jobs; a selected skipped job cannot replace execution.

All command tests remain in `cmd/daynight-server` behind the explicit
`startupshutdown` tag. This preserves access to the private `main` and `run`
entries while keeping command tests outside ordinary module discovery. Existing
`race`, `webhooktest` and `stress` conditions remain additional requirements.
The lifecycle runner also owns the focused `internal/server`
`TestWebhookRunnerAbruptProcessRecovery` witness, retaining its dedicated
transport build, bounded execution and abnormal-process observations. Ordinary
CI does not enable stress workloads.

Coverage is partitioned by production owner. `scripts/check.sh` selects module
tests and every production package except the command package for `-coverpkg`.
The lifecycle runner vets tagged command tests and runs `go-cov` from the command
directory with command-only `-coverpkg`. Both use the checked-in package and
function thresholds and independently require raw statement coverage strictly
greater than 90%. Every production package belongs to one partition. Since both
partitions exceed 90%, their combined production statement coverage also exceeds
90%; neither relies on coverage supplied by another job. This refines the
[coverage boundary decision](2026-11-06-go-module-coverage-boundary.md) without
exempting production statements from validation.

The shared validation environment supplies the existing race policy and an
absolute-path unit Web resource overlay. Absolute replacement keys and values
remain valid both when command coverage changes directory and when its nested
fresh-process build returns to the module root. Production builds retain real
Web resources. Each runner clears test-result caches and exposes preparation,
compiler, assertion, coverage and cleanup failures.

The normal Project/Task flow is consolidated into the existing API lifecycle
scenario: create the same Project and Task, verify initial state and version,
advance status, and read back the completed Task through the original filters.
The HTTP owner retains invalid-body refusal; command lifecycle tests retain
listener-origin binding and cancellation after observed startup. The independent
[API integration decision](2026-11-09-independent-go-api-integration.md) continues
to own normal assembled flows and its production build inputs.

## Alternatives

**Keep all command processes in module coverage.** This shares preparation but
retains one execution queue and job result for ordinary module assertions and
migration, restart and shutdown mechanisms.

**Move command process matrices to API integration.** The API suite owns normal
sequential flows. Revocation races, failed migrations and forced shutdown remain
with their mechanism owner; relocating their successful setup requests would
not move the proof that requires the process.

**Merge profiles in a third coverage job.** A combined profile could retain the
original coverage universe, but requires coordinating source-bound profiles,
additional artifact transfer and a dependent gate. Disjoint ownership with the
same strict threshold on each partition retains the full-production threshold
without that coordination.

## Consequences

Module, command lifecycle and normal API validation have separate results and
can run concurrently. The lifecycle job adds its own tool and PostgreSQL
preparation. Complete local server validation runs both coverage scripts; a
successful module-only run does not establish command lifecycle validation.
Independent scheduling alone does not establish a measured reduction in complete
CI duration.

The command package retains its full process, persistence and boundary proofs;
this decision changes their execution owner and consolidates the separate normal
API flow. Further restructuring of mixed business matrices inside restart tests
has its own proof-preservation cost and is not required by the runner split.
