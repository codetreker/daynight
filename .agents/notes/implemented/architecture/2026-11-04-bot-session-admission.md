# Agent Note: Bot Session binding and admission

Status: implemented

## Problem

A Bot needs one durable conversation across registration retries and Controller
recovery. The existing independent Session protocol has no Bot ownership or
version checks, and its ordinary lifecycle endpoints cannot enforce a bound
Worker's authority. Process-local synchronization also cannot establish that a
request handled elsewhere observes the same live native execution. Reusing these
paths without persistent admission would allow stale authorization or duplicate
registration to change the conversation being managed.

## Decision

Bot management remains separate from the independent Session wire identity.
A unique nullable `task_sessions.bot_id` links a web Test-scope Session to a Bot;
a composite foreign key requires matching owners. The Bot retains its stable
Session reference, and its API reads the actual `testExecutionId` from that
association. No Task, claim, project, or worktree is fabricated.

Registration locks Bot before Session and atomically freezes the first role with
the association. The stored original request includes its Bot version, independent
registration, resolved configuration and role. An exact replay returns the same
association after the Bot version advances; a different request cannot replace
it. Persistent deletion is checked before accepting replay. The service validates
the role digest but does not generate the Worker's versioned template.

Locked Bot reads acquire the row first and project its Session association in a
new SQL statement. A lock wait can return a newly committed Bot row while a
subquery in the same statement still uses an earlier snapshot; separating the
projection keeps both IDs consistent after concurrent registration.

Bot grant verifies the bound Worker, current Bot version and independent/native
identity before using the shared grant mechanism. A new generation requires a
known original native ID, the previous generation and its stop proof. Ordinary
Test registration, grant and stop reject Bot-associated Sessions, and the ordinary
Test list excludes them. The protocol keeps the independent branch and does not
relax ordinary Test recovery rules.

The shared web Session loader discovers immutable Bot ownership before taking a
Session lock, then locks Bot, locks Session and rechecks the association. It
rejects persistent deletion before attaching live cache state. Browser,
Controller, content-return and archive paths therefore share one Bot-before-
Session admission rule rather than depending on per-endpoint checks.

A ready report matches the current Controller fence and native identity and
requires synchronization observed by the handling relay instance. The same
transaction revalidates the live connection's original parent PAT: issuing a new
same-generation grant can replace the grant parent without replacing the active
connection's credential. It commits startup state and explicit successful
preferences in that transaction only while the original connection remains authorized.
A nullable native ID matches only an actually synchronized nullable snapshot,
preserving providers that create the native conversation on first input; it does
not authorize recovery without a known native ID.

The [specification](../../../../docs/spec/assistant.md) owns public behavior and
wire fields. The [design](../../../../docs/design/assistant.md) owns transactions,
locking and the relationship to the
[definition](2026-11-04-bot-definition-storage.md) and
[default-resolution](2026-11-04-bot-default-resolution.md) decisions.

## Alternatives

**Add Bot checks only in scopePermission.** Its callers already hold the Session
lock. Locking Bot there would reverse the deletion lock order and leave cache
attachment ahead of persistent admission. The shared loader establishes the
required order before either operation.

**Treat a persisted ready flag as native synchronization proof.** Another relay
instance can read that flag without owning the current live connection. Requiring
current live synchronization prevents a stale flag or a Worker spawn receipt from
committing successful preferences.

**Require a non-null native ID for every ready report.** Independent Sessions
support synchronized idle providers whose native conversation is created by the
first real input. Rejecting that state would force an artificial initial turn or
prevent an otherwise usable Bot from becoming ready. Exact nullable matching
preserves that path while recovery keeps the stronger known-ID condition.

**Expose bound-Bot deletion with registration.** Persistent admission is necessary
but does not perform native stopping or SQL, archive and Worker-private cleanup.
At registration delivery, the management endpoint therefore rejected bound
definitions. The [history deletion decision](2026-11-04-bot-history-deletion.md)
now preserves and discharges server cleanup alongside a bound Worker receipt.

## Consequences

Registration retries and concurrent callers preserve one Session, one execution
identity and one frozen role. The shared independent protocol remains usable by
existing Task and Test consumers, and the Bot lifecycle cannot be bypassed through
ordinary Test management routes. Reads and writes pay a Bot-row lock and binding
check so deletion remains authoritative across relay caches.

Readiness is local to the relay observation used to validate the report. Callers
must not infer it from another instance's durable Snapshot. A persistent ready
startup result records a past verified binding, not ongoing Worker availability.
Current connectivity remains a Session observation.

The server interfaces do not provide Worker process hosting, provider role
injection or browser panes. The [history deletion decision](2026-11-04-bot-history-deletion.md)
extends public deletion to bound Bots while retaining this lock order and exact
responsibility, and allows the minimum Bot record to outlive deleted Session rows. Server tests establish admission and transaction behavior; they do not prove
real provider execution or the combined assistant experience.
