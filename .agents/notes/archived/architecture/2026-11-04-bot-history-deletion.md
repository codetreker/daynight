# Agent Note: Bot history deletion

Status: implemented

## Problem

Hiding a Bot cannot stop an already authorized upload, remove orphan archive
objects, or establish that a remote process stopped writing. Cleanup crosses
PostgreSQL, file storage and the bound Worker, so one transaction cannot make
all effects atomic. Lost responses and partial failures must leave enough
identity to finish the original deletion without exposing its history again.
An owner credential can expire while deletion waits for a row lock, even when
its shared credential lock prevents concurrent revocation.

## Decision

The persistent Bot row is the admission barrier and cleanup responsibility.
Deletion locks Bot before all associated Sessions, revokes grants, and commits
before physical cleanup. This extends the
[definition kernel](2026-11-04-bot-definition-storage.md) and preserves the
[shared admission order](2026-11-04-bot-session-admission.md).

The public DELETE transaction rechecks the owner PAT or login Session with a
fresh current time at write completion and exact replay completion. Expiry after
Bot or associated Session lock contention rejects the request and rolls back
Bot state and grant revocation before local cache invalidation.

A bound Worker submits an exact execution stop receipt and its private-cleanup
result. The relay validates the original identity; process verification remains
the Worker's responsibility. A canonical receipt digest survives Session deletion
so completed retries cannot replace the original proof. Worker completion commits
before server cleanup, which can fail and retry independently. Repeating the
same failed state and code preserves its version; changed failure information
or completion advances the recorded result.

Server cleanup enumerates actual Bot associations, derives each typed archive
namespace from the original owner and Session, removes its whole user/shard/Session
directory, explicitly removes all SQL children and the Session, and reduces the
Bot to deletion responsibility. The
[archive layout decision](../../implemented/architecture/2026-11-05-session-archive-layout.md) owns these grouped
addresses and the current-layout cleanup scope. Legacy archive bytes remain
outside that scope and do not block current namespace deletion. Cleanup covers
unregistered objects within its derived directory and preserves other Sessions
under the same owner or shard. Filesystem failures and SQL rollback never restore
admission. A retry tolerates already removed files and
cannot downgrade a concurrent completed cleanup. Live caches are invalidated
locally after deletion and on other instances when persistent removal is observed.
The Controller's preliminary scope lookup must also invalidate on a missing
Session: it runs before the shared loader, including on socket disconnect.
Other database errors do not establish removal and preserve cached state.

The [specification](../../../../docs/spec/assistant.md) owns completion semantics
and the public receipt. The [design](../../../../docs/design/assistant.md) owns
transactions, the SQL list and restricted file removal.

## Alternatives

**Delete metadata and only its referenced archive object.** A completed upload
whose metadata transaction failed would remain on disk. Removing the fixed
Session namespace covers these orphans without accepting arbitrary path prefixes.

**Perform barrier and physical cleanup in one transaction.** A file or SQL
failure would roll back the marker and reopen access. Separate commits keep
revocation authoritative while cleanup remains retryable.

**Depend on local cache invalidation for deletion.** Another Service can retain
its own cache. Persistent admission before attachment and before asynchronous
content return is required regardless of local invalidation.

**Validate credentials only before row-lock waits.** Shared credential locks
serialize revocation writes but do not prevent time-based expiry. Admission at
transaction completion preserves the same rule for writes and exact retries.

## Consequences

Deletion can remain pending while the Worker is offline, or failed until storage
is repaired. Both obligations must complete before consumers report completion.
The server does not introduce a cleanup queue or infer remote process termination.
The existing Worker inventory retains unfinished responsibilities.

Ordinary Tasks, Test Sessions, working directories and shared native homes are
outside the deletion scope. Provider-native files, offline browser copies and
user exports have no physical-erasure guarantee. Adding provider-wide removal
would require a distinct ownership and native API decision.
