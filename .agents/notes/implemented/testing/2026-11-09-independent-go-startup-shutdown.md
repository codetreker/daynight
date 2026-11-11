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
The lifecycle runner also owns the focused `internal/service/webhook`
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

Lifecycle command deadlines use the existing Node.js runtime instead of GNU
`timeout`, which native macOS does not provide. The command wrapper streams
output, preserves ordinary exit codes, and reports expiry or interruption as
failure. It sends TERM to the owned process group, escalates to KILL after the
grace period, and terminates remaining group members when the leader exits.
On macOS, a group containing only unreaped zombies can reject a repeated signal
with `EPERM`: the [Darwin group-signal implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_sig.c#L1675)
filters zombies before counting signalable members. The wrapper resolves only
Darwin `EPERM` through a bounded `/bin/ps` observation. A complete, successful
table containing the observer itself must show either no group members or only
same-user zombies. Live members, foreign ownership or unknown states in that
group, malformed or partial output, observation errors and deadlines retain the
cleanup failure. The observer is bound to the returned `ps` PID; macOS runs
`ps` with effective UID 0, and unrelated processes can report an unknown state.
Portable process tests verify expiry, cancellation and descendant cleanup;
ordinary module tooling requires no additional command-line dependency.

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

**Require GNU timeout for native validation.** Linux CI provides it, but standard
macOS does not. Requiring it would add a dependency to both lifecycle validation
and the module entry's portable runner tests. Node.js is already required by
both entries and supplies process groups, signal handling and bounded timers.

**Ignore `EPERM` or omit cleanup after escalation.** A permission error can still
mean that live descendants remain. The final group signal stays in place, and
the macOS exception requires a successful observation that no member can run.
`/bin/ps` is part of macOS; its bounded fallback adds no installed tool.

## Consequences

Module, command lifecycle and normal API validation have separate results and
can run concurrently. The lifecycle job adds its own tool and PostgreSQL
preparation. Complete local server validation runs both coverage scripts; a
successful module-only run does not establish command lifecycle validation.
Independent scheduling alone does not establish a measured reduction in complete
CI duration.

A Darwin cleanup error can require up to one additional second to inspect the
group. An unavailable or ambiguous observation fails validation rather than
claiming successful cleanup. Zombie recognition confirms process termination;
the owning parent remains responsible for reaping its exited child.

The command package retains its full process, persistence and boundary proofs;
this decision changes their execution owner and consolidates the separate normal
API flow. Further restructuring of mixed business matrices inside restart tests
has its own proof-preservation cost and is not required by the runner split.
