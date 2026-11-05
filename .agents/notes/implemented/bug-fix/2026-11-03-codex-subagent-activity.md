# Agent Note: Codex Subagent Activity Projection

Status: implemented

## Problem

Codex emits `subAgentActivity` items for parent operations involving a child
agent. Treating these items as unsupported errors makes normal delegation look
like a failed session. Persisted misclassifications remain visible even after
the producer recognizes the item type.

## Decision

Project these items as ordinary tool operations with explicit Start, Interact
with, or Interrupt subagent labels. Unknown activity kinds use a neutral
Subagent activity label. Preserve the native item identity, child path and
thread ID. Live item completion describes the parent operation only; it never
establishes that the child task finished. No child session is opened or read.

The browser recognizes previously stored `unsupported_native_item` entries only
when their exact diagnostic prefix and parsed payload identify a valid
`subAgentActivity` item. It displays a collapsed operation with metadata and
no inferred lifecycle status. Invalid payloads and unrelated errors retain their
original error presentation. Stored entries, sequence and cursor state remain
unchanged. This follows the presentation-only history correction used for
[empty reasoning](2026-10-28-session-empty-reasoning-and-tool-rows.md).
The renderer and display selector share this recognition through a pure helper;
the [display classification decision](../architecture/2026-11-04-session-display-classification.md)
defines how valid legacy activities participate in visibility selection.

## Alternatives

**Only fix new projections.** Old journals and archives would continue to
mislead users until their native history could be projected again.

**Expand child sessions.** Reading and synchronizing child history adds session
lifecycle and navigation responsibilities unnecessary for displaying a parent
operation. Keeping its thread ID allows a separate future feature to use that
identity without deriving it from visible labels.

## Consequences

Normal delegation no longer raises an error alert. Existing tool rendering and
wire types suffice, so no protocol migration is required. The operation row
does not expose the child's progress, result or current state. Future child
navigation must obtain those facts from the child session itself.
