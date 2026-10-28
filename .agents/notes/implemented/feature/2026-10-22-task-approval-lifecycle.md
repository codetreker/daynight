# Agent Note: Explicit Task Approval Lifecycle

Status: implemented

## Problem

Creating work should preserve a proposal until an explicit acceptance decision.
Task status is shared by the CLI, HTTP clients, browser and packaged Agent
workflow. Command aliases cannot enforce that decision while generic updates
still allow callers to start, complete or reopen a task directly. Concurrent
clients also need to bind each action to the content they actually reviewed.

## Decision

The original approval delivery replaced generic state editing with proposed
creation and predecessor-constrained approve/claim/complete actions. Its later
[withdrawal extension](2026-10-23-task-unapprove.md) added todo-to-proposed only.
Approval allowed unfinished prerequisites; starting and completion required all
direct predecessors done. Observed positive int64 version was checked before
source state, under the project lock, so a stale client could not approve content
it had not reviewed. Existing todo/in-progress/done rows were treated as accepted
and retained their states, versions and timestamps; the default-only migration
affected new creation. Metadata PATCH excluded status and preserved omission,
dependency and property semantics. This record preserves that historical decision.

The adopted [three-state status assignment](../architecture/2026-10-24-task-status-assignment.md)
supersedes the approval model, its public actions, four-state readers and workflow
approval barrier. Current tasks default to todo, and one status-only resource
supports all nine pairs with exact +0/+1, dependency protection and timing. The
old proposed state is migrated to todo; it is rejected by runtime clients and
the database. Task registration does not start execution. Existing execution and
delivery authorization remain independent of status and automatic selection.

The original browser work established durable mechanisms still reused by status
and allowAgents: full-detail exact-version confirmation, bigint numeric transport,
graph projections without versions, one project/task session independent of a
mounted dialog, identity-generation isolation and mounted same-task attachment
reading. Confirmation froze action, resource and reviewed version; known changes
invalidated it, while unchanged receipts and optional GETs did not starve writes.
The session distinguished current read activity from required freshness, coalesced
automatic receipts behind active GETs and retained explicit retry priority.
Derived readiness could require a fresh read without changing task revision.

Confirmed details remained authoritative during graph refresh; errors retained
request context. Conflict required reread and a new decision. Uncertain results
required GET-only reconciliation, and 404 removed private materials while keeping
unknown-result feedback. Late reads could neither roll back a confirmed revision
nor populate another identity/resource. The [quiet refresh decision](../bug-fix/2026-10-23-quiet-task-detail-refresh.md)
and [compact header decision](../simplification/2026-10-24-compact-task-detail-header.md)
own retained-read geometry and bounded keyboard-readable titles. Those ownership
rules survive the replacement of approval controls with the status menu.

The original workflow separated task acceptance from execution and PR delivery.
Its stage-brief and shared-input rationale remains useful, but task approval is
removed by the successor. User-confirmed Goal discussions are owned by the
[stage decision](../process/2026-10-24-user-confirmed-goal-discussions.md); complete
behavior belongs to current server, CLI, Web and skill requirements. Status is
not an assignee lock, lease, process cancellation or permission to merge.

## Alternatives

**Keep generic status updates alongside lifecycle aliases.** Other clients could
continue skipping approval or claim, and a metadata update could bypass the
explicit action protocol. Removing status from both HTTP and internal update
inputs makes every caller use the same transition checks.

**Reset existing tasks to proposed.** That would revoke already accepted work and
rewrite live progress during migration. Existing states are preserved; only new
creation uses the proposed default.

**Keep approval state inside a mounted dialog.** Closing and reopening would
forget a pending request or unknown outcome and permit another submission.
Project/task sessions retain operation identity independently of dialog lifetime.

## Consequences

The bounded original actions avoided reopening policy while approval was part of
the product. That restriction is intentionally superseded; ownership, release,
withdrawal, bulk changes and immutable attempt history have separate contracts.
The later [force-withdrawal decision](../architecture/2026-10-27-worker-force-withdrawal.md)
owns the worker reset; ordinary status setting does not perform it.
Authentication continues to use current project members after acquiring the
project lock, with identical member/admin task-write rights and exact Cookie
Origin/no-store handling. The successor preserves those boundaries.

The original production delivery added three approval scenarios per target;
those historical counts do not describe today's inventory. Current status,
recovery and transition journeys, permitted browser mutations and fixed inventory
are owned by the production acceptance documentation. The [cross-layer decision](../testing/2026-10-22-task-lifecycle-cross-layer-acceptance.md)
retains the distinction between real PostgreSQL upgrade/restart, installed-process
races, production browser journeys and deterministic or offline fixtures.
Instruction-contract checks verify the published files and workflow consistency,
without claiming arbitrary Agent compliance. Each runtime receipt remains bound
to its actual source and artifact.
