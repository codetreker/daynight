# Agent Note: Account and Session Display Preferences

Status: implemented

## Problem

A reader's display choice must survive reopening a Session without following an
execution claim or leaking into another account. Multiple views of the same
Session need a consistent choice, including when browser storage fails. An
identity change must not briefly show the previous account's preference, and a
failed save must not undo the current reading choice.

## Decision

A page-local registry owns one external preference store per JSON-encoded
account/Session key. The React hook selects that store during render and
subscribes with `useSyncExternalStore`. An unresolved identity selects an inert
store without accessing browser storage. The [Session design](../../../../docs/design/task-session-protocol.md#session-显示偏好模块)
owns the interface, versioned storage format and error behavior.

Selection updates memory before saving; explicit retry writes that current
choice rather than rereading the older persisted value. Same-mode selection is
a no-op. Stores retain stable snapshots and notify only when mode or issue kind
changes. Each subscription removes its listener on release; the page cache keeps
small preference state so a failed save survives unmounting and remounting.
Storage exceptions are reduced to error categories rather than retained objects.
Explicit removal invalidates old handles, notifies their subscribers and attempts
to delete the stored value. A page tombstone prevents failed deletion from
reviving it; a new authorized handle starts at the default and remains editable.
The [Bot cache](2026-11-04-bot-session-cache.md) calls this operation for
revoked bindings and account cleanup, including observed cold panes.

The module consumes the [display classification contract](2026-11-04-session-display-classification.md)
and does not depend on a Session client, draft, operation ledger or execution
identity. The [shared view integration](2026-11-04-session-display-integration.md)
binds it to the authenticated account and verified Session snapshot, supplies
the selected mode to the timeline and presents errors only inside Display.
The store initially shipped independently so storage and identity behavior
could be verified without changing the existing production view.

## Alternatives

**Component-local state initialized from storage.** This matches the existing
sidebar preference but would allow two views to disagree and preserve a previous
identity until an effect runs. The shared store makes identity selection and
same-page consistency independent of effect timing.

**Evict the store when its last subscriber leaves.** This reduces retained cache
entries but loses an unsaved choice and can resurrect stale storage after a
remount. Keeping only identity keys, mode and issue kind preserves page-local
intent without retaining Session content or listener closures after release.

## Consequences

Tests inject controlled storage and cover read, invalid-value and write failures,
retry, synchronous identity changes, shared views and listener cleanup. Repeated
selection does not publish a new snapshot that could reset a reader's position.

The cache grows with distinct identities encountered during a page lifetime.
Cross-tab updates are not observed until a page reload, and unsaved choices do
not survive that reload. Cross-device synchronization is not provided. The
production menu, filtering and scroll consumers share this preference without
giving the store ownership of those components or operational authorization.
