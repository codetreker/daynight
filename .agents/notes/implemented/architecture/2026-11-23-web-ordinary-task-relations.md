# Agent Note: Web Ordinary Task Relations

Status: implemented

## Problem

A Task's ordinary parent is distinct from its Goal and dependency edges. Shared
project snapshots may have been written by an older Web bundle that discards the
ordinary-parent field, so an absent field cannot prove that a Task has no parent
or children. Detail navigation and creation need the actual Task IDs without
changing Goal membership or dependency-graph semantics.

## Decision

Web Task requests select the ordinary-parent projection and retain the distinction
between a missing `parentTaskId` and an explicit null. Direct child pages use the
authorized parent filter and current Task and project-history admission. The
ordinary relation controls share a detail component with separate parent and child
slots, mounted across the production Task reading surface. The [subtask tab decision](2026-11-24-web-subtask-tab.md) owns their current presentation and independent publication. Links target the ordinary Task's
independent detail URL and use the existing draft-aware browser navigation. Child
presentation uses the [shared-row integration](2026-11-24-detail-subtask-shared-row.md)
with authorized Task details; relation scope and pagination remain with this host.

The initial relationship delivery kept production composition inactive until
lifecycle feedback and cache withdrawal could be integrated. The
[lifecycle and retirement decision](2026-11-24-web-subtask-lifecycle-retirement.md)
completes that composition and owns its confirmation and deletion guarantees.

The [server read projection decision](2026-11-23-task-parent-read-projection.md)
owns the protocol and preserves the Goal meaning of `parentId`.

## Alternatives

**Infer children from the project snapshot.** An older bundle can strip unknown
fields from the shared cache, producing a false empty list even when the server
has children.

**Publish relationship controls before lifecycle integration.** At the initial
delivery, this would have exposed ordinary parent writes before coordinated
cancellation and deletion feedback was available. Separate slots and a shared
controller allowed composition to retain the established detail layout without
changing the relation read contract.

## Consequences

Child reads and pagination incur separate authorized requests. Missing projection
fields remain unknown, and an unsupported server returns a visible error instead
of a fabricated empty list. Parent navigation, fixed-parent creation and all
five child states share the production detail surface; their eligibility remains
bound to current reads and project history.
