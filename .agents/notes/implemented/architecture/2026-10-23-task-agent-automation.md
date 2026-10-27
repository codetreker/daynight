# Agent Note: Task Agent Automation Permission

Status: implemented

## Problem

Ready tasks may require a person to arrange their execution, while a foreground
worker needs a stable rule for selecting work without a new conversation. A
task can also wait for human input during agent execution without changing who
owns its resources. The task model must express permission for automatic
selection independently of status, dependency readiness and actual executor
identity.

## Decision

The adopted [requirements](../../../../docs/spec/daynight-worker.md) and
[architecture](../../../../docs/design/daynight-worker.md) use a top-level
boolean `allowAgents`. This decision supersedes the Human/Agent role
portion of the [worker design](2026-10-22-worker-design.md); its service/worker/
Herdr/agent responsibilities and recovery rules remain unchanged. The service
persists and exposes the permission, the CLI updates and filters it, and the Web
implements the confirmed switch. Optional platform restrictions are implemented
under the [platform decision](../feature/2026-10-24-task-required-platform.md),
which preserves this permission independently. Worker-specific claim and
foreground runtime integration remain separate implementation work.

New tasks always start with `allowAgents=false`; a database migration gives
existing tasks `true` while preserving their other fields, versions and business
timestamps. Creation rejects a supplied permission. An authenticated project
member changes the flag through ordinary versioned task PATCH: omission keeps
the value, explicit false disables it, and null or nonboolean values fail.
Status changes preserve the flag. Explicitly designated execution remains
available regardless of it; automatic worker claim requires it together with
ready state, platform compatibility and unique ownership.

The task detail places one combined “Automatic execution” / “自动执行” label
and switch at the right of the status row below the title. Status, readiness
and the platform selector occupy the left group. The combination
provides both the confirmed state and its operation; the detail has no separate
automation badge or lower Overview switch. List status badges retain their
own purpose. Long titles remain above this row, and narrow layouts may wrap
the compact platform control only within the left group. The control stays right
aligned with the first status line at its top. Locked controls explain their reason through hover/focus tooltips; error,
unknown-result and human-waiting feedback uses the shared floating layer owned
by the [notification decision](../bug-fix/2026-10-24-task-detail-notifications.md),
without allocating reading height or causing horizontal overflow. A newly observed successful submission uses a
three-second floating status bubble without consuming reading height. The
[compact-header decision](../simplification/2026-10-24-compact-task-detail-header.md)
owns its presentation lifetime and the task title in the common header; the
confirmed mutation remains in the existing session after the bubble disappears.

Both enabling and disabling open a confirmation dialog, and its confirm action
submits the captured target value and exact version directly. Cancel, Escape
and closing the dialog submit nothing. The switch reflects confirmed server
state until a successful response replaces it. The task owns an in-flight write
after the dialog closes; unknown results block new writes while actual state
is read, without automatic resubmission.

Permission changes use the existing member authorization and project
transaction lock. Exact-version same-value PATCH preserves version and time;
stale versions still fail. Actual changes during `in_progress` fail, including
human-input waits. Disabling permission does not stop or withdraw execution.
The separate [force-withdrawal operation](2026-10-27-worker-force-withdrawal.md)
atomically clears claim ownership, returns todo and disables permission.
Worker and bundled agent workflows may not enable permission themselves.
Confirmation records deliberate operation intent; session and PAT credentials
identify a principal without proving a physical human is operating the client.

## Alternatives

**A Human/Agent processing role.** The original worker design used two role
values to distinguish tasks eligible for automatic selection from manually
arranged tasks. That kept readiness independent, but the product decision being
expressed is whether automatic agent handling is allowed. A boolean directly
states that permission while leaving actual user, machine and agent identity
with the execution record.

**A dedicated permission action and an additional confirmation field.** The
role design used a separate endpoint and `confirmAgent` field. A named switch
with confirmation in both directions already captures the target permission
and deliberate action. Existing task PATCH supplies authorization, version
checking, serialization and error propagation; another endpoint or duplicate
field would not establish that the caller is physically human.

## Consequences

Task resources, graph projections, strict readers, filters and update writers
carry the boolean explicitly. The database migration owns old data;
runtime readers do not invent a default for missing fields. The flag is applied
before candidate pagination and included in cursor scope. The [worker claim
foundation](2026-10-24-worker-claim-foundation.md) rechecks it inside the claim
transaction. A local filter on a bounded page cannot establish that no eligible
work exists.

Switch changes share the task write gate with status setting and confirmed
platform changes. The [platform control decision](../simplification/2026-10-24-task-platform-confirmation-control.md)
owns the status-row select, its confirmation and select-focus restoration.
Version conflicts require a fresh decision, confirmed failures retain the prior
value, and uncertain writes remain unresolved until actual state is observed. Those
guarantees accompany the implemented permission controls, existing task/attachment
state retention, bilingual labels, keyboard operation and fixed graph geometry.

The CLI exposes `--allow-agents true|false` on update, list and bounded ready
queries. New automatic candidate selection uses true together with actual-runtime
platform compatibility, retaining both on fallback inventories and rechecking
the latest full task before exact-version claim. The
[platform decision](../feature/2026-10-24-task-required-platform.md) owns runtime
mapping and candidate eligibility; automatically selecting an ID is not explicit
manual assignment. Workflows may not enable the flag themselves. Explicit single-task
execution remains available regardless of it. Human output displays the
permission and JSON retains the required boolean.

Permission acceptance covers migration/defaults, strict resources, both filter
values and cursor scopes, full-precision versions, no-op/in-progress rules,
status/permission races, confirmed controls and existing explicit task execution independently of
worker-specific endpoints. Browser acceptance exercises the same permission
PATCH through a real service, including lost responses and cross-close request
ownership. Automatic claim transaction checks, controlled coordinator
integration and independent live cross-platform execution still require their
own runtime evidence.
