# Agent Note: Shared completion clock

Status: implemented

## Problem

Completion age must advance on pages with no running tasks while execution
durations remain tied to their persisted endpoints and server time. Separate
row timers and snapshot-dependent providers would multiply work or remount
reading and draft state as data arrives.

## Decision

The existing project clock supplies independent completion readings and running
execution samples through one visible-page interval. Page-root providers retain
the store across first receipt and same-project presentation changes. An online
snapshot anchors completion age at its nanosecond `observedAt`; a local snapshot
uses its local time only for provisional display. Empty input leaves samples and
settings unknown. The completion hook retains its reading until its display
bucket changes. The [timing design](../../../../docs/design/daynight-task-timing.md)
owns the current lifecycle and data contracts.

This extends the earlier [Goal graph clock fix](../bug-fix/2026-11-12-goal-graph-execution-clock.md),
whose graph-local provider no longer owns the clock.

## Alternatives

**Schedule each next label change.** A deadline and rescheduling mechanism adds
complexity without evidence that the existing shared one-second ticker is too
costly. Bucket caching avoids rendering unchanged labels.

**Keep graph-local or row clocks.** These duplicate ownership and do not cover
all completion consumers; conditional providers also risk remounting drafts
when the first snapshot arrives.

## Consequences

Completed-only views can advance without per-row timers, while running timing
continues to require a server sample and finished execution duration stays frozen.
A cached local clock can be skewed until an online sample arrives; it never
changes completion facts. The shared primitives do not themselves add completion
labels to product views.
