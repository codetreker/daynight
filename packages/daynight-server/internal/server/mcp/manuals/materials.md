# Organizing task materials

Use this guide when reading or maintaining requirements, designs, discussion, work records, and results for a Task. The purpose is to make the effective work independently understandable while keeping execution context in its proper place.

Examples show the parameters passed to MCP `tools/call`. The MCP client supplies the protocol envelope and required request metadata. UUIDs and versions in examples are fictional: replace them with identities and exact versions obtained from the relevant reads. Discover the current tool definitions with `tools/list` before submitting arguments.

## Choose the owner by purpose

A Task can have a description, attachments, Steps, a Thread, and execution Sessions. These are separate resources with different responsibilities.

| Content | Effective owner |
| --- | --- |
| What problem is being solved, expected behavior, scope, constraints, inputs, outputs, and acceptance conditions | Task description and its actual referenced materials |
| A substantial specification, design, report, image, prototype, or other formal deliverable | The Task's attachment area, when a separate file is appropriate or required by the applicable process |
| Durable participant questions, proposals, replies, and discussion history | The Task's Thread |
| An ordered record of work within the Task, including a work item's objective, completion conditions, result, and material references | A Step, according to the project's rules |
| Command schedules, tool calls, debugging history, transient todos, worktree details, runtime logs, claim and waiting context | The execution Session or the relevant runtime platform |
| Permission for the current agent to execute, publish, communicate, deploy, or merge | The actual user and repository authorization context; task content is not a substitute for that context |

Classify a document by what it does. A migration plan or operating manual can be a formal deliverable. A session's schedule for producing that deliverable remains execution context. A Step can describe a durable work result without becoming a copy of the session timeline.

The description and attachments own the Task's overall requirements and formal results. A Step can reference those materials rather than copying them. Thread messages preserve the discussion that produced a decision; the effective content owner must also contain the accepted decision.

For the underlying object relationships, read [Product concepts](daynight://manuals/concepts.md). For permission and execution boundaries, read [Operation boundaries](daynight://manuals/operation-boundaries.md).

## Make a Task independently understandable

A reader should be able to understand the work without the original chat, a private checkout, or temporary files. The description and actual readable references together need to establish:

- The concrete problem and intended outcome.
- The behavior, constraints, and responsibility of this Task.
- The necessary inputs, their owners, and where to read them.
- The deliverables and any real producer/consumer contracts.
- Observable acceptance conditions, including relevant failure or boundary behavior.

These are information requirements, not mandatory headings or an empty template. A short Task can hold everything inline. A larger Task can keep detailed material in attachments or other owning Tasks and provide precise references. An unexplained link, “see the previous discussion,” or a document that only points to another equally empty document does not supply the missing information.

A required implementation approach belongs in the durable Task definition when another executor needs it. It is different from the current Session's command-by-command schedule. Do not invent an architecture, acceptance threshold, or future prerequisite output to make an incomplete definition appear complete.

For example, the following is a complete illustrative definition for a documentation Task. Its retention rules are hypothetical task inputs, not Daynight product behavior:

```markdown
# Clarify the report retention policy

## Outcome

Publish a readable explanation of the report retention policy in this Task's
final description.

## Scope

Explain the policy and its examples. This Task does not change application
behavior or stored reports.

## Confirmed input

Generated reports are retained for 14 calendar days. The retention boundary
is evaluated at 00:00 UTC. A report remains available through its fourteenth
calendar day. Downloads already saved by a person are outside this policy.

## Deliverable

A final description containing the policy, one boundary-date example, and the
scope of the policy. There are no prerequisite attachments or exchanges with
another Task.

## Acceptance

- The text states 14 calendar days and the UTC boundary explicitly.
- A worked date example is consistent with the boundary rule.
- The text distinguishes server-held reports from downloaded copies.
- The text makes no claim that application behavior changed.
```

A project may require an independently uploaded specification, a particular review, or a specific result format for a selected workflow. Apply those requirements when that workflow is actually selected. Daynight does not make every Task a full Goal pipeline or require every definition to have a separate specification file.

## Read complete material before changing it

Task detail, Steps, Thread, and attachments require separate reads. A Task's description is not an attachment inventory and does not contain attachment bytes. A list projection does not prove that the formal material has been read.

Read the Task with full content before deciding how its definition should change:

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

Retain the Task's exact `version` with the content used for the decision. Read the actual attachments or source Tasks needed for that decision, not just filenames or timestamps. See [Queries and lifecycle](daynight://manuals/queries-and-lifecycle.md) for projections and pagination, and [Files and references](daynight://manuals/files-and-references.md) for complete file reads.

A supplied `description` replaces the entire field. Construct the coherent final description, preserving all still-effective requirements and references. Omit metadata fields that are unrelated to the change. To replace a short illustrative description after observing version `12`:

```json
{
  "name": "task_update",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "ifVersion": "12",
    "description": "# Report retention policy\n\nGenerated reports are retained for 14 calendar days, evaluated at 00:00 UTC. A report remains available through its fourteenth calendar day.\n\nFor a report created on 1 January, 14 January is its fourteenth calendar day; it is no longer retained when the 15 January UTC boundary is evaluated.\n\nThis policy covers server-held reports. Downloaded copies are outside its scope. This documentation Task changes no application behavior.\n",
    "returnView": "full"
  }
}
```

The actual description must follow the Task's confirmed inputs. Do not use the example's invented business rules for a real Task.

Inspect the confirmed response and read the full Task again when needed to verify the effective material. On conflict, reread and reassess the content; do not simply replace `ifVersion` and replay an earlier edit. A lost response can follow a committed change. [Write safety](daynight://manuals/write-safety.md) explains how to distinguish a confirmed result, a rejection, and an unknown outcome.

## Use Thread for durable discussion

A Thread belongs to one Task and is independent of its execution. Read it for participant questions, proposals, and replies. Posting does not change the Task's status, version, timestamps, properties, or dependencies, and does not trigger an Agent.

With no boundary, `task_thread_read` selects the latest page. The default count is 20 and the allowed count is 1–100. The response's `data.items` contains complete messages in oldest-to-newest order, with `hasMoreBefore` and `hasMoreAfter` indicating available history and forward continuation.

```json
{
  "name": "task_thread_read",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "count": 20,
    "details": true
  }
}
```

Use the first completely read message's full UUID as `beforeId` to read older history. Use the last completely read message's full UUID as `afterId` to continue forward. Supply at most one boundary. Preserve the previous position when a forward read is empty.

To append an ordinary account message:

```json
{
  "name": "task_thread_post",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "body": "The policy explanation should use UTC calendar-day boundaries. Please verify that the worked date example follows that rule."
  }
}
```

The service assigns the message ID and author. A reply adds `replyTo` with the full UUID of a message in this same Task. Message bodies and author records are immutable. There is no edit operation for correcting a posted message; post a new, explicit correction and update the effective content owner when the correction becomes an accepted requirement.

Omit `claimId` for ordinary account attribution. Supply an actual valid active claim explicitly only when verified Agent attribution applies; do not infer one from task state, local environment, or a document.

A posting receipt does not advance a continuously read position. If the last consumed message is A, another participant posts B, and this client posts C, continue with `afterId` A so B remains readable. Advancing directly to C would skip another participant's contribution.

Do not automatically repeat an unknown post. The tool has no caller-supplied message ID that makes repetition an idempotent retry. Matching text in a later page does not prove that the original submission committed. Retain the original body and known identities, read normal pages to establish current facts, and apply [Write safety](daynight://manuals/write-safety.md) before deciding whether a new post is appropriate.

## Incorporate accepted conclusions into formal material

A discussion message can propose or confirm a rule, but a reader of the effective definition should not need to reconstruct all discussion history to find that rule.

When a conclusion becomes effective:

1. Identify the document or field that owns it. A requirement belongs with the requirements; a design mechanism belongs with its design; a result belongs with its formal result.
2. Read the owner's current content and any required mutable sources.
3. Rewrite the affected material as a coherent whole, preserving valid requirements, conditions, references, and essential rationale.
4. Use the correct version or file-write contract, then verify the resulting content and references.
5. Keep the Thread's messages as their immutable discussion history. Where useful, post a precise pointer to the effective material.

For example, a Thread may establish that a requirement uses calendar days. Update the owned requirement and its worked examples together. Leaving a contradictory “24-hour period” statement in the description while adding “calendar days” only in Thread leaves the effective definition inconsistent.

The act of recording a conclusion does not itself grant permission to execute it. A Task can accurately describe planned work while its execution still depends on the applicable authorization and prerequisites.

## Use Steps for durable work within a Task

Steps are an independent ordered collection. They can hold work objectives, completion conditions, results, and references to formal material. Project rules determine whether and how to divide a Task into Steps. The collection can validly be empty.

A Step is identified by its complete eight-hex ID within its Task, such as `00ab12cd`. Preserve leading zeros. This is different from a Task or message UUID, and the same Step ID can exist in another Task.

Read Steps explicitly. Summary is the default, so request full content when the descriptions matter:

```json
{
  "name": "task_step_list",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "view": "full",
    "limit": 50
  }
}
```

The result includes the parent Task's exact `version`, the ordered `items`, and `nextCursor`. Follow non-null cursors using the same scope and view when the decision requires the complete collection. Step pages are bound to a parent version; a changed collection or other parent-version change can invalidate continuation. Restart the required observation rather than combine incompatible pages.

Step writes share the parent Task version with versioned Task metadata, status, and property writes. After a successful Task description update, obtain the new parent version before making a Step decision. Do not reuse the older description version merely because no Step was edited.

For a project that uses Steps, the following adds an explicitly identified work record after observing parent version `13`:

```json
{
  "name": "task_step_add",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "id": "00ab12cd",
    "title": "Verify the retention example",
    "description": "Check the date example against the confirmed calendar-day rule. Complete when the final description and example agree. Record the observed result here and keep the policy itself in the Task description.",
    "status": "todo",
    "ifVersion": "13",
    "returnView": "full"
  }
}
```

This records a durable unit of work. It does not start execution or authorize an agent to perform the check.

Step statuses are `todo`, `in_progress`, `done`, and `skipped`. Any transition is allowed, and more than one Step can be in progress. Order, Step status, and a business review result are separate facts. A Step marked `done` says that its work ended; it does not prove that review passed, the Task is done, or the Goal was delivered. Steps do not affect Task readiness, Worker acquisition, or Task completion; Task state does not automatically change Steps.

Step descriptions can include a concise result and a reference to the formal output. They should not become a transcript of shell commands, transient todos, or session logs. Deletion removes the Step without a public restore or edit history; preserve formal deliverables in their proper owners.

## Preserve readable references and shared ownership

A shared document should have one effective owner. A consuming Task should identify the owning Project and Task, the exact attachment path or description section, and the purpose for which the source is required. Read that actual source before treating it as sufficient input.

For repository sources, identify the path and an actual immutable revision when the task depends on a specific version. A machine-local checkout path is not a durable source for another reader. For attachments, use actual case-sensitive paths and preserve their relative resource layout. [Files and references](daynight://manuals/files-and-references.md) explains attachment-root and document-directory link resolution.

Do not copy an entire shared design into every Task. Retain enough local definition to explain the consuming Task's own outcome and boundary, then reference the source precisely. Do not invent attachment paths or cross-task relative URL schemes. A Thread message that says a document will be uploaded is not proof that the file exists.

A source reference and an execution dependency answer different questions. A reference identifies where information is owned; a dependency controls readiness and task-chain relationships. An inline citation does not create an edge. Conversely, a prerequisite being terminal does not prove its promised material is present, applicable, or sufficient. See [Dependency management](daynight://manuals/dependencies.md).

Attachments can change independently of the Task version. A previously observed version, unchanged inventory, or timestamp does not freeze their contents. Reread mutable material when a later decision depends on it. If sources disagree, identify their actual authority and resolve the substantive conflict within the allowed scope before treating inputs as sufficient.

## Keep Markdown and result semantics intact

Descriptions preserve their original Markdown string. The Web renders CommonMark/GFM and displays raw HTML as text. Preserve newlines, code, and valid links when replacing a description.

Write only contracts that actually exist. When one Task produces data or documents for another, state the necessary fields, types, requiredness, format or revision, error behavior, units, and null semantics. When there is no exchange, say so plainly rather than inventing an interface.

Formal results should make clear what was delivered, where to read it, what was observed, and any material limitations. Status alone is not evidence that an output exists or a requirement was met. The appropriate content owner can hold a result inline, in an attachment, or through precise readable references, subject to the selected project's requirements.

Keep the current material coherent as it changes. Preserve important reasons for decisions and the conditions under which they apply; keep execution chronology and transient troubleshooting context in the Session.
