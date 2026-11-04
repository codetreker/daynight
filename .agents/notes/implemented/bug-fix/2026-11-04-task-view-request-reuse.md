# Agent Note: Task view request reuse

Status: implemented

## Problem

Task inspection repeatedly reads the same assignee profiles, and a page reload
loses prior profile content. Responses can contain large inline avatar data URLs,
so unchanged identity information also retransfers image bytes. Repeated picker
openings can transfer a whole catalogue again. Current-user identity checks have
the same body cost through /me, although checking the current login remains
necessary. A five-second task-sync cadence adds recurring network work even when
task summaries have not changed.

## Decision

The authenticated profile owner persists content and its server-issued version
per viewer, project and profile user under userFence. IndexedDB schema 6 adds a
profiles store; upgrading schema 5 preserves compatible ownership-complete task
records, fences and watermarks. The
[public ownership decision](../architecture/2026-11-04-public-project-ownership.md)
introduced schema 5 and the required rebuild of versions 1 through 4, whose
Project records lack ownership. Those upgrades still clear incompatible derived
stores, rotate user fences and require a complete snapshot. Persisted content is
used only after live /me identity verification and a successful current-project
sync supplies the complete qualified-person manifest.

Every task-sync carries assigneeVersions entries containing userId, content
version and current hasProjectAccess. The version is an opaque lowercase SHA-256
identifier derived only from userId, nullable name and avatar. Access, role,
login timestamps and task references do not alter unchanged content. Access stays
in the live manifest; only missing or changed profiles are read in bounded
batches. The picker uses this manifest and the same cache, with Retry recovering
missing or failed items instead of retransferring unchanged catalogue profiles.

A profile GET preserves the content version it actually observed. A manifest/profile
race cannot label newer content with an older token or start an immediate retry
loop. Ahead-of-manifest and transient unresolved exceptions are bounded to the
current positive graph-receipt observation. A new successful receipt clears them
even when content tokens are unchanged; duplicate receipts and presentation
changes retain the observation. Each GET captures that observation, preventing
an older conflicting response from reinstating an expired exception. Matching
normal cache entries still require no GET. Shared in-flight work, current
content-version checks and identity/project publication fences reject obsolete
results. Generation or userFence replacement immediately withdraws old people,
qualification, access markers and catalogue readiness, including when a cross-tab
replacement has no local online manifest yet. A requested catalogue waits in
loading; unknown metadata cannot become a successful empty catalogue. Task epoch
replacement retains raw same-userFence content only for validation by a new
authorized manifest; userFence replacement clears the old content.
Project revocation, logout, identity replacement and session loss clear the
corresponding content and admission.

/me uses browser-managed HTTP caching with private, no-cache and a strong ETag
over its complete identity-bound representation. The handler authenticates and
reads the current user and validates the actual Personal Team before returning
bodyless 304 for an unchanged validator.
Only this client endpoint overrides the normal no-store fetch policy. Initial
and foreground identity verification retain their existing gate, errors and
account-change behavior; there is no second custom /me IndexedDB.

Visible project and standalone task pages synchronize summaries every fifteen
seconds. Initial loading, manual refresh and returning to a visible document
retain immediate reads; automatic ticks skip active work, hidden documents pause
their timers, and unmount releases owned work. Worker observation and Discussion
polling retain their separate cadence.

The [assignment requirements](../../../../docs/spec/daynight-task-assignment.md),
[task-sync requirements](../../../../docs/spec/daynight-task-sync.md) and
[authentication requirements](../../../../docs/spec/daynight-auth.md) own the
observable behavior. This decision partially supersedes the [assignment
foundation](../architecture/2026-11-03-task-assignment-foundation.md) and
[automatic task refresh](../feature/2026-10-22-project-task-auto-refresh.md).
The original receipt-driven profile refresh kept independently mutable profile
and access facts fresh without changing Task versions. The original five-second
cadence supported unattended task monitoring. Content validators preserve that
freshness observation while avoiding repeated profile bodies; the fifteen-second
cadence accepts a longer ordinary task observation delay.

## Alternatives

**Keep profiles only in page memory.** It removes repeated task-click reads but
loses content on reload and cannot identify remote changes without downloading
profiles again. It does not provide persistent changed-or-missing-only transfer.

**Use conditional full catalogues or demanded-ID batches.** An aggregate ETag
avoids a completely unchanged body, but one changed person retransfers other
unchanged avatars. Changing the demanded-ID URI also creates another HTTP cache
entry. Per-person content versions preserve the required transfer granularity.

**Store a custom persistent /me response.** It duplicates browser HTTP-cache
storage and bootstrap validation ownership. Native revalidation already keeps
login checks live while reusing unchanged content across reloads.

**Add a separate avatar proxy or resource.** It could independently cache images,
but inline avatar bytes already travel inside profile JSON. Versioned profile
reuse removes that repeated transfer without another endpoint or image lifecycle.
A separate resource remains additive if measured first-load or external-image
cost warrants it; profile identity stays separate from Task versions and records.

**Store profile revisions in PostgreSQL.** It could avoid reading and hashing all
profile bodies on every sync, but needs migration and transactional revision
maintenance across every profile writer. Content hashing keeps the wire version
independent of login timestamps and needs no PostgreSQL migration. The opaque
content-version field permits later materialization of the same content hash
without changing client cache keys or public freshness semantics.

## Consequences

Unchanged profile and inline-avatar bodies survive task openings and page
reloads. Only missing or changed people are fetched after lightweight live
metadata validation; access-only changes reuse the same content. /me still
validates the current login, while an unchanged wire-level 304 carries no profile
body. Browser cache eviction or missing profile records causes an ordinary full
read of that missing representation.

Persistent profiles contain presentation content, not authority. Names and
avatars follow validated content versions; project access comes from current
metadata, and service authorization still checks each mutation. Valid nullable
fields remain complete data. Storage, network and validation failures stay
observable and retryable. Corrupt profile content is cleared only for that
project, retaining task records; failed persistence keeps dirty content for Retry
without another profile download. Old-account and old-history results cannot
republish content.

Each task-sync reads and hashes qualified profile content, costing O(people +
total profile bytes) on the server while sending O(people) metadata. This work
includes inline avatar text even when the network body is unchanged. Current
node/edge limits do not bound total profile bytes. Representative sync-cost
measurements should determine whether transactional hash materialization is
needed; no fixed timing or capacity claim follows from the caching mechanism.

The summary cadence increases ordinary background observation delay to one
fifteen-second interval plus active-read and service latency. Immediate refresh
and visibility recovery remain available. No additional avatar service, profile
polling loop, Task business-version field or PostgreSQL migration is introduced.
