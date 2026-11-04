# Agent Note: Bounded Bot Session Panes

Status: implemented

## Problem

Switching assistants must retain independent reading and unsent input without
allowing a late result to reach another execution. Retaining every visited
Session indefinitely consumes connections, DOM and resource memory. Discarding
a client also discards its in-memory unknown receipts when browser storage fails.
A tail page alone cannot establish that an earlier reading anchor disappeared.

## Decision

A Bot factory binds the existing independent Session API to its real owner,
Session and test execution. The shared client, reducer and renderer retain their
native contracts. A page cache owns at most three mounted panes and retains only
serialized draft/receipt state plus the shared detached reading bookmark after
LRU eviction. Identity validity remains independent of visible selection.

Eviction closes transport and releases heavy state; revocation invalidates saved
state and prevents stale selections reopening it. Bot and account cleanup cover
cold namespaces even when a new page cache has never selected the old binding.
Page-owned namespace versions revoke older storage instances and suppress stale
disk values after enumeration or deletion failures; freshly authorized instances
can persist new values. Memory values and deletion tombstones remain authoritative. Authenticated generation changes
remove obsolete drafts and receipts. Recovery queries an original unknown
operation rather than repeating its input.

Cold reading restoration uses existing pagination, requires observed progress,
and retries across browser connection generations and Controller connection epochs.
Only an admissible page request records an attempt; a replacement Controller
that is still synchronizing or an authentication gate that refuses the request
must not consume its retry. A failed page retains the bookmark;
Latest cancels it. The [design](../../../../docs/design/bot-session-view.md)
owns interfaces, ownership and fallback details. This consumes the existing
[reading bookmark decision](2026-11-04-session-display-reading.md) and extends
[display preference ownership](2026-11-04-session-display-preferences.md) with
explicit revocation, without changing ordinary callers' defaults.

## Alternatives

**Keep all visited panes mounted.** This avoids cold restoration but makes DOM,
connections and retained resources grow with every assistant visited.

**Unmount every unselected Session and depend on sessionStorage.** This drops
reading geometry and loses unsent input or uncertain delivery when storage is
unavailable. The bounded cache retains the frequent-switch experience and a
small memory fallback for evicted panes.

**Treat a missing tail anchor as the latest position.** This cannot distinguish
unloaded history from deletion. Existing historical cursors and the shared hook's
confirmed-boundary fallback preserve that distinction without another protocol.

## Consequences

Three panes bound heavy browser state; lightweight drafts, receipts and bookmarks
still grow with distinct visited bindings. There is no cross-page bookmark
database or replay queue. Browser storage denial cannot prove physical erasure;
page-local tombstones prevent old values from reappearing during that page.

List, creation, details, deletion orchestration and public navigation compose
these interfaces separately. They must keep the cache above selection and
invalidate it on authoritative access loss. This boundary permits those additive
features without replacing Session identity or introducing a Bot-only renderer.
Real Worker/Provider integration remains a separate acceptance responsibility.
