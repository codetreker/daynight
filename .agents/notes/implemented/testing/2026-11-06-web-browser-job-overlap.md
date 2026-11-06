# Agent Note: Overlap Navigation and Production Browser Validation

Status: implemented

## Problem

The second Web browser job runs three navigation suites before starting its
production acceptance runner. Navigation builds, browser work and teardown form
a serial prefix even though their fixtures do not use the production targets.
Reducing an individual case does not establish a shorter CI job; the execution
schedule and its complete resource lifetime must be measured together.

## Decision

Chromium and its OS dependencies finish installation before browser validation
starts. The three navigation commands remain serial in one branch while the
existing production acceptance runner executes in a second branch. Quality mode
and the first shard's acceptance path retain their existing schedules.

Navigation uses ports 4193, 4194 and 4198, dedicated Vite cache/output directories
and browser-routed API fixtures. Its hosts do not write production build outputs
or use production service databases. Acceptance retains its run/phase-private
browser inventory, installed CLI receipts, credentials and process ownership.
Each target keeps its existing one-worker execution, source/image checks and
native/container preparation and cleanup barriers. Scenario IDs, native
Playwright sharding, canonical union and once-only check ownership are unchanged.

Both branches share the existing cancellation controller. A failure aborts it
promptly, and the wrapper waits for both branches to settle before reporting
success, cancellation or failure. Distinct operation and cleanup errors remain
available; cancellation does not release another branch's owned resources.
Existing command wrappers still require complete process-group termination.
The [functional target decision](2026-11-04-web-functional-target-overlap.md)
continues to own the production runner's independent target resources.

The [Web validation guide](../../../../packages/daynight-web/README.md)
owns commands and receipts. Validation measures the complete browser job and
its major phases under comparable resources, including the additional concurrent
navigation browser. Local scheduling tests prove ordering and error propagation;
real browser/deployment checks prove native work and resource cleanup. Hosted
job measurements remain separate from constrained-container observations.

## Alternatives

**Keep navigation as a serial prerequisite.** This avoids extra concurrent CPU
and memory use, but delays independent production preparation and browser work
until all navigation hosts finish.

**Increase workers inside a production target.** Cases share a target's database
and controlled fault state. More workers would change that isolation boundary;
independent navigation hosts provide concurrency without sharing those states.

**Move cases between shards at the same time.** Repartitioning could reduce a
later imbalance but changes another variable. The scheduling change keeps the
existing selection and records which job becomes the workflow's critical path.

**Share artifacts across runners.** This introduces handoff dependencies and
ownership beyond the serial prefix. Existing source builds and per-run receipts
remain sufficient for this scheduling change.

## Consequences

The second browser job can overlap its navigation prefix with production work.
CPU, memory and I/O competition may lengthen either branch, so saved serial time
is only a model until whole-job measurements confirm it. Cancellation waits for
real cleanup, which can finish after the first error.

A shorter second shard may move the workflow bottleneck to the first shard or
Go validation. Job improvement and overall workflow improvement therefore have
separate evidence. No fixed speedup, cached test result or relaxed gate follows
from this concurrency choice.
