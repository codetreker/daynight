# Agent Note: Ubuntu Ordinary Validation Budget

Status: implemented

## Problem

The complete ordinary Ubuntu CLI workload can consume its job budget before
reporting every test file. A cancelled job does not prove that the remaining
files passed. The [observed job](https://github.com/codetreker/daynight/actions/runs/45647406232/job/139322201133)
spent 32 seconds installing dependencies and 531 seconds running Vitest before
cancellation. Tests were still completing near the deadline, and the retained
failure diagnostics contained no assertion failure.

The [direct main baseline](https://github.com/codetreker/daynight/actions/runs/45538715542/job/138957029870)
finished successfully in 573 seconds, including a 491-second test command.
Other nearby successful runs completed substantially faster. These observations
show limited headroom and execution variability; they do not identify CPU,
memory or I/O causes or establish a regression in the usage collector.

## Decision

The ordinary Ubuntu matrix entry has a 12-minute total job budget. It retains
the complete test discovery and execution command, dependency installation,
source checks, isolation, assertions, individual test deadlines, diagnostics
and successful-result requirement. Windows ordinary jobs and all installed CLI
jobs keep 10 minutes; the
[macOS budget](2026-11-12-macos-ordinary-validation-budget.md) keeps 20 minutes.
The [development guide](../../../../docs/development.md#cli-development) owns
these current validation commands and budgets.

This is a bounded execution-budget adjustment, not a performance optimization.
A further cancellation requires diagnosing the unfinished workload rather than
successively increasing the deadline without new evidence.

## Alternatives

**Keep ten minutes and repeat the full job.** The direct baseline already used
most of that budget. A faster rerun could pass, but would not supply durable
headroom for the observed ordinary workload.

**Introduce Ubuntu shards or change concurrency.** The
[Windows shard decision](2026-11-11-windows-cli-verified-shards.md) shows how to
preserve complete discovery with independent runners. Applying that mechanism
to Ubuntu requires additional allocation and evidence validation; the observed
shortfall does not yet justify that broader verification change.

**Reduce test selection or relax assertions.** The ordinary native job supplies
whole-suite evidence. Omitting tests would change the required proof rather than
allow the same workload to finish.

## Consequences

An unfinished Ubuntu job can take up to twelve minutes to fail. Passing requires
actual completion of the full selected suite and job; the longer budget does not
turn previous cancellation into success. The budget includes diagnostics and
finalization, while runner allocation remains a separate queue.
