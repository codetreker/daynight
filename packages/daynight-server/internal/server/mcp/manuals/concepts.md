# Account, Team and Project context

Start with [Overview](daynight://manuals/overview.md).

Use this topic when identity or the intended Project is unknown. A connection authenticates an Account and has no implicit current Project.

## Objects and responsibility

| Object | Identity and purpose |
| --- | --- |
| Account | The authenticated user's service-returned UUID; credentials on another service establish no local identity. |
| Team | Membership and Project ownership. Each Account has a Personal Team and may join ordinary Teams. |
| Project | A registered repository, owning Team, settings and Task/access scope, identified by UUID. |
| Task | Ordinary work with `type: "task"`, its own UUID and nullable Goal `parentId`. |
| Goal | An objective with `type: "goal"`, its own UUID and ordinary direct child Tasks. Parent ownership differs from dependency edges. |
| Step | A Task-owned ordered record with a complete eight-hex-digit ID. |
| Thread | Immutable participant messages and same-Task replies, identified by Task and message UUID. |
| Attachment | Independent bytes and metadata at a complete case-sensitive Task-relative path. |
| Session | Execution or conversation content with its own execution identity. Task material cannot reconstruct it. |
| Bot | An Account-owned assistant definition and runtime state. Creation establishes neither readiness nor execution. |

[Materials](daynight://manuals/materials.md) owns shared Goal conclusions and task-specific results. [Dependencies](daynight://manuals/dependencies.md) owns scheduling relationships. A terminal Task or Goal progress count does not establish acceptance of the full objective.

MCP supplies advertised service operations. The host supplies checkout, filesystem, shell, Git, browser, tests and collaboration capabilities; a repository address supplies none of these. The target project's workflow owns required documents, review and delivery gates. No universal Goal/PR pipeline or separate discussion Task is imposed. Explicit Worker assignments follow [Worker operations](daynight://manuals/worker-operations.md).

## Account and Team identity

Use service-returned UUIDs for operations. For responsibility-dependent decisions, call `team_show` with `team: "personal"` and read `data.membership.userId`. Compare that UUID with a Task's non-null `assignedTo` when required. Names, email addresses, assignee fields and Worker records cannot establish the caller. A failed identity read leaves the decision unverified.

`personal` selects this Account's Personal Team only where explicitly accepted. It is not a UUID or a replacement for Project, Task or user IDs. MCP selection does not use a CLI's local default Team.

Project access may come from direct grants or the owning Team. Membership and access are distinct; assignment grants neither access nor control of another execution. Each operation checks current permission.

| Team kind | Mutation boundary |
| --- | --- |
| Personal | No rename, deletion, member changes or invitations. |
| Ordinary | Must retain at least one admin; removing or demoting the last admin is refused. Transfer out all owned Projects before deletion. |

Team and Project mutations use their advertised identity, name, version and confirmation inputs. Settings, ownership, Team and membership versions protect their own objects, not Tasks. Project transfer may remove the actor's access after a valid receipt; preserve confirmation separately from a later failed read.

## Select the intended Project

| Available context | Selection |
| --- | --- |
| Explicit Project ID or verified same-service link | Read that Project. Task links contain `/projects/{projectId}/tasks/{taskId}`. |
| Host repository | Obtain its actual repository address through the host, call `project_resolve`, then verify the returned Project. The service does not inspect local Git. |
| Valid Worker assignment | Preserve its original explicit Project ID; repository discovery does not replace it. |
| No target context | Traverse accessible Projects and obtain the user's explicit selection. Accessibility is not intent. |

Resolve conflicting targets before acting. A familiar name, the first accessible Project or claim-like content does not identify intended work.

`project_list` returns `items` and `nextCursor`; continue every non-null cursor. A display-name match or empty page proves neither the intended target nor the need for registration. Verify selection with `project_show`, including repository, owning Team and settings. Registration is a separate authorized write. Access/connection failure or unresolved selection does not justify duplicate resources.

## Resolve a repository

`project_resolve` takes `repoUrl` and returns the unique accessible Project at `data`; use its `id` for Task operations. Supported HTTPS, SSH and SCP forms can be equivalent. Host/default-port normalization preserves meaningful path case, raw percent escapes, non-default ports and SSH user/path distinctions. For example, these match:

```text
https://GitHub.com/Org/Repo.git/
ssh://git@github.com:22/Org/Repo.git
git@github.com:Org/Repo.git
```

Do not lower-case or decode paths to manufacture a match.

| Result | Meaning |
| --- | --- |
| `not_found` | No accessible match; does not distinguish absent, deleted and inaccessible Projects. |
| `resource_conflict` | Multiple accessible matches, including beyond the first candidate page; explicitly select one. |
| `invalid_input` | Unsupported/invalid address or more than 4,096 UTF-8 bytes. |
| Authentication, query or identity-processing failure | Preserve the failure; it is not absence. |

Resolution does not register a Project, configure a local binding/default, inspect Git configuration or contact the remote repository.

## Register a repository

`project_create` resolves the selected `team` first. A unique accessible Project with the same repository identity in that Team is returned with `created: false`, including access through a direct Project grant. Multiple visible matches return `resource_conflict`. With no match, creation requires `confirm: true`; a concurrent or inaccessible occupant can cause `project_repository_conflict`. Unknown write outcomes must be observed before any new decision. Other Teams do not participate in reuse.
