# Agent Note: Project repository URL copying

Status: implemented

## Problem

Project details display a repository address without a direct copy action.
Selecting a long address manually is awkward, particularly on narrow screens.

## Decision

The project heading places a localized icon-only copy button after the complete
repository address. It uses `ValueCopyButton`, following the
[shared copy presentation decision](../architecture/2026-11-16-shared-copy-button.md),
and passes the original `repoUrl` without normalization. Inline status and alert
feedback distinguish successful copying from retryable clipboard failure.

The control exists only alongside readable project metadata. Its mounted identity
is keyed by Project ID, while the shared value-copy hook isolates URL generations.
Neither switching projects nor replacing the URL can retain an earlier result.

## Alternatives

**Add a separate clipboard implementation.** This would duplicate pending guards
and stale-result isolation already provided by the shared value-copy hook.

## Consequences

No extra API read or navigation is introduced. Long addresses wrap while reserving
space for the shared copy control. Clipboard access still depends on browser
permission; failures leave the full selectable address and retry action available.
