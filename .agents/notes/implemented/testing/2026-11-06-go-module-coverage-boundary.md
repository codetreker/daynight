# Agent Note: Go Module Coverage Boundary

Status: implemented

## Problem

Server tests exercise production packages through HTTP and service composition.
Counting only each test package's own statements loses coverage of those calls.
The server also needs its numerical coverage thresholds to remain effective
after the cross-product acceptance harness is removed.

## Decision

The Go module check selects all listed production packages for `-coverpkg` and
enforces package, function and unrounded total coverage gates. Critical-block
failure is disabled by the checked-in configuration.
It runs with race detection locally and without race detection in PR and main
CI. CI overrides an inherited race flag. The coverage comparator's own tests
run as part of the check. Package concurrency is limited to two because the
isolated schemas share the database-wide migration advisory lock. Stress
workloads remain a separate local entry.

The data-only Web resource overlay is inherited through an absolute,
module-derived file path. Go runs coverage metadata extraction for packages
without tests from a temporary build directory; a module-relative overlay file
cannot be opened there. Quoting the complete flag preserves module roots with
spaces. The metadata child consumes already-built coverage data, so the checked-in
source replacement paths keep their module-build semantics.

The [snapshot cancellation decision](2026-11-06-snapshot-cancellation-observation.md)
records how database query observation separates operation cancellation from
connection and transaction startup.

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

**Keep the inherited overlay file relative to the module.** This works for the
main build but fails when Go changes directories to extract metadata from a
package without tests. Adding package tests merely to avoid that tool path would
hide the working-directory dependency.

## Consequences

The gate includes cross-package calls without excluding production packages or
lowering thresholds. Coverage is still a measurement of executed statements,
not evidence that each behavior has an equivalent assertion. Database-backed
tests retain their isolated PostgreSQL and explicit resource cleanup.
The script regression executes its coverage child from another directory and
requires the inherited flag to open the original overlay, including when the
module root contains spaces. Production builds retain their real Web asset
requirement; source fixtures remain confined to module validation.
