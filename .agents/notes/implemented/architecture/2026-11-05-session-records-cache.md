# Agent Note: Persistent Session Records Catalogue

Status: implemented

## Problem

Task readers revisit Session history through dialogs and standalone views. A
confirmed empty history loses that knowledge when its owner unmounts or the page
reloads, and reactivation temporarily shows an empty section until a fresh
request finishes. Existing records also need to remain readable during refresh,
while the directory must discover new executions and archive state changes.
History has no directory version tied to the Task business version.

## Decision

The shared task cache persists the successful Session records catalogue and
confirmed empty results per authenticated user, project and task. Reopening or
reactivating the view uses eligible content and refreshes the first page in the
background for both empty and nonempty catalogues. Content state is independent
of refresh and failure: an exhausted empty result stays hidden while refreshing,
existing entries remain readable, and an error has a recovery path without
being stored as an empty result. An empty first page with a next cursor alone
remains incomplete. Exhausting all subsequent pages establishes a separate
persisted complete-empty proof while retaining the original first page and
cursor. When a confirmed empty catalogue is refreshed and the first page is
empty with a continuation, the background read follows later pages until a
record appears or the catalogue is exhausted. Equivalent results preserve
reading and selection state.

The cache uses the existing user fence and project generation lifecycle and
bounded retention. A per-task lease coordinates simultaneous refreshes across
tabs, with completion notification and takeover after expiry. Retained denial
markers are protected from eviction, and ordinary cache writes also protect
active leases; a trusted denial can evict a lease to retain its marker. When
denial markers occupy every slot, the cache generation rotates while retaining
the project, summaries and authorization and clearing old details and catalogues.
When protected slots also include active leases and none is free, a reader waits
for a lease to settle or expire before retrying. With functioning storage,
identity changes, revoked access, task deletion and retired generations fence
old content and late responses. If a clear or generation rotation cannot be
persisted, live tabs use matching lifecycle broadcasts and in-memory fences to
withdraw the catalogue and offer retry; invalidated in-flight responses cannot
republish after the notice. If IndexedDB is completely unreadable and unwritable,
a delayed old denial notice can arrive after a newer network success, and the
receiver may conservatively hide that newer catalogue. If every relevant tab
closes after a denial that no durable medium could record, the in-memory fence
is lost; the next opening may briefly show the old catalogue before the network
denial. The cache is a display aid; it grants no access to live Sessions,
controls or archive content. The [Web design](../../../../docs/design/herdr-session-web.md)
owns the visible directory and replay behavior.

This replaces the request-bound empty state and nonempty reactivation behavior in
the [task detail order decision](2026-11-05-task-detail-order-and-records.md),
whose ordering and reason to omit a truly empty section remain in force.

## Alternatives

**Keep only component memory.** It avoids durable metadata, but unmount and page
reload lose confirmed emptiness and cause the section to reappear during each
read.

**Keep a refresh control in an empty section.** This makes manual discovery
possible but reserves space for a section without a record to read. Background
refresh on activation discovers new history without that persistent empty area.

**Use Task version to skip refresh.** Session history and archive status have no
version contract with the Task, so unchanged task metadata cannot establish that
the directory is current.

## Consequences

Both empty and nonempty results can be reused after reload while activation still
issues a history request. Cached metadata consumes bounded local storage and
requires lifecycle checks and schema migration. Schema 8 discards the old
Session catalogue format while preserving compatible project, task and profile
data. Offline or failed refresh can
leave the last valid directory stale; the visible error and retry path distinguish
that state from a successful empty response. Existing pagination, fixed execution
identity, attachment previews and live Session controls retain their owners.
