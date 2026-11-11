# Agent Note: Preserve Go Test Failure Evidence

Status: implemented

## Problem

A package can fail without a separate failure event for its active test. The
coverage runner's summary can then omit the test's panic, timeout or other
output, leaving a failed gate without the evidence needed to diagnose it.
Rerunning tests produces another observation and cannot recover the original
failure. Cancellation and disk exhaustion can also leave only partial logs.

## Decision

Both formal coverage entries retain the original stdout bytes from the same
`go test -json` process consumed by `go-cov`. A temporary `go` command adapter
applies only to the coverage invocation. It forwards the actual arguments,
working directory and environment, records each chunk, and respects downstream
backpressure. Other Go subcommands keep their ordinary output. The pinned
coverage tool, package selection, race policy and numerical gates remain the
owners described by the [coverage boundary decision](2026-11-06-go-module-coverage-boundary.md).

Each invocation uses a fresh directory within its coverage owner's evidence
directory. A completion marker records the byte count and Go process outcome
only after the stream ends and the file closes successfully. A failed test can
have a complete capture; a missing marker leaves the evidence partial. Capture
errors and a nominally successful invocation without complete capture fail the
validation entry. CI preserves these files alongside its coverage profile.

The existing command supervisor owns the entire coverage process group. The
adapter does not create another group or retry tests. This ownership matters
because a coverage subprocess can be killed before forwarding cancellation to
its child. The module invocation has a 30-minute outer bound; the lifecycle
invocation retains its 12-minute bound. Existing per-package and CI limits still
apply. The [validation guide](../../../../packages/daynight-server/README.md#coverage)
owns the evidence paths and marker interpretation.

## Alternatives

**Capture the coverage summary with an outer tee.** In
[`go-cov` v0.1.4](https://github.com/codetreker/go-cov/blob/404ae70e91e0d2a199cb0418e2010d22aef75b32/internal/coverage/parse.go),
test output is buffered by package and test. Package failure flushes only the
package buffer, and EOF does not flush unfinished test buffers. Capturing that
summary cannot recover omitted bytes.

**Patch the coverage tool locally.** This could expose its internal stream, but
would require maintaining and building a fork of the pinned dependency. The
adapter keeps the released tool and its coverage decisions intact. A future
upstream raw-output option could replace the adapter after equivalent failure
and cancellation behavior is verified.

**Rerun failures for detailed output.** A repeat can pass or fail differently and
loses the original scheduling and resource conditions. It also consumes the
limited retry budget without explaining the first result.

## Consequences

Failure analysis can use the unfiltered events from the exact coverage run.
Streaming bounds memory, but recording adds disk writes and retains evidence
until normal temporary-resource or artifact cleanup. Disk exhaustion becomes an
explicit validation failure instead of silently incomplete evidence.

This mechanism does not diagnose a historical failure whose raw stream was not
saved, and it does not make a passing retry evidence of a transient cause.
Business failures and races still require their own causal evidence and fixes.
