# Agent Note: Project Grant Management

Status: implemented

## Problem

An effective Project role can come from an owner Team, an independent grant, or
both. An inherited participant has no grant version to edit, while a stale grant
observation must not overwrite a concurrent change or a deleted and recreated
relationship. An administrator may also remove their own last access, making a
subsequent authorized read unavailable even when the write succeeded.

## Decision

The [auth specification](../../../../docs/spec/daynight-auth.md#项目成员与邀请)
owns the grant routes and their result contract. Effective Project admins may
create a direct grant for an existing participant, or change or remove their own
or another participant's real grant, without protecting a last direct admin.
New external participants still join by accepting an invitation; a user ID is
not a global discovery or enrollment capability. Team role and grant remain
independent and effective access is the maximum of the two sources, as established
by the [Personal ownership decision](2026-11-04-personal-project-ownership.md).

PUT uses null as the absent precondition and a positive int64 as the existing
grant observation. DELETE requires a positive observation. Project locking
orders competing grant and invitation writes; existence and version are checked
before a no-op, and the sequence gives recreated grants a new version. The actor
identity guard runs before domain SQL. The transaction computes the actor's
post-mutation access and returns it in a finite receipt only after confirmed
commit; null is a successful loss of access. An unconfirmed commit is unknown,
and observing matching current state cannot recover its original receipt.
The [membership foundation](2026-10-22-project-membership.md) retains the legacy
PATCH grant response and 204 deletion, while the new routes own these receipts.

## Alternatives

**Allow creation for an arbitrary user ID.** This would add external users
without their acceptance and turn project administration into global user
lookup. Restricting creation to existing participants retains the invitation
boundary while supporting inherited-only participants.

**Treat a current read as proof of the original write.** A self-removing admin
may receive a not-found response after a successful commit; another operation
could also produce matching state. A transaction result provides evidence when
commit is confirmed, while a lost response remains unknown.

**Persist an operation receipt.** Durable actor-bound operation identity could
recover a result after a lost response, but adds a stored lifecycle and protocol.
The current contract retains the honest unknown state without that infrastructure.

**Order authorization observations across all tabs.** A shared server revision
and durable coordination could distinguish a late denial from a later grant even
when cache generations change during an access read. The existing generation CAS
instead avoids clearing a replacement it cannot order; a concurrent replacement
can survive that denial until a later authorized check. A stronger guarantee would
require changing the access protocol and cache lifecycle together. The grant
receipt remains independent of that later read, and local suspension prevents the
initiating scope from displaying its old content while the check is unresolved.

## Consequences

Grant creation and replacement can be distinguished without invented versions,
and deleted grants cannot be targeted through an old observation. The finite
receipt allows confirmed self-demotion or removal to succeed even if later
project reads are forbidden. Callers must still validate response identity and
must not automatically replay unknown writes. The
[table overflow decision](../../implemented/bug-fix/2026-11-05-project-grant-table-overflow.md)
keeps its action column reachable within the Members container. Web displays all
three role sources and uses these routes with real versions.
The committed receipt updates the actor access and remains visible after access
is lost. A fresh access read after the receipt determines current cache withdrawal
or a later restoration; cache generation alone cannot establish server authorization
order. A later read cannot turn an unknown result into a confirmed commit.
