# Agent Note: Read-only Web terminal history

Status: implemented

## Problem

Old Herdr claims and uploaded recordings need to remain discoverable while the
Web interface retires live terminal observation and control. A latest-record
fallback can display a different execution under the current claim.

## Decision

Web resolves any Herdr claim by paging Session history for the exact claim and
mode. A missing match is unavailable; repeated cursors fail as a protocol error.
The existing fixed archive reader verifies the selected identity and content.
Native active and completed Session paths remain independent. Discovery retains
visibility, authentication, cancellation and permission fences. The server rejects v2 browser
commands, operation reads and channel requests before invoking terminal control;
the same v1 paths and the Worker protocol retain their own handlers.

This replaces the Herdr current reader in the [automatic entry decision](2026-11-06-automatic-task-session-entry.md)
and preserves the [history read boundary](../architecture/2026-11-17-terminal-history-read-boundary.md).

## Alternatives

**Keep live terminal control.** This retains a browser consumer of the retired
execution protocol and exposes control for old executions.

**Use the newest history record.** A newer or older claim can be unrelated to
this task's current claim, so ordering alone cannot establish identity.

## Consequences

Uploaded recordings remain readable with their existing integrity checks. An
unuploaded or undiscovered recording remains unavailable; Web neither uploads it
nor reconnects the original execution. History pagination adds read requests
when the matching claim is not on the first page. Old v2 browser clients must
upgrade; the remaining Worker and internal control code does not restore a browser
entry point.
