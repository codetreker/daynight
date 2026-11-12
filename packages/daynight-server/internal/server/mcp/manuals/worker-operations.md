# Worker assignments and handoff

Read this topic when handing off selected work, interpreting an explicit Worker assignment or completing its original claim. Every write also requires [Write safety](daynight://manuals/write-safety.md). [Tasks](daynight://manuals/tasks.md) owns general lifecycle and fields; [Concepts](daynight://manuals/concepts.md) owns Account/Project identity.

## Handoff is not execution

For each explicitly selected Task, read full content and actually required inputs. Verify scope, acceptance/results, dependencies, status, platform, assignment, automatic permission and execution history. Future predecessor outputs cannot be treated as present. A well-defined blocked todo Task can be prepared before its prerequisites finish; eligibility remains blocked until scheduling permits acquisition.

Establish the current account independently with `team_show`, `team: "personal"`, and its returned `structuredContent.data.membership.userId`. Compare it with non-null assignedTo for responsibility review. Unknown/mismatching identity is a gap, not permission to reassign, grant access or create duplicate work. A Task record or display name cannot identify the caller.

| State | Handoff boundary |
| --- | --- |
| proposed | Review authorized content; permission alone cannot make proposed executable. Choosing todo requires an explicit caller decision. |
| todo, permission false, inputs/responsibility sufficient | Authorized handoff may enable permission with its decision version. |
| todo with unresolved inputs/responsibility | Report the gap; preserve assignment/permission. |
| todo with permission true | Review current facts; same-value permission is not a review receipt. |
| in_progress | Report current execution and locked actual permission changes; do not alter status to bypass them. Review neither pauses nor transfers execution. |
| done/cancelled | Preserve the actual terminal result; handoff does not require reopening or permission changes. |

For a passing authorized todo review at version `"12"`:

```json
{"name":"task_update","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","taskId":"22222222-2222-4222-8222-222222222222","ifVersion":"12","allowAgents":true,"returnView":"full"}}
```

Examples are `tools/call` parameters with fictional identities/versions. Omit unrelated fields. Inspect the result and current assignment/execution/material; a Worker may claim immediately. Later version/in_progress/active history can be expected scheduling, not a reason to repeat the permission write. Identified problems may require authorized stopping/revocation/release by the actual management owner. Enabling permission neither recreates a released worktree nor resumes its original claim.

## Ordinary work and explicit assignments

Ordinary execution explicitly directed by the user still requires sufficient inputs, satisfied prerequisites, actual host capabilities and authorized scope. It does not depend on automatic permission/platform filters. Reading predecessors/siblings/successors supplies inputs rather than authority to perform their work. Existing in_progress requires reconciling actual work and execution ownership; it is not a free assignment.

Completion uses the selected outputs and acceptance endpoint. No universal PR/review/prototype/Goal-stage process is imposed by the MCP service. Ordinary completion sets done with its newly observed exact version and **no claimId**. A completed Step, finished discussion, approved PR or empty ready result does not complete a different scope. Missing required confirmation/acceptance preserves the actual state and operating context; completing one Task does not authorize starting its successor.

Worker-managed execution is established by an explicit runtime assignment naming the original Project, Task, claim, Worker, worktree and execution context. A generic MCP connection, worker property, allowAgents or possession of a claim-like UUID does not establish it. The executor follows that original scope and contract, including existing delivery authority and current user restrictions, pauses/revocations and project checks. The claim field itself grants no authority.

Preserve and verify original claim/resources before writes. If original active claim no longer matches, or automatic permission is false under the managed contract, stop affected work; do not enable yourself, acquire another claim or adopt another worktree. Release clears current ownership; the original Session and archive retain history. A later execution uses ordinary claim eligibility and new identities.

## Complete the original owned claim

`task_set_status` accepts explicit claimId only with status done. For a **real completion transition** with an active Worker, the service validates matching current claim and caller ownership. Use the claim explicitly supplied by the valid assignment:

```json
{"name":"task_set_status","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","taskId":"22222222-2222-4222-8222-222222222222","ifVersion":"12","status":"done","claimId":"44444444-4444-4444-8444-444444444444","returnView":"full"}}
```

A current-version same-status request can return confirmed/unchanged before rechecking claim ownership. It confirms the current Task state, **not** that an earlier unknown completion succeeded or that its original claim was authenticated. Version/input and compatible-Worker checks still apply. Do not switch between ordinary and claim-bound paths after rejection to bypass protection.

Inspect the completion result and original retained execution. Unknown completion requires observing that original scope without automatic replay or manufacturing historical attribution from current state. Scheduling, controller ownership, release and cleanup remain with their actual owner.

MCP business tools advertise no general Worker registration, claim acquisition/release, local worktree creation or process control. Task cancellation/deletion/status and permission toggles are not stop signals. Goals cannot be claimed; completing or cancelling a Goal excludes its children from subsequent automatic claims while existing claims continue. Ordinary active Worker cancellation/deletion requires authorized release; Goal deletion can hide children while their executions stop later through existing cleanup. Session inspection/message capabilities are separately advertised in [Session reads](daynight://manuals/session-reads.md) and [Session messages](daynight://manuals/session-messages.md); they do not create a valid Worker assignment.
