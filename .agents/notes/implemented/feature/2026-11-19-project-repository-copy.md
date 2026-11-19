# Agent Note: Project repository URL copying

Status: implemented

## Problem

Project details display a repository address without a direct copy action.
Selecting a long address manually is awkward, particularly on narrow screens.

## Decision

The project heading places a localized icon-only copy button after the complete
repository address. It uses `ValueCopyButton`, following the
[shared copy presentation decision](../architecture/2026-11-16-shared-copy-button.md),
and passes the original `repoUrl` without normalization. A success status appears
immediately to the right of the button for three seconds per successful copy;
its reserved space keeps the heading stable. A retryable failure remains an alert
below the address and control.

The control exists only alongside readable project metadata. Its mounted identity
is keyed by Project ID, while the shared value-copy hook isolates URL generations
and the feedback is reset when the URL changes.
Neither switching projects nor replacing the URL can retain an earlier result.

## Alternatives

**Add a separate clipboard implementation.** This would duplicate pending guards
and stale-result isolation already provided by the shared value-copy hook.

## Consequences

No extra API read or navigation is introduced. Long addresses wrap while reserving
space for the shared copy control and localized success status. Clipboard access still depends on browser
permission; failures leave the full selectable address and retry action available.
