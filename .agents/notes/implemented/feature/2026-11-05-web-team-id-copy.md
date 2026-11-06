# Agent Note: Web Team ID Copy

Status: implemented

## Problem

Team settings expose the full selectable ID, but transferring it requires precise
selection. Clipboard access can fail or finish after the visible identity changes,
and members need the same read-only action as administrators.

## Decision

The Team ID field provides an icon button matching the Task copy glyph. It copies
the displayed ID without a management write and reports success or a retryable
failure beside the field. The operation has a synchronous pending guard and is
invalidated with its Team, identity admission, or mounted context. The selectable
ID and button wrap independently at narrow widths.

## Alternatives

**Reuse `TaskCopyButton` directly.** Its feedback belongs to the Task detail
notification host and its localized messages are Task specific. A Team-local
control preserves that boundary without changing the existing Task copy lifecycle.

## Consequences

Any viewer of a loaded Team can copy its ID, including read-only members. Denied
or unavailable clipboard access leaves manual selection and retry available. The
small duplicated glyph keeps the two consumers independent; a broader shared
clipboard abstraction would require aligning their different feedback hosts.
