# Product concepts and context

Read this topic to identify the Account, Team, Project and resource an operation concerns. Discover current inputs through `tools/list`. Read [Tasks](daynight://manuals/tasks.md) for Task projections and [Write safety](daynight://manuals/write-safety.md) before a write. A connection authenticates an account; it has no implicit current Project.

## Objects and responsibilities

| Object | Identity and purpose |
| --- | --- |
| Account | The authenticated user's service-returned UUID. A credential on one service establishes no identity on another. |
| Team | Membership and Project ownership context. Each account has a Personal Team and can join ordinary Teams. |
| Project | A registered repository, its owning Team, settings and Task/access scope; identified by a Project UUID. |
| Task | Ordinary work identified by a Task UUID within its Project, with `type: "task"` and nullable Goal `parentId`. |
| Goal | A stored objective with `type: "goal"`, its own resource UUID, shared outcomes and overall progress. Ordinary direct child Tasks track contributing work; Parent and dependency edges are different relationships. See [Tasks](daynight://manuals/tasks.md) and [Materials](daynight://manuals/materials.md). |
| Step | A Task-owned ordered work record, identified by parent scope and a complete eight-hex-digit ID. See [Steps](daynight://manuals/steps.md). |
| Thread | Immutable participant messages and same-Task replies, identified by Task and message UUID. See [Threads](daynight://manuals/threads.md). |
| Attachment | Independent Task file bytes and metadata, identified by the complete case-sensitive relative path. See [Attachment reads](daynight://manuals/attachment-reads.md). |
| Session | Execution or conversation content and its own execution identity; not reconstructed from Task material. See [Session reads](daynight://manuals/session-reads.md). |
| Bot | An account-owned assistant definition and associated runtime state, identified by a Bot UUID. Creation does not prove readiness or execution. |

Descriptions, attachments, Steps, Threads and Sessions require separate reads. [Materials](daynight://manuals/materials.md) explains Goal-owned specifications, architecture, breakdowns, conclusions and progress, regardless of which Session or child Task produces them. Source references identify inputs; dependency edges control scheduling and ordinary-chain membership. Neither terminal Task status nor Goal progress proves acceptance of the complete objective.

MCP supplies the service operations it advertises. The host supplies any local checkout, filesystem, shell, Git, browser, tests or collaboration capabilities. A Project's repository address does not provide those capabilities. Repository workflows govern their own delivery and confirmation rules; this product manual does not impose a universal Goal/PR pipeline. An explicit Worker assignment has its own controller and workspace responsibilities; see [Worker operations](daynight://manuals/worker-operations.md).

## Account and Team identity

Use returned UUIDs for operations. Names, email addresses, a Task's assignee and a Worker record cannot establish the current caller. For responsibility-dependent decisions, obtain the authenticated account independently:

```json
{"name":"team_show","arguments":{"team":"personal"}}
```

Examples here are MCP `tools/call` parameters, with fictional identifiers. The client supplies its protocol envelope and metadata. Read `structuredContent.data.membership.userId` as the current account UUID, then compare it with a Task's non-null `assignedTo` when needed. If the read fails, preserve the failure before making an identity-dependent decision.

`personal` selects this account's Personal Team only in inputs that explicitly accept it. It is not a Team UUID or a general replacement for Project, Task or user IDs. MCP selection does not depend on a CLI's local default Team.

Team membership and Project access are distinct: a Project can have direct grants and inherited access from its owning Team. Assignment grants neither access nor control of another execution. The service checks current permission on each operation; an earlier successful read does not freeze access.

| Kind | Mutation boundary |
| --- | --- |
| Personal Team | Cannot be renamed/deleted, change members or issue invitations. |
| Ordinary Team | Must retain at least one admin: removing or demoting the last admin is refused. Deletion requires transferring out all owned Projects. |

Use each tool's actual identity, name, version and confirmation inputs for Team or Project mutations. A Project transfer can leave the actor without access after a valid receipt; preserve that receipt separately from a later failed read.

## Establish the intended Project

| Available context | Selection |
| --- | --- |
| Explicit Project ID or verified same-service link | Read that Project; Task links contain `/projects/{projectId}/tasks/{taskId}`. |
| Host repository | Have the host obtain its actual repository address, resolve it with `project_resolve`, and verify the returned Project. The server does not inspect local Git. |
| Valid Worker assignment | Retain its original explicit Project ID; repository discovery does not replace it. |
| No target context | Page through accessible Projects and have the user explicitly select the intended one. Accessibility is not intent. |

Resolve conflicting targets before acting. A familiar name, first accessible Project or claim-like value in content does not identify intended work.

```json
{"name":"project_resolve","arguments":{"repoUrl":"https://example.com/team/repository.git"}}
```

A unique accessible match returns the ordinary Project at `structuredContent.data`, whose `id` is used by later Task tools. Repository identity rules equate supported HTTPS, SSH and SCP forms, normalize hosts/default ports and preserve meaningful path case, raw percent escapes, non-default ports and SSH user/path distinctions. For example, `https://GitHub.com/Org/Repo.git/`, `ssh://git@github.com:22/Org/Repo.git` and `git@github.com:Org/Repo.git` match; do not lower-case or decode their paths to manufacture a match.

No accessible match returns `not_found`, without distinguishing absent, deleted or inaccessible Projects. Multiple accessible matches return `resource_conflict`, including a match beyond the first candidate page; explicitly select the target. Invalid/unsupported addresses or addresses beyond 4,096 UTF-8 bytes return `invalid_input`. Authentication, query or identity-processing failures remain failures.

Resolution neither registers a Project, configures a local binding/default, inspects Git configuration nor checks the remote repository over the network.

```json
{"name":"project_list","arguments":{"limit":50}}
```

Project list data contains `items` and `nextCursor`. Pass a non-null returned cursor into the next call; a matching display name or one empty page cannot establish the target or justify registration. Verify the selected record:

```json
{"name":"project_show","arguments":{"projectId":"11111111-1111-4111-8111-111111111111"}}
```

The returned Project identifies its repository, owning Team and settings. Settings, ownership, Team and membership versions protect their own objects, not Task writes. Registration is a separate authorized write. Connection/access failures or unresolved selection leave identity-dependent decisions unverified; they do not justify duplicate resources.
