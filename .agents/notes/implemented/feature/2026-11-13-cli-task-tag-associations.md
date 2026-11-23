# Agent Note: CLI Task Tag Associations

Status: implemented

## Problem

Task and Goal classification needs atomic creation and replacement of tag sets,
as well as convenient single-tag changes that cannot silently overwrite a
concurrent edit. A lost write response cannot establish whether the set changed.

## Decision

The CLI submits canonical tag UUID sets with Task and Goal creation or update,
validates the successful receipt against the submitted set, and supports clearing
associations explicitly. Add and remove read the current set and submit a complete
replacement under the original version condition, including for no-op changes.
The [CLI manual](../../../../packages/daynight/README.md#task-management) describes
the commands and recovery behavior. Tag reads retain the separate
[read contract](2026-11-13-cli-task-tag-reads.md).

## Alternatives

**Create first and attach tags afterward.** A second write could fail after
creation, leaving an entry without the requested classification.

**Use a separate add/remove endpoint or retry a replacement.** A new endpoint
would duplicate the existing set operation; replay after an unknown result could
overwrite another actor's edit. Reading and conditionally replacing preserves the
version decision while using the shared API.

## Consequences

Known complete sets require one write; add/remove need a read and a write. A
conflict requires a new decision and an unknown outcome requires inspection of
the saved Task. Server-side validation remains responsible for authorization,
project membership, atomicity and capacity.
