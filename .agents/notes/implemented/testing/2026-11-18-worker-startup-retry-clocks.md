# Agent Note: Worker Startup Retry Clocks

Status: implemented

## Problem

Two Worker startup integration cases each incur the first five-second retry
window. The identity case checks lock ownership and cache admission before a
verified principal is available. The project-preparation case checks when an
inventory becomes publishable after authority adds an unmapped project.
[Hosted macOS logs](https://github.com/codetreker/daynight/actions/runs/44243743660/job/134600298999)
report 5.097 and 5.124 seconds for the two cases. Waiting for the eventual
configuration recovery also permits an early retry to pass.

## Decision

The [startup fixture](../../../../packages/daynight/test/commands/worker/runtime-startup.integration.test.ts)
holds the one abortable identity delay, checks the requested 5,000 ms and
observes the real lock and unopened account-bound cache before releasing the
retry. The second identity response remains independently held.

The project-preparation case compares the recorded retry deadline across a
new revision with the same target. Advancing to one millisecond before it must
leave the project unmapped and the inventory unpublished. The final millisecond
allows one retry, real persistence, and normal inventory publication. Its
readiness polling uses real time without advancing the configuration clock.

## Alternatives

**Use short real delays.** Startup and persistence would compete with these
delays on slow runners. An early retry could pass without an observation at the
deadline boundary.

**Resolve either delay immediately.** This would erase the period during which
the existing lock, cache, and inventory restrictions must hold.

## Consequences

The cases no longer need to wait out the two production intervals. Production
retry schedules, refusal classification, instance locking and persistence are
unchanged. The inventory test detects early retries for unchanged targets, in
addition to proving eventual recovery.
