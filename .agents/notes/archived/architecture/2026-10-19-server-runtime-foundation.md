# Agent Note: Go Service Runtime Foundation

Status: implemented

## Problem

The task-management API needs a process that verifies PostgreSQL before serving,
owns HTTP and database resources, and stops without cancelling useful in-flight
work prematurely. Its validation must prove real database behavior and reject
coverage equal to 90%, while preserving the existing review CLI checks.

## Decision

The independent `packages/daynight-server/` module provides the Go executable,
strict loopback configuration, PostgreSQL connection ownership and HTTP
lifecycle.
The [service design baseline](2026-10-19-daynight-server-task-design.md) continues
to own the overall domain architecture.

Startup opens and verifies one concrete store and binds the loopback listener.
It constructs the handler from that same store before accepting requests.
A handler factory permits the composition
root to assemble service-backed routes without another connection pool or
mutating a running server. The
[authentication activation](../../implemented/architecture/2026-10-22-authentication-activation.md) extends that
factory with required Config and an error result; failed composition closes the
already acquired listener, database and file root before accepting requests.
There is no substitute database implementation.

Shutdown signals trigger HTTP draining. Request contexts have a separate owner,
so the signal does not cancel every request before the grace period begins.
Draining has a deadline; on expiry the runtime cancels remaining requests and
closes their HTTP connections before releasing the database pool. Unexpected
Serve failures use the same cleanup path. Database errors retain their original
cause, while diagnostics expose known-safe phase and category information.
Request logs carry an ID, method and route template instead of raw URLs or bodies.
A handler panic emits sanitized request correlation and aborts the HTTP response
through `http.ErrAbortHandler`, retaining failure without emitting raw panic text.

Go 1.27.2, pgx v5.11.0 and PostgreSQL 18.6 are fixed for this foundation. All
runtime checks and Go caches use project-local paths. PostgreSQL tests are
mandatory: a missing or inaccessible database is a failing prerequisite. Runtime
cancellation tests observe the uniquely marked handler SQL in PostgreSQL
`active`/`Timeout/PgSleep` state from an independent connection before canceling
the client or starting drain. The
[acceptance-readiness decision](../testing/2026-10-20-observable-acceptance-readiness.md)
owns the observation and cleanup ordering; existing cancellation, drain and
connection-health assertions remain unchanged.

The foundation originally added the Go CI job alongside the existing three
native CLI jobs and required all of them in the aggregate. The later
[module-scoped CI decision](../process/2026-10-21-module-scoped-pr-ci.md) selects
PR jobs by affected module while preserving full main-push validation and each
selected job's workload. The pinned go-cov checks package coverage at
85%, function coverage at 80%, critical blocks, and total coverage at 90%.
No product file or function is excluded; the default `ForTest` suffix exclusion
is explicitly cleared.

An additional check of that same raw profile enforces total coverage strictly
greater than 90%. It counts each block's statements once, merges duplicate
execution counts, rejects malformed or empty reports, and uses integer
`covered * 10 > total * 9`. This tightens the inclusive design baseline to the
selected strict requirement. It is necessary because pinned go-cov accepts
equality and rounds its printed total; see its
[comparison and output](https://github.com/codetreker/go-cov/blob/d6caf2759e330b48d69a543695e37002a48feb1d/internal/coverage/report.go#L197-L231).

## Alternatives

**Set the total threshold to 91%.** This would reject equality at 90% but also
reject valid results between 90% and 91%. Reading statement counts implements
the exact requested boundary without changing package or function gates.

**Read the displayed total percentage.** Rounding cannot distinguish an exact
90% result from a slightly higher one. The raw profile supports an exact
comparison, including large statement totals.

**Cancel request contexts directly from the signal context.** This would stop
database operations before HTTP draining can finish. Separate request ownership
allows completed work during the grace period and explicit cancellation after
that period.

## Consequences

Runtime and coverage behavior can be validated before business APIs exist.
The shared validation command builds the executable, runs vet and race tests,
checks go-cov rules, and applies the strict total comparison. Boundary tests
exercise equality, rounding, duplicate blocks and invalid reports. Runtime tests
use a task-owned PostgreSQL instance rather than a simulated store.

The coverage checker uses Node.js 24, already required by this repository. The
Go module does not become a pnpm package or require a reviewer package-version
increase. Subsequent task implementations retain the same validation entry
point and update current delivery statements with their actual behavior.
