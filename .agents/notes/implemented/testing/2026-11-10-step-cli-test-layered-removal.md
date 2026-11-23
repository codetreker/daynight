# Agent Note: Step CLI Test Layered Removal

Status: implemented

## Problem

An optional Go server test drove the built CLI through real authentication and
PostgreSQL to check Step text boundaries. Its process, admission and persistence
observations crossed several test owners and the test normally skipped when its
CLI path was not supplied. Removing it requires preserving the distinct evidence,
including the physical state observed after refusals.

## Decision

The original migration gave the CLI module's
[process proof](2026-11-10-step-cli-text-process-proof.md) ten exact text requests,
versions, refusal diagnostics and actual Node process lifecycle. Core admits the
same Add and Change sequence and checks refusal fields, zero mutations and
unchanged input. Service tests control Core refusal and verify that the actual
callback suppresses subsequent writes and results. HTTP tests parse and forward
the exact text and check protocol responses. PostgreSQL store tests exercise
actual SQL rollback and complete persisted readback, independently of upper-layer
controlled outcomes. The dedicated server identity fixture and optional
cross-module driver were removed.

The [CLI retirement](../simplification/2026-11-23-retire-cli-task-steps.md)
removes that client's process proof with its commands. The server layers retain
their independent ownership.

## Alternatives

**Keep the optional cross-product test.** This would retain a single end-to-end
observation but also retain a normally skipped CLI, authentication and database
fixture in ordinary Go module discovery.

**Replace physical observations with controlled responses.** CLI and Service
fixtures cannot prove persisted state or rollback; actual SQL and readback remain
with the Store owner.

**Add the text matrix to Store or real PostgreSQL to CLI.** This would duplicate
business admission at the storage layer or couple the CLI module to the server
and database again.

## Consequences

The individual layers preserve their respective guarantees; no controlled fixture
claims to prove a physical refusal. The old optional test did not inject partial
writes, while the Store witnesses do exercise actual writes followed by rollback.
The largest values entered the CLI process via a test-only argument file, so OS
maximum argv capacity was not established. The ten child processes added CLI
test cost while that capability existed;
removing the normally skipped Go entry did not establish a routine CI speedup.
Other cross-module test migrations remain independent work.
