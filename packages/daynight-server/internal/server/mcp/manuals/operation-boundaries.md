# Operation Boundaries

Use this guide to decide what an operation does, which authority it needs, and how its result affects later work. The tool schema defines valid arguments. Service permissions and lifecycle rules determine whether a request can commit. The user’s instructions, applicable project rules, and any valid execution assignment determine which work is authorized.

These are separate questions. Access to a task does not authorize implementation. A request to prepare a task does not automatically request its execution. A successful confirmation flag or status change does not establish permission to publish, deploy, communicate externally, merge a pull request, or push a main branch.

## Identify the intended operation

| Operation | Product effect | Decision boundary |
| --- | --- | --- |
| Read | Observe projects, task fields, Steps, Thread messages, attachments, or documentation | Reading related information does not expand the work to those objects. |
| Register work | Create a task and define its scope, inputs, outputs, and relationships | Registration records work. New tasks are `todo` with `allowAgents: false`; creation does not execute them. |
| Discuss | Read or post immutable Thread messages and maintain effective requirements or results | Posting does not start an Agent or change task status. An accepted discussion conclusion belongs in its effective description or attachment. |
| Execute | Perform the work of a specified task using the required host capabilities | Execution requires sufficient inputs, satisfied prerequisites, and existing authorization for that work. |
| Hand off | Review a selected task and enable its eligibility for automatic execution | Review content and authenticated responsibility before enabling `allowAgents`. The Worker may then acquire the task when eligible. |
| Deliver | Publish the actual outputs required by the task, such as a document, code change, release, or deployment | The task and project determine its delivery endpoint. A generic task state does not establish permission for each external operation. |
| Complete | Record that the selected task’s completion conditions have been met | Use ordinary completion or the original Worker claim path as applicable. A completed stage is not proof that a whole Goal has been delivered. |
| Cancel | Record an irreversible, readable business terminal state | Cancellation requires authorization for the selected task. It satisfies scheduling prerequisites without claiming successful delivery. |
| Delete | Soft-delete a task, removing ordinary task access while retaining stored data | Deletion requires authorization for that target. Removing other tasks’ dependency references is an additional effect that must be covered by the authorization. |

A task can combine several authorized operations, but they do not imply one another. For example, “prepare a task for review” may cover creating the definition and attaching inputs while leaving execution and automatic selection disabled. Existing standing authorization can cover repeated operations within its defined scope; do not manufacture a new approval requirement when that authorization already applies.

## Separate three kinds of authority

**Service permission** is the authenticated account’s access to the relevant resource and operation. The server checks it on the request. Responsibility assignment does not grant Project access, and knowing a resource UUID does not grant access to it.

**Operational authorization** comes from the current user’s request, applicable project rules, and a valid assigned execution scope. Determine the intended target, allowed changes, and delivery boundary before acting. A task description can define required results, but it does not reconstruct missing authorization to perform an external action.

**Tool confirmation** is an explicit input required by some tool schemas. For example, Team mutation tools require `confirm: true`; some operations also require current names or versions. Supplying that value satisfies the tool’s confirmation input. It does not replace operational authorization, permission checks, version checks, or other service preconditions. Task tools do not all have a `confirm` field: send only arguments supported by the selected tool.

Likewise, `readOnlyHint`, `destructiveHint`, and similar tool annotations describe behavior. They are not grants of permission.

## Understand task fields before acting

| Field or observation | What it establishes | What it does not establish |
| --- | --- | --- |
| `assignedTo` | The responsible person’s local user UUID, or `null` | Project access, control over an existing Worker claim, or the current caller’s identity |
| `allowAgents` | Permission for automatic selection when other eligibility conditions hold | Current execution, permanent proof of content review, or blanket permission for repository operations |
| `ready` | The observed scheduling prerequisites are satisfied for the query’s task | Complete inputs, authorization to start, or exclusive ownership |
| `requiredPlatform` | The automatic-selection platform requirement; `null` is unrestricted | The caller’s actual runtime platform or a reason to bypass a task’s required capabilities |
| `status: "in_progress"` | The task is in its current execution interval | A process lock, lease, stop signal, or proof that this conversation owns execution |
| `status: "done"` | Successful delivery is recorded for that task | Independent proof of every claimed output or completion of all related tasks |
| `status: "cancelled"` | Further execution is not required and the task is terminal | Delivery of the original requirements |
| A Worker record | Recorded execution ownership and history | A new assignment to the caller or authority to adopt another execution’s claim |

A real change to `assignedTo` disables `allowAgents` in the same update. A same-value assignment preserves permission. Actual assignment, automatic-permission, and required-platform changes are prohibited while `in_progress`; current-version same-value requests remain no-ops, while stale versions still conflict.

Ordinary execution explicitly directed by the user is not restricted by the filters used for automatic selection. It still needs the required capability, satisfied dependencies, sufficient inputs, and authorization. A platform filter does not change the actual environment: a Linux process in WSL is Linux.

See [queries and lifecycle](daynight://manuals/queries-and-lifecycle.md) for field and state semantics and [write safety](daynight://manuals/write-safety.md) for decisions bound to observed versions.

## Establish current identity independently

Use the authenticated connection’s actual account identity when a decision depends on responsibility. Do not infer the current account from the task’s own `assignedTo`, a display name, an email address, or a Worker record.

The following example is the `params` object for MCP `tools/call`:

```json
{
  "name": "team_show",
  "arguments": {
    "team": "personal"
  }
}
```

A successful result exposes the current account at `structuredContent.data.membership.userId`. The membership belongs to the authenticated caller. Preserve that UUID when comparing it with the selected task’s non-null `assignedTo`.

Read the selected task’s complete content before deciding whether it is sufficiently defined:

```json
{
  "name": "task_show",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "view": "full"
  }
}
```

UUIDs and versions in this guide are fictional examples. Replace them with IDs and exact version strings from successful observations of the intended objects. Full task detail does not contain attachment bytes, and it does not replace separate reads of required Steps, Thread messages, or attachments. See [materials](daynight://manuals/materials.md) and [files and references](daynight://manuals/files-and-references.md).

An unreadable task or unknown current account leaves responsibility unverified. Report the actual access or identity problem. Do not repair that uncertainty by reassigning the task, creating a duplicate, or granting permissions without authorization.

## Enable automatic execution deliberately

A handoff applies to the selected task or explicitly fixed set of tasks. For each task, read its full content and actually required inputs, then check scope, result ownership, acceptance conditions, status, dependencies, platform, assignment, automatic permission, and execution history.

To pass responsibility review, compare the non-null `assignedTo` with the independently established current account UUID. A mismatch or missing identity is a concrete gap, not an instruction to reassign the task. Review the selected task directly; enumerating unrelated task collections is unnecessary for this check.

A well-defined blocked `todo` task can be prepared for automatic execution before its predecessors finish. It must not pretend that future outputs already exist. Enabling permission leaves real dependency blockers in effect; the Worker can acquire the task only when its eligibility conditions are satisfied.

| Observed state | Appropriate handoff action |
| --- | --- |
| `todo`, `allowAgents: false`, content and responsibility sufficient | Enable permission using the exact task version on which the decision was based. |
| `todo`, `allowAgents: false`, unresolved content or responsibility gap | Report the gap and preserve assignment and permission. |
| `todo`, `allowAgents: true` | Review read-only. Rewriting the same permission is not a review receipt. |
| `in_progress`, `allowAgents: false` | Report the locked permission. Do not change status to bypass the restriction. |
| `in_progress`, `allowAgents: true` | Report the current execution and review observations. Review does not pause, stop, release, or reassign that execution. |
| `done` or `cancelled` | Report the actual terminal result; a handoff does not need to enable execution or reopen the task. Cancellation remains distinct from delivery. |

After a passing review of a `todo` task at version `"12"`, a permission-only update has this shape:

```json
{
  "name": "task_update",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "ifVersion": "12",
    "allowAgents": true,
    "returnView": "full"
  }
}
```

Omit unrelated fields. Check the write result and then read back the task, including its assignment and execution record. Required mutable source content must also remain sufficient; comparing only attachment names or timestamps does not verify its contents.

A Worker may claim the task immediately after the update. A higher observed version, `in_progress`, or a new active Worker record can be the expected result of scheduling. Do not repeat the permission write to restore the earlier state.

If a later observation reveals a responsibility or content problem, report the actual state and that scheduling may already have occurred. Stopping, revoking, releasing, or transferring an execution requires its own authorized management action. Enabling permission does not recreate a released worktree or continue an old claim.

See [write safety](daynight://manuals/write-safety.md) before another mutation following a conflict, missing response, or unknown result.

## Start and complete ordinary work within its scope

For an explicitly selected task without a Worker-owned execution, first establish its complete requirements, actual inputs, dependency state, authorization, and the host’s necessary tools. Read related material only as needed for those decisions. Reading a predecessor, sibling, or successor does not authorize doing its work.

Once an ordinary `todo` task is ready and execution is authorized, entering `in_progress` uses the version observed for that decision:

```json
{
  "name": "task_set_status",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "ifVersion": "12",
    "status": "in_progress",
    "returnView": "full"
  }
}
```

This records the interval. It does not launch a process or acquire a Worker claim. If the task is already `in_progress`, reconcile current work and execution ownership rather than treating the status as a free assignment. All direct prerequisites must be `done` or `cancelled` before entering `in_progress` or `done`; required inputs and stage confirmations remain separate from this scheduling condition.

Completion follows the selected task’s real outputs and acceptance conditions. A document task can deliver readable documents; a code task can require verified code and the selected repository delivery endpoint. The service does not impose a universal PR, review count, prototype, or Goal-stage procedure on every task. Follow the task’s confirmed requirements and applicable project policy.

Ordinary completion uses `task_set_status` with `status: "done"`, a newly observed `ifVersion`, and no `claimId`. A completed Step, approved PR, empty ready page, or finished discussion alone cannot establish completion of a different scope.

When required user confirmation, authorization, acceptance, or external intervention is still pending, retain the actual task state and preserve the current work’s context. Do not infer permission from elapsed time, task status, successful tests, or acceptance results. Do not start a successor merely because the current task is complete.

## Preserve a valid Worker assignment

Worker-managed execution starts through an explicit runtime assignment that identifies the original Project, Task, claim, Worker, worktree, and execution context. A generic MCP connection, a task’s Worker property, or possession of a claim UUID does not establish that assignment.

A valid Worker assignment authorizes delivery within its assigned scope under its execution contract, including any delivery authority already granted there. Required checks, project rules, and explicit user restrictions, pauses, and revocations continue to apply. This authority is not created by the `claimId` field itself.

The assigned executor preserves the original claim and resources, verifies them before business writes, and performs only that assignment. If automatic permission is false under the managed contract or the original active claim no longer matches, the executor stops the affected work and does not enable itself, acquire a replacement claim, or adopt another worktree. Independent pause or revocation must be honored even when the task still appears ready or active.

For `task_set_status`, only completion of an owned active claim accepts `claimId`, and only with `status: "done"`. The claim must be the one explicitly supplied by the valid assignment. The service checks that the active execution matches and that the caller is its current owner. Ordinary completion omits the field. If one path is rejected, do not switch to the other to bypass it.

After a managed completion, confirm the result and retained original claim. An uncertain result requires observation of that original execution; do not automatically replay completion. Controller-owned scheduling, resource management, release, and cleanup remain with their actual owner.

The public MCP business tools do not provide general Worker registration, claim acquisition, release, Session management, local worktree creation, or process control. Those capabilities must be supplied by the actual execution environment and its supported management mechanisms.

## Treat cancellation, deletion, and stopping as different operations

Cancellation is irreversible. It keeps the task and its materials readable under current access checks, preserves dependencies, and can unblock a successor because cancelled prerequisites count as terminal. It does not deliver the cancelled requirements, close a PR, stop a process, or remove a branch.

An active Worker execution must be released through an authorized management operation before cancellation. Changing ordinary task status does not perform that release. Released history also does not grant authority to restart the original execution with a new claim.

Deletion is separate from task status. `task_delete` soft-deletes the task; it is strict by default when undeleted tasks depend on the target. An authorized `removeDepends: true` additionally removes ordinary and external references from dependents in the same transaction, increments affected versions, and may make those tasks ready. The authority to delete the selected task does not by itself cover that additional dependency change.

Deletion is prohibited while the target has an active Worker claim. Do not use status changes, permission toggles, cancellation, or deletion as a substitute for stopping a running executor. See [dependencies](daynight://manuals/dependencies.md) for relationship effects and [write safety](daynight://manuals/write-safety.md) for uncertain deletion outcomes.

## Keep MCP and host capabilities distinct

MCP provides the operations actually advertised by `tools/list` and their schemas. It does not create local filesystem access, a browser, a Git client, a code editor, a test runner, a deployment credential, or an independent reviewer. A task that needs one of these capabilities requires an appropriate host or execution environment.

For example, saving a design attachment does not make the MCP server able to implement it in a repository. A Bot definition is not proof that a Bot is running or ready. A task marked `in_progress` is not proof that a terminal exists. A read of documentation does not activate a workflow Skill.

Choose the operation that fits the authorized result and report concrete missing capabilities. Do not invent a tool name from a concept or reuse CLI flags as MCP arguments. The selected tool’s current schema owns exact inputs; [concepts](daynight://manuals/concepts.md) explains the objects and [queries and lifecycle](daynight://manuals/queries-and-lifecycle.md) explains how to observe them.
