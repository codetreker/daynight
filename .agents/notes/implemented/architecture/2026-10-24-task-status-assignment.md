# Agent Note: Three-State Task Status Assignment

Status: implemented

## Problem

Predecessor-constrained lifecycle actions prevent supported corrections and
reopening, while a separate proposed state adds task approval before execution.
A single status operation needs consistent dependency, timing and concurrency
rules, and removing a stored state requires a genuine data migration.

## Decision

The [three-state requirements](../../../../docs/spec/daynight-task-status.md) and
[architecture](../../../../docs/design/daynight-task-status.md) specify todo,
in_progress and done with one versioned setter and todo creation. Migration 014
converts every legacy proposed row to todo, advancing its version/update time
while preserving all other stored facts; default and CHECK switch atomically.
Existing applied migrations remain unchanged, and runtime readers do not accept
the deleted state as an alias.

The implementation reuses project-lock transactions, complete mutation plans,
CLI choices and the shared Web status/permission owner. Platform saves are a third operation under
that same owner, without adding another confirmation or mutation controller.
Status changes and migration retain requiredPlatform; immutable migration 013
adds platform first, while 014 performs state conversion. It compares exact versions
before same-state no-op, preserves all-edge forward/reverse dependency protection,
and resets only actual runtime execution attempts when returning to todo. Migration reclassification
preserves historical timing rather than invoking that runtime reset.

The task workflow has no approval stage. Existing user execution scope,
independent automatic selection permission and PR delivery rules remain; no field
recreates the approval barrier. Worker ownership stays separate from ordinary
status; the [explicit completion decision](2026-10-26-worker-managed-completion.md)
adds a done-only claim argument that reuses the protected completion API without
changing normal setter semantics.

The earlier [approval lifecycle](../feature/2026-10-22-task-approval-lifecycle.md)
and [withdrawal decision](../feature/2026-10-23-task-unapprove.md) retain their
historical rationale. Their bounded actions avoided reopening complexity while
approval was part of the supported workflow. This decision replaces that model
and restores dependency protection for arbitrary transitions.

## Alternatives

**Keep four states and rename commands.** This centralizes verbs but retains the
approval stage that the confirmed three-state goal removes.

**Decode old state as todo at runtime.** A compatibility branch leaves stored
constraints, queries, summaries and revisions describing different states. A
transactional migration establishes the single target model and rejects stale input.

**Put status back into metadata PATCH.** It can be atomic but couples execution
time and graph constraints to all combined metadata updates; a dedicated resource
owns one status-only contract and keeps existing material writes explicit.

**Switch the backend first or retain aliases.** Removing routes before updating
shipped clients breaks them; aliases would create an additional public lifetime.
All existing callers, readers and gates switch with the new migration.

**Make dependencies affect readiness only.** That permits active/done tasks with
unfinished prerequisites and requires redesigning readers. The implementation retains
all-edge checks and direct-dependent protection under the existing project lock.

## Consequences

Validation distinguishes migration, three-state readers, all nine pairs, exact
+0/+1, dependency races, material/permission/classification retention, timing and
shared Web session behavior. Runtime agreement requires source-bound PostgreSQL
upgrade/restart, installed CLI and production Web receipts; module gates and
coverage thresholds remain intact.

Legacy-state conversion must invalidate old versions without deleting execution
facts. Existing history tests must pin their original migration prefix. Reader,
summary or UI leftovers can make the new protocol incoherent. Same-state responses
may carry fresh derived readiness despite unchanged revisions. Current-attempt
reset intentionally discards an abandoned interval; immutable attempt history is
a different stored model. The [worker claim foundation](2026-10-24-worker-claim-foundation.md)
integrates its fencing into the same transaction. Claim-bound done accepts the
current claim ID; explicit release protects stopped execution and resume creates a fresh claim
and worktree under the [manual-control decision](2026-10-27-worker-manual-control.md). Setting a state cannot stop a process.
