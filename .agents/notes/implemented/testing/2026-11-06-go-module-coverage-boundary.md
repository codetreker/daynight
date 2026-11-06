# Agent Note: Go Module Coverage Boundary

Status: implemented

## Problem

Server tests exercise production packages through HTTP and service composition.
Counting only each test package's own statements loses coverage of those calls.
The server also needs its critical-block and strict total gates to remain
effective after the cross-product acceptance harness is removed.

## Decision

The Go module check selects all listed production packages for `-coverpkg` and
enforces critical-block, package, function and unrounded total coverage gates.
It runs with race detection locally and without race detection in PR and main
CI. CI overrides an inherited race flag. The coverage comparator's own tests
run as part of the check. Package concurrency is limited to two because the
isolated schemas share the database-wide migration advisory lock. Stress
workloads remain a separate local entry.

Snapshot cancellation tests observe the database query before triggering or
awaiting cancellation. The operation deadline still belongs to the snapshot
context, so cleanup and error classification are tested after the transaction
has actually begun.

The server's HTTP and database tests own service behavior, while the independent
product journey owns normal connections between products. The
[validation guide](../../../../packages/daynight-server/README.md#validate)
describes the commands and current thresholds.

## Alternatives

**Count each package's own tests only.** This misses statements executed through
other server packages and changes the coverage universe when scenarios move to
their HTTP or service owners.

**Retain the installed-client acceptance harness in the coverage run.** That
requires another product and its credentials to validate the Go module and
keeps unrelated client and server failures coupled.

**Use the host's default package concurrency.** On hosts with many CPUs,
concurrent schema setup queues behind the same migration lock long enough to
exceed fixture deadlines, despite the schemas being isolated.

## Consequences

The gate includes cross-package calls without excluding production packages or
lowering thresholds. Coverage is still a measurement of executed statements,
not evidence that each behavior has an equivalent assertion. Database-backed
tests retain their isolated PostgreSQL and explicit resource cleanup.
