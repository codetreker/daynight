# Agent Note: Completed bot deletion feedback

Status: implemented

## Problem

Completed deletion records must continue to prevent stale reads and old Session
URLs from restoring deleted content. Rendering those retained records as status
cards indefinitely leaves a success message on the page and restores it on reload.
The original browser deletion design displayed completion once both cleanup
phases finished; the retained safety record had no separate display lifetime.

## Decision

The management page excludes completed records from its visible deletion
feedback while retaining the complete coordinator snapshot for admission,
invalidation and the selected name. A selected deleted address shows the existing
neutral deleted state, using the general title when no name is known. Incomplete
and inaccessible states retain their feedback and actions. An owner-authorized
[evidence-loss settlement](2026-11-23-bot-deletion-evidence-recovery.md) retains
separate feedback stating that server cleanup completed while local verification
remains unresolved; it is not normal completion. Known deletion records expose
read-only status and hosting-machine CLI instructions, not browser recovery
confirmation or account-wide history discovery. The original
[browser deletion decision](../architecture/2026-11-05-bot-browser-deletion.md)
owns the retained safety barriers and cleanup rationale.

## Alternatives

**Remove completed records.** This also removes the evidence used to reject late
reads and old Session access, allowing deleted content to return.

**Dismiss the card with a timer or action.** The stored record can recreate the
success message on a passive read or reload, and the card remains after cleanup.

## Consequences

Completion immediately removes the feedback without changing storage or the
deletion protocol. Retained records continue to consume session storage as
described by the browser deletion decision; a deleted address remains informative
without implying that cleanup is still pending.
