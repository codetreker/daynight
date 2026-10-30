# Agent Note: Independent Worker Runtime Reporting

Status: implemented

## Problem

Worker execution polling can include long operations, wait longer than the
online threshold, or skip candidate acquisition when capacity is full. A
runtime view must still receive observations while no task is available.
Collecting these observations must preserve task ownership, distinguish unknown
inventory from actual idleness, and avoid changing the native environment merely
to inspect its installed software.

## Decision

A process-owned reporter starts after stable identity and authenticated principal
admission. It reports immediately and on an independent 30-second timer; complete
inventory observations and confirmed claims also trigger it. One running attempt
and one coalesced pending trigger bound concurrency without retaining old report
bodies. The [client design](../../../../docs/design/daynight-worker-reporting.md)
owns scheduling, sampling, cancellation and diagnostics; the
[client requirements](../../../../docs/spec/daynight-worker-reporting.md) define
the observable guarantees. The [account snapshot decision](2026-10-28-worker-runtime-snapshots.md)
retains ownership of server normalization, persistence and queries.

The reporter reuses the coordinator's complete immutable task references. It
keeps unknown inventory as null, preserves successful observations through read
failures, and uses an explicit empty array only for observed idleness. Resource
samples, bounded version caches, inventory and diagnostic transition state live
in the process, without adding telemetry fields to the claim SQLite index.

Pure version extraction is shared with native preflight, while launch validation
and integration repair remain in preflight. Resource reporting can therefore
show an installed older CLI. Private Herdr versions come from an uncached
read-only ping that neither starts the daemon nor initializes the execution
backend, preserving pure-Web independence.

A report has a 15-second attempt budget: up to five seconds for collection,
including native termination and join, and up to ten seconds for HTTP. Typed
unconfirmed command cleanup prevents replacement probes for that tool while
other fields continue reporting. A timed-out statfs call retains a single gate
until the uncancellable OS request settles. Root cancellation synchronously
stops scheduling and aborts every job, including terminal cleanup, before any
reporter join. Runtime then joins reporting and jobs before directly stopping
execution resources and releasing its stores and lock. Unfinished worktrees and
claim rows retain the existing shutdown semantics.

## Alternatives

**Report only inside the execution tick.** Candidate queries do not run at full
capacity, and the complete tick can exceed the liveness interval. A timer that
waits for that tick would inherit the same gaps. Independent scheduling makes
report cadence unrelated to task acquisition and execution latency.

**Reuse repairing launch preflight as the version probe.** Preflight can start a
private daemon, install integrations, reject old versions and inspect task-local
launch capabilities. Those side effects would make observation change the
machine and make pure-Web reporting depend on Herdr. Sharing only pure version
extraction preserves native parsing without acquiring launch responsibilities.

**Persist telemetry and reporting progress in SQLite.** Replaying stored
observations after restart would misrepresent their age and require a second
recovery protocol beside current task ownership. The latest server snapshot
already retains the last observation; process-local state allows a restarted
reporter to begin with fresh sampling and explicitly unknown inventory.

## Consequences

Idle, busy and pure-Web Workers can supply the same snapshot protocol without
changing task versions or claims. Report failures do not control execution, and
sanitized transition diagnostics do not disclose native output or credentials.

Observation adds periodic OS and bounded subprocess work. Native version data
may be up to 60 seconds old, with its original checkedAt. OS filesystem I/O
cannot be cancelled; a stuck operation makes that field unavailable without
accumulating probes. Unconfirmed native cleanup disables that tool's probes for
the remaining process lifetime and remains an exit failure. A slow reporter join
cannot extend terminal cleanup: all jobs have already been cancelled, so
shutdown preserves unfinished worktrees and local rows. Neither the client
nor the latest server row retains resource history or proves provider login,
launch capability, or completed native task execution.
