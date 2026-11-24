# Agent Note: Legacy paired recovery cache

Status: implemented

## Problem

A browser that has opened the newer task cache cannot open the older schema at
its original IndexedDB name. A paired database and attachment restore also
replaces server history, so an older browser must not present persisted content
as current before it observes the restored epoch and authorization.

## Decision

The supported fallback is a reproducible Server built from the fixed historical
source and a scoped Web patch. It uses a separate task-cache database and hint
channel. Each authenticated scope obtains an authorized full snapshot before
using its persistent cache, and withdraws project content on synchronization, access, detail or Thread read failure until a new snapshot succeeds. The recovery runner verifies
the patch, migration registry, independently reproduced Web and Server, and the
bytes actually served by the embedded Web. The [task synchronization design](../../../../docs/design/daynight-task-sync.md#8-历史替换与约束)
owns the recovery sequence and constraints.

## Alternatives

**Open the original database with the old schema.** An upgraded profile rejects
that open with `VersionError`, preventing recovery without manual cleanup.

**Only rename the database.** A later restore can encounter an earlier fallback
cache, and a persistent preview can disclose an obsolete history before the
restored server's epoch and authorization have been observed.

**Delete the upgraded database.** This would disturb the newer client and other
users sharing the profile, and would not establish safe admission on later
restores.

## Consequences

The compatibility artifact is a patched historical build, not the original
binary or a general downgrade mechanism. It retains the old Server's matching
ledger and requires the paired restore and epoch rotation. The isolated cache
costs additional browser storage; stricter failure handling can temporarily hide
previously loaded content until an authorized snapshot succeeds.
