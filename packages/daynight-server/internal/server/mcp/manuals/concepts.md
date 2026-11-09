# Product concepts

Daynight organizes durable work in Projects and Tasks. MCP exposes operations on those objects to an authenticated account. A client or model uses the same service-side access checks as other supported product entry points.

Use this guide to establish which account, Project and work item an operation concerns. For the detailed read behavior, continue with [Queries and lifecycle](daynight://manuals/queries-and-lifecycle.md). Before a mutation, read [Write safety](daynight://manuals/write-safety.md) and [Operation boundaries](daynight://manuals/operation-boundaries.md).

## The objects and their relationships

| Object | Meaning | Where its identity comes from |
| --- | --- | --- |
| Account | The authenticated Daynight user on the selected service. | A service-returned user UUID associated with the current credential. |
| Team | A membership and ownership context. An account has a Personal Team and may join ordinary Teams. | The Team UUID returned by Team operations. Some tool inputs also accept the selector `personal`. |
| Project | A registered Git repository and the scope for its Tasks and project access. A Project has an owning Team. | Its Project UUID, repository address, settings and ownership returned by Project operations. |
| Task | An independently tracked work item with a title, description, status, properties, dependencies and execution requirements. | Its Task UUID within its Project. |
| Goal | An objective expressed through Tasks and their relationships. The chosen work process defines how those Tasks contribute to the objective. | The actual Task IDs and dependency graph that express the objective. There is no separate Goal CRUD resource. |
| Step | A Task-owned, durable, ordered record of work. Its title, description and status describe that work. | The parent Task and complete eight-hex-digit Step ID. |
| Thread | Durable participant discussion belonging to one Task. Messages are immutable and can reply to messages in the same Task. | The Task and message UUIDs returned by discussion reads or confirmed posts. |
| Attachment | A file in a Task's attachment area, used for inputs and results. | Its parent Task and complete, case-sensitive relative path. |
| Session | The execution or conversation context used for activity, tool calls and operational continuity. | Its own execution identity. Task descriptions, Steps and Thread messages do not reconstruct this context. |
| Bot | An account-owned assistant definition with its own configuration and associated runtime state. | Its Bot UUID and the explicit results returned by Bot operations. Creating a Bot does not establish that it is ready to run. |

A Task can have many Steps, Thread messages and attachment files. These are independent resources: a Task detail response does not embed their complete content. Read them through their own tools when the work needs them.

A Project's repository address identifies the repository associated with its work. Reading or modifying repository files still requires tools supplied by the host. A Project record does not provide a local checkout, a shell, Git operations or a Worker execution environment.

## Account, Team and Project scope

Confirm the service endpoint and authenticated account before selecting a Project. A credential for one service does not establish an identity or resource on another service. Names and email addresses are display information; use returned IDs for operations.

Team membership and Project access are related but distinct. A Project can have direct grants as well as access inherited from its owning Team. The service evaluates current access for the requested resource and operation. A display name, an old successful read or a previously selected Project does not establish current permission.

The `personal` selector means the current authenticated account's Personal Team for tool inputs that explicitly accept it. It is not a literal Team UUID and is not a general substitute for Project, Task or user IDs. Explicit Team selection in MCP does not depend on a CLI's locally configured default Team.

### Confirm the current account

Use `team_show` with `team: "personal"` to read the current account's Personal Team and membership. This is a read operation:

```json
{
  "name": "team_show",
  "arguments": {
    "team": "personal"
  }
}
```

The examples in this guide show the parameters passed to MCP `tools/call`. The client supplies its normal protocol envelope and metadata. All UUIDs in examples are fictional; use IDs returned by reads on the selected service.

In a successful result, the membership belongs to the authenticated account. The following is a selection of fields from `structuredContent`, with other returned fields omitted:

```json
{
  "data": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "membership": {
      "teamId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "userId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "role": "admin",
      "version": "1"
    }
  },
  "meta": {
    "requestId": "example-request"
  }
}
```

Read `structuredContent.data.membership.userId` as the current account's local user UUID. When an operation needs to check whether a Task is assigned to that account, obtain this identity independently and compare it with the Task's `assignedTo`. The Task's own assignee, its creator defaults, a display name or a Worker record cannot establish who is currently authenticated.

If the identity read fails, preserve that failure. Resolve the connection or access problem before making an identity-dependent decision.

### Establish the target Project

A normal MCP connection authenticates an account; it does not select a current Project or carry the host's local working directory. Establish the intended target from the information actually available:

| Available context | Project selection |
| --- | --- |
| An explicit Project ID or verified Project/Task link | Confirm the service and read the identified Project; read the Task under that Project when needed. A Task link uses `/projects/{projectId}/tasks/{taskId}`. |
| The host's current repository | Have the host obtain the actual repository address, then resolve that address through `project_resolve`. The server does not read the host's checkout. |
| A valid Worker assignment | Preserve and verify the Project ID explicitly supplied in the original assignment. Repository discovery does not replace that assignment. |
| No Project, link, repository or assignment context | List accessible Projects and have the user explicitly select the intended target. Accessibility alone does not establish intent. |

Resolve conflicts between explicit targets and other context before proceeding. A name, a familiar repository, the first accessible Project or a claim-like value in content cannot establish the target by itself.

### Resolve a known repository address

Use `project_resolve` when the repository address is known:

```json
{
  "name": "project_resolve",
  "arguments": {
    "repoUrl": "https://example.com/team/repository.git"
  }
}
```

The tool searches Projects accessible to the current account and returns the ordinary Project object for a unique match. Read `structuredContent.data.id` as the Project ID; `name` and `repoUrl` help verify the object. The selected fields from `structuredContent.data` look like:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "name": "Example repository",
  "repoUrl": "https://example.com/team/repository.git"
}
```

Matching uses the service's repository identity rules rather than raw URL equality. Equivalent HTTPS, SSH URL and SCP forms can identify the same repository; host normalization and default ports follow those rules. Repository path case, raw percent escapes, non-default ports and meaningful SSH user or path distinctions are preserved. For example, `https://GitHub.com/Org/Repo.git/`, `ssh://git@github.com:22/Org/Repo.git` and `git@github.com:Org/Repo.git` have the same identity; do not lower-case or decode the path to manufacture a match.

The result has explicit boundaries:

- No accessible match returns `not_found`. This does not distinguish an absent Project from one that is inaccessible or deleted, and does not create one.
- Multiple accessible matches return `resource_conflict`, including when the additional match is beyond the first candidate page. List and select the intended Project explicitly; do not choose the first match.
- Invalid, unsupported or over-limit addresses return `invalid_input`. Repository addresses follow the existing 4,096 UTF-8-byte limit.
- Authentication, query and identity-processing failures remain failures; they are not evidence of no match.

Resolution is read-only. It does not configure a default Project, change a binding, inspect local Git configuration or check the remote repository over the network. A returned ID does not freeze access for later operations.

### List and verify the selected Project

Read one page of accessible Projects when selecting a target, resolving ambiguity or inspecting available work:

```json
{
  "name": "project_list",
  "arguments": {
    "limit": 50
  }
}
```

Successful Project list data has `items` and `nextCursor`. If `nextCursor` is non-null, pass the returned string as `cursor` to continue. Confirm a Project by its repository address and returned identity, reading further pages when necessary. A similar name is insufficient, and an empty page or failed request does not justify creating a replacement Project.

Read a known, resolved or explicitly selected Project directly:

```json
{
  "name": "project_show",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111"
  }
}
```

The result identifies the Project, its repository, settings and owning Team. Relevant selected fields in `structuredContent.data` look like:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "name": "Example repository",
  "repoUrl": "https://example.com/team/repository.git",
  "settings": {
    "version": "2",
    "executionWarningMinutes": 120
  },
  "ownership": {
    "teamId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "version": "3"
  }
}
```

The versions in settings and ownership protect their own data. They are separate from a Task's version, a Team's version and a membership version. Preserve the exact version for the object involved in a decision.

Registration is a separate write operation and requires the appropriate authorization. Authentication failures, permission errors, unavailable service responses or unresolved selection must be addressed before an identity-dependent decision.

## Tasks: durable work and current facts

A Task defines work, carries formal material and exposes current scheduling facts. Its title helps a person recognize it; its ID identifies it. Its description and readable sources provide the actual requirements and results.

Read full Task details when the decision requires the definition:

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

The following selected fields illustrate a full Task in `structuredContent.data`:

```json
{
  "projection": "full",
  "id": "22222222-2222-4222-8222-222222222222",
  "projectId": "11111111-1111-4111-8111-111111111111",
  "title": "Verify the export behavior",
  "description": "Check the documented export result and preserve the evidence.",
  "status": "todo",
  "version": "12",
  "assignedTo": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "allowAgents": false,
  "requiredPlatform": null,
  "dependsOn": [],
  "externalDependsOn": [],
  "blockedBy": [],
  "ready": true,
  "properties": {}
}
```

These fields answer different questions:

| Field | What it expresses |
| --- | --- |
| `status` | The Task lifecycle: `todo`, `in_progress`, `done` or `cancelled`. |
| `assignedTo` | The responsible account's user UUID, or `null` for no assignment. |
| `allowAgents` | Whether the Task permits automatic agent execution under the scheduling rules. |
| `requiredPlatform` | The execution platform requirement, or `null` when unrestricted. |
| `dependsOn` / `externalDependsOn` | All direct prerequisites and their external subset in a returned Task. Read and write shapes differ; see [Dependencies](daynight://manuals/dependencies.md). |
| `blockedBy` / `ready` | Current scheduling facts derived by the service. They do not prove material sufficiency or grant execution authorization. |
| `version` | The exact Task observation version, encoded as a decimal string. |
| `properties` | Values governed by the server's property definitions. A property does not create an additional API or execution mode. |

`ready: true` and `allowAgents: false` can describe a Task whose dependencies permit work while automatic execution remains disabled. `in_progress` records a lifecycle state; it is not an executor lock or a lease held by the client that read it. `done` records completion state, while `cancelled` records cancellation. Both satisfy dependency scheduling, but cancellation is not proof that the requested result was delivered.

The default Task detail projection is `summary`. A summary identifies and helps select the Task, but omits full definition content. Choose `view: "full"` explicitly when that content is required. Full Task details still do not supply attachment bytes, the full Step collection or the Thread. The [queries guide](daynight://manuals/queries-and-lifecycle.md) explains how to obtain each.

## Goals and dependency chains

A Goal describes an objective served by several Tasks. The actual dependency graph supplies the work relationships. Ordinary dependencies connect Tasks in the same chain; external dependencies express prerequisite context from another chain in the same Project. Both classifications affect readiness.

A source reference and an execution prerequisite express different relationships. One Task can read another Task's material without requiring a new execution dependency. Preserve the actual producer and consumer requirements when deciding which relationship is needed.

A Task reaching `done`, an empty ready result or an ended chain does not establish that a Goal's full requirements were delivered. The selected scope, required results and actual acceptance evidence determine that conclusion. Workflows may choose requirements discussions, design discussions and delivery stages; those choices belong to the applicable project or work process.

See [Dependencies](daynight://manuals/dependencies.md) for graph membership, replacement semantics and verification. See [Materials](daynight://manuals/materials.md) for references between independent material owners.

## Steps, Thread and attachments

Steps keep ordered records of work inside one Task. Their IDs are eight hexadecimal digits, such as `0000000a`, not Task UUIDs or list positions. Retain the complete ID, including leading zeroes, together with the parent Project and Task. Different Tasks may contain the same Step ID. Step states are `todo`, `in_progress`, `done` and `skipped`; a Step finishing does not finish its Task or establish review success.

Thread is participant discussion. Read messages through the Thread tools rather than expecting them in Task details. Each message has its own identity and attribution; posting does not trigger an agent or change Task execution state. An accepted discussion conclusion must be reflected in the material that owns the effective requirement or result.

Attachments belong to a Task's independent file area. A path such as `design/overview.md` identifies a file within that Task. It is not a local filesystem path, a globally unique filename or an instruction to fetch arbitrary files. Files, metadata and content must be read through their supported operations. Attachment replacement does not advance the Task version.

Use [Materials](daynight://manuals/materials.md) to choose the right owner for information, and [Files and references](daynight://manuals/files-and-references.md) for complete file reads, uploads and reference resolution.

## Host, Session and Worker responsibilities

The MCP server exposes service-side operations. The host decides which tools and resources it presents to a model and supplies any local file, shell, Git, browser or collaboration capabilities. A model reading a Project or Task does not acquire those host capabilities from the server.

A Session owns execution content and operating context. Task material remains independently readable across Sessions. Thread discussion and Steps persist independently of an execution Session and must not be used to infer missing execution ownership or authorization.

A Worker-managed execution has an explicit assignment with its own original Task, claim, workspace and controller responsibilities. Ordinary MCP access, a Task property, `allowAgents` or a claim-like value in content does not establish that assignment. Apply the actual environment's declared mode and the user's current authorization. Reading this manual does not activate a workflow or start work.

## Start from a verified context

For an existing work item, establish the facts in this order as needed:

1. Confirm the selected service and active authenticated account.
2. Discover the available tools and their current schemas through `tools/list`.
3. Independently establish the current account UUID when a decision depends on responsibility.
4. Establish the intended Project from an explicit ID/link, a host-provided repository address, a valid assignment or an explicit user selection. Resolve a known address with `project_resolve` and verify the returned Project; do not infer a current Project from the connection.
5. Read the selected Task with the projection needed for the decision, then read its genuinely required Steps, discussion and attachments separately.
6. Use the user's request, applicable project rules and current authorization to decide the permitted operation. Bind any subsequent versioned write to the observation used for that decision.

These reads establish context. They do not select a successor Task, enable automation, create missing resources or supply permission to execute the described work. The detailed operation rules are in [Operation boundaries](daynight://manuals/operation-boundaries.md).
