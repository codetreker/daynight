# Agent Note: Negotiated Worker archive configuration

Status: implemented

## Problem

Operators need a Worker-level Session archive choice without breaking existing
Workers and configuration editors. Older clients parse closed response shapes
and replace complete targets, while an older service can rewrite the stored
configuration JSON. A saved choice also cannot establish that the Worker has
applied it or released local recording files.

## Decision

The existing Worker configuration resource exposes the boolean
`archiveSessions` through the independent `Daynight-Worker-Archive-Sessions: 1`
capability. Existing and new Worker rows default to true. A negotiated complete
initial candidate can set either value; later edits use the existing target CAS.
An unnegotiated PUT preserves the current value under the same row lock. The
separate `archive_sessions` column keeps the choice when an older service writes
the base JSON. Unnegotiated projections omit both the field and its observation.

An archive observation has a boolean applied value or an unconfirmed null. Its private storage
slot and original item position preserve the legacy observation projection; an
older complete observation replacement removes the slot rather than reviving
old application evidence after an upgrade. This extends the compatibility
approach in the [control mode decision](2026-11-10-worker-cloud-control-mode.md).
The [configuration contract](../../../../docs/spec/daynight-worker-configuration.md)
owns the interface and the [design](../../../../docs/design/daynight-worker-configuration.md)
owns the persistence and transaction details.

## Alternatives

**Add the field unconditionally to the existing protocol.** Strict old readers
would reject the new field and old complete PUTs could erase it. An independent
capability preserves the existing protocol versions and their consumers.

**Keep the choice only in the desired JSON.** An older service still running during migration can replace
that JSON without knowing the field. The independent column lets it keep the
new value while retaining the existing revision transaction.

**Introduce a new archive policy and lifecycle protocol.** The confirmed goal
only needs a setting consumed by the existing cleanup flow. Additional epochs,
remote archive states or a separate activation protocol would add state and
coordination without establishing the requested behavior.

## Consequences

The server persists and exchanges the target while preserving strict legacy
projections. Application evidence remains a separately versioned observation;
its absence is not evidence that the default was applied. A Worker must report
its actual application, and runtime cleanup and Web controls require their own
implementations and validation. No target save changes or deletes an existing
cloud archive.
