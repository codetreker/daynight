# Task and Goal writes

Start with [Overview](daynight://manuals/overview.md).

Read with [Write safety](daynight://manuals/write-safety.md) for Task/Goal creation, metadata, status, deletion and property mutations. For an existing resource, read its complete current Task definition and required inputs, then use that observation's exact decision version. Consult [Task reads](daynight://manuals/tasks.md) when the decision needs projection/status details beyond this topic. Read [Materials](daynight://manuals/materials.md) when defining or replacing formal material, and [Dependencies](daynight://manuals/dependencies.md) when submitting dependency fields.

## Creation and metadata

`task_create` defaults to ordinary `type: "task"`. New ordinary Tasks default to `proposed`, automatic execution disabled and the current Account as omitted assignee. Explicit initial status is `proposed` or `todo`; use `todo` for confirmed work. Registration does not start execution. Creation has no `allowAgents` input; enable automatic permission only through its separate authorized update.

For `type: "goal"`, status defaults to `todo` and may initially be `todo`, `in_progress`, `done` or `cancelled`. Omitted `assignedTo` selects the current Account; explicit null leaves it unassigned. A Goal has no Parent, dependencies or execution platform and owns its description, properties, Thread and attachments independently of children.

`task_update` changes metadata atomically; omitted fields remain unchanged and null clears nullable fields. Supplied `description` replaces the whole field. Dependencies are the whole-set exception explained in [Dependencies](daynight://manuals/dependencies.md).

An ordinary Task's `parentId` at creation/update must name a visible Goal in the same Project. On update, omission preserves ownership, null removes it, and a UUID assigns/transfers it. A Parent-only update is valid at the child's exact decision version. Parent changes do not alter dependencies, assignment or child status. A terminal Goal still accepts organization changes under each Task's rules.

Creation/update `tagIds` is the complete Project tag UUID set: omitted on creation means no tags; omitted on update preserves; `[]` clears. Returned summary/full Tasks expose `{id,name}` references.

`assignedTo` is a nullable local user UUID; `requiredPlatform` is unrestricted null or an advertised platform. A real assignee change disables `allowAgents`; same-assignee preserves it. Actual assignment/platform/permission changes are refused during `in_progress`; current-version same-values remain no-ops. Assignment grants neither Project access nor control of another claim.

Mutations returning a Task use `returnView`, not read `view`, and default to summary. Request/inspect full content when the next decision needs the complete resulting definition; a summary receipt does not read it.

## Ordinary Task transitions

`task_set_status` changes status; metadata updates do not. No mandatory transition sequence applies. Every direct prerequisite must be done/cancelled before entering `in_progress` or `done`. Cancellation has no satisfied-prerequisite gate and preserves dependency edges. A terminal predecessor can change dependent readiness without changing its version or supplying promised input.

A done Task cannot reopen while a direct successor is `in_progress`/`done`; cancelled successors impose no such restriction. Done may become cancelled without withdrawing scheduling satisfaction. A cancelled ordinary Task cannot reopen.

| Transition | Timestamp effect |
| --- | --- |
| Enter `in_progress` | New `startedAt`; clear `completedAt` |
| Return to `proposed`/`todo` | Clear `startedAt` and `completedAt` |
| `in_progress` → `done` | Preserve nullable `startedAt`; record `completedAt` |
| `proposed`/`todo` → `done` | Record `completedAt` without a start; elapsed execution time is unknown |
| Enter `cancelled` | Record `cancelledAt`; retain historical start/completion |

Use `completedAt` for current done completion and `cancelledAt` for current cancellation. Retained historical completion does not prove delivery of cancelled requirements. A real status change increments version once. Current-version same-status requests preserve state/times; stale requests still conflict. Metadata writes do not restart timing.

Ordinary status changes omit `claimId` and neither launch a process nor acquire a claim. User-directed ordinary execution is independent of automatic-selection filters but still requires capabilities, sufficient inputs, satisfied dependencies and authorization. Explicit original Worker assignments and owned-claim completion follow [Worker operations](daynight://manuals/worker-operations.md).

Ordinary completion requires actual outputs and acceptance for the selected scope. Set `done` with the newly observed exact Task version and no `claimId`. A finished Step/discussion, approved PR or empty ready result does not complete another scope. Missing required acceptance or confirmation preserves the actual state. Completing one Task grants no authority to execute its successor.

## Goal transitions

A Goal moves freely among `todo`, `in_progress`, `done` and `cancelled`, including reopening. Submit status and exact version in one `task_set_status` call; no separate confirmation token is required. Same-status at the current version is a no-op.

A child actually entering `in_progress`, manually or through a Worker claim, also starts its `todo` Parent in the same transaction. Other Goal states remain unchanged. Same-status requests and membership edits do not trigger this. Child completion, cancellation, rollback or claim release neither ends nor reverts the Goal; child progress does not derive Goal status.

A new `in_progress` interval records a new start; returning to `todo` clears interval times. Done/cancelled record their respective time and retain a nullable start. A done/cancelled Goal prevents new automatic child claims, while existing claims continue and manual child changes obey their own rules. Goal assignment is independent of child assignment. Goals support no execution controls, Steps or Worker claims.

## Cancellation and deletion

Cancellation retains readable material, history and dependencies under current access checks. It neither closes PRs/branches, deletes resources nor accepts work. Before ordinary cancellation, the authorized management owner must release any active Worker. Task status is not process control.

`task_delete` hides stored resources from ordinary reads/list/ready/graph while retaining records and attachment bytes. Ordinary deletion is refused for an active Worker claim and, by default, undeleted dependents. Explicitly authorized `removeDepends: true` removes incoming ordinary/external references in the same transaction, changing dependent versions and potentially readiness. Deletion authority alone does not cover that added effect.

Goal deletion hides the Goal and children while preserving parent links, child states, versions and dependencies; `removeDepends: true` is rejected. Active executions stop later through existing cleanup. Deletion is distinct from completion/cancellation and synchronous process termination. A `task_deleted` response differs from `not_found` or inaccessible; authentication, permission and transport failures leave absence/deletion unconfirmed.

## Property mutations

Read definitions and current complete values with `task_properties` before deciding. `task_set_property` replaces one whole value from raw JSON or direct-string `valueText`; `task_remove_property` removes the key. Names are complete case-sensitive literals: dots do not select nested paths. Preserve the complete ordered `pullRequests` array when replacing it; metadata creation/update has no property-specific PR field. Use the resulting version for later decisions, applying [Write safety](daynight://manuals/write-safety.md) to conflicts and unknown outcomes.
