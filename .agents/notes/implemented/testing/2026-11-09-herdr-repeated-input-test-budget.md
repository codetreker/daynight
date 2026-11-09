# Agent Note: Budget Repeated Herdr Input Integration Checks

Status: implemented

## Problem

The [durable Herdr integration test](../../../../packages/daynight/test/commands/worker/herdr-durable-integration.test.ts)
for repeated known-menu refusals checks eleven rejected inputs and two successful
inputs in sequence. It retains real SQLite lifecycle and input journals using
WAL and synchronous=FULL. Its default five-second test deadline covers the whole
sequence, while each fixture caller operation has a separate three-second
budget. Valid operations can exhaust the aggregate deadline while continuing to
make progress.

A [CI failure](https://github.com/codetreker/daynight/actions/runs/42504711734/job/128804981846)
reached the outer test timeout without identifying the operation in progress.
The source of that run's delay is unconfirmed. Controlled delayed inspector
responses reproduce aggregate timeout exhaustion, but do not establish that
the CI run experienced the same delay.

## Decision

Only this test has an explicit fifteen-second timeout. Both five-attempt refusal
loops, every assertion, the three-second caller operation budgets, and the real
SQLite journals remain intact. The fixture still verifies that repeated refusals
retain the original pending body, that dismissal permits input without a new
launch, and that continuation produces exactly the expected native writes.

## Alternatives

**Keep the default timeout and rerun failures.** A passing retry would not repair
the aggregate budget or explain the original delay.

**Reduce the refusal loops or replace SQLite with a mock.** Either changes the
repeated-refusal or durable-state coverage that this test owns.

**Increase the suite timeout.** Unrelated tests would take longer to report a
hang, even though this decision concerns one sequential integration scenario.

## Consequences

The complete sequence has more scheduling and storage headroom without changing
production behavior or individual operation deadlines. An outer test hang can
take up to fifteen seconds to report. This limit is a test allowance, not a
runtime latency guarantee. Further failures require phase-level timing evidence
before another budget increase; the original CI delay remains unexplained.
