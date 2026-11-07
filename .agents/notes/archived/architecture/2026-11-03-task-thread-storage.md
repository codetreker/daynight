# Agent Note: Persistent task discussion threads

Status: implemented

## Problem

Task participants need durable discussion that remains available when execution
has not started, its Controller is offline, ownership changes, or the task is
complete. Concurrent appenders and readers must preserve attribution, complete
bodies and incremental continuity without coupling discussion to task versions
or native execution content.

## Decision

Each task owns immutable messages in PostgreSQL, separate from Task metadata,
attachments and Session content. The database generates message UUIDs once with
DEFAULT gen_random_uuid(); (task_id,message_id) is the composite primary key.
There is no globally unique message ID requirement or additional submission
identity. The ordinary (task_id,created_at,message_id) index serves paging.

A dedicated ReadCommitted Thread transaction shares the parent-task and
credential locks, then obtains canonical strong project admission through
`LockProjectAuthorization` in `store/postgres/internal/project_access.go`. That primitive shares
real ownership, then the existing owner Team member and direct grant rows through
commit. It returns `ProjectAccess` by merging current source facts after waits,
with its real nullable `DirectGrant` and without a profile projection. The
[Personal ownership decision](2026-11-04-personal-project-ownership.md) extends
the original direct-grant fence to these real sources. The transaction then
exclusively locks a lazy task-local head. It never acquires a Project row lock after the Task lock,
because ordinary project writes acquire Project before Task. It snapshots the
author's nullable name and any verified claim/worker/provider attribution. The
final database-clock expiry check follows all waits and encoding. Rejected
candidates and head initialization roll back together; no task mutation path is
invoked.

Messages and head store millisecond timestamps. A later append must advance the
committed (createdAt,id) position, retaining the original database UUID. If the
candidate does not advance, a bounded sampler waits for the real database clock
before preparing the same uncommitted row; it does not fabricate last+1ms.
Failure to obtain a reliable forward position rolls back rather than hiding a
message behind an already published incremental boundary.

GET uses one read-only Repeatable Read authorization snapshot for the parent,
ID anchor, candidates and actual first/last side checks. Callers provide only
beforeId/afterId; the service resolves the timestamp. A shared pure codec owns
actual escaped JSON admission and response bytes, including fixed three-digit
UTC timestamps. Both default and detailed messages must fit 64 KiB; pages fit
256 KiB and never truncate bodies.

Thread-local transaction stages distinguish confirmed refusal, cleanup failure
and unknown COMMIT outcome without changing other transaction helpers or global
error-cause precedence. Unknown submission remains an explicit 503 result;
clients retain drafts and do not automatically repeat POST.

## Alternatives

**Reuse Session storage and relay.** Session content and control belong to an
execution environment, and live reads may require its Controller. Reusing those
objects would bind long-lived discussion to claim, fencing and native content
ownership that discussion must outlive.

**Store discussion in Task properties or attachments.** Updating a whole task or
file would introduce version/projection churn or whole-file replacement and
would not naturally provide concurrent append, stable replies and bounded
bidirectional pagination.

**Reuse Tasks.versionedWrite or Store.WriteProject.** These paths acquire a
project lock, require task-version decisions and invoke Task mutation behavior.
A separate Thread transaction serializes only the selected discussion and
preserves the task/graph/sync invariants.

**Keep strong project admission in Thread-private member SQL.** This makes
Thread a second owner of project permission policy and couples admission to a
joined profile response. The canonical access owner provides the strong query
while Thread retains its transaction, credential and task ordering. Reading an
independent access alias while locking a separate grant alias could retain a
pre-wait role; the strong primitive derives access from current locked sources
after waits.

**Order only by random UUID within the current millisecond.** A later UUID can
sort before an incremental anchor and disappear from subsequent afterId reads.
Regenerating UUIDs or synthesizing future timestamps would violate database
identity generation or actual-time requirements. Bounded actual-clock waiting
preserves both guarantees, at the cost of explicit temporary refusal.

## Consequences

Messages survive execution changes and name changes without increasing a
previously admitted resource's encoded size. The task-local head serializes
appenders; readers need no head lock. Thread retains its credential revalidation
and consumes canonical strong admission, while ordinary Task transactions retain
their existing admission rules. Strong admission uses real ownership and actual source rows; it does not
construct placeholder authorization sources. Ordinary Task and Session admission
do not acquire its long-lived source locks. Discussion neither
changes Task versions nor enters task-sync.

Clock stalls or rollback produce explicit failures rather than partial history.
A lost commit response can leave a persisted message and an unknown client
result; equal text cannot establish submission identity. Deterministic tests use
private per-call seams and real PostgreSQL transactions, without a public clock
configuration or durable submission ledger.

Inbox, directed dispatch, receipts, automatic wakeups and notification recovery
remain additive future capabilities, not hidden fields in the current schema.
Editing/deleting messages would require a separate change-reading contract;
creation positions cannot serve as update watermarks. Reconsider the structure
if those mutable capabilities or stronger delivery identity become requirements.

The [requirements](../../../../docs/spec/daynight-task-thread.md) and
[design](../../../../docs/design/daynight-task-thread.md) own the complete API,
limits and mechanism. CLI rendering and browser Discussion are separate
consumers; this storage decision does not claim their delivery.
