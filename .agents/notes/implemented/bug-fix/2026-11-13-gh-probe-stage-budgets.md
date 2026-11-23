# Agent Note: Separate gh preparation and execution budgets

Status: implemented

## Problem

A complete read and hash of the selected gh executable can consume the shared
10-second probe budget before the version command starts. The resulting failure
identifies preparation cost, but does not measure whether the native command
could execute within its own limit.

## Decision

The gh probe gives provenance preparation a separate 20-second deadline and
then gives the version command its full 10-second execution budget. An isolated
helper resolves and reads the selected file, recording its byte count, SHA-256
and elapsed time. The deadline terminates and joins that helper when preparation
blocks. A failed or expired preparation stops before the version command starts;
its failure remains distinguishable from a native execution failure. The
[development guide](../../../../docs/development.md#cli-test-fixtures) owns the
current validation workflow.

This replaces the shared-budget choice in the archived
[cold-start preparation decision](../../archived/bug-fix/2026-10-20-gh-cold-start-preparation.md).
The earlier evidence for sequential preparation and native execution remains
relevant; its single-budget policy no longer describes the probe.

## Alternatives

**Keep a shared deadline.** A slow provenance read can leave no time to run the
command whose version the probe is intended to verify.

**Check time between synchronous reads.** This detects an expired budget after
a read returns, but cannot interrupt a blocked resolution or read.

**Omit or approximate the hash.** Metadata alone would not retain complete
selected-file provenance, and it would not replace native version execution.

## Consequences

The gh probe can take longer than either individual stage, while each stage has
its own limit and failure evidence. Process startup and operating-system
termination remain subject to the host; the outer CI job deadline still bounds
the complete validation job. It retains the full selected-file hash and actual
native version result. File contents can still change after preparation, so the
hash is evidence of the observed file, not a security identity guarantee.
