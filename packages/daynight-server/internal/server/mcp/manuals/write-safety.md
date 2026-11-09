# Write safety

Use this guide before creating or changing Daynight data through MCP. It explains how to preserve the facts behind a decision, interpret the result, and handle a response that does not establish whether the write completed.

Examples show the `params` object passed to MCP `tools/call`. The UUIDs, Step ID and version strings are fictional. Replace them with identities and versions obtained from actual reads. A version in an example is never permission to use that version against a real object.

## Observe, decide, submit, verify

A reliable write has four distinct parts:

1. Read the object and the material needed to make the decision. For a Task definition, request the complete Task, not a title preview or a full list projection without descriptions. Read required attachments and other independent resources separately.
2. Decide the intended change from those observations and the applicable authorization. Preserve the observed resource identity and exact version.
3. Submit the intended fields once, including the version used for that decision when the operation supports version checking.
4. Interpret the returned completion facts, retain any receipt and resulting identity, and verify the outcome required by the operation. Do not turn verification into automatic resubmission.

For example, obtain a complete Task before changing its description:

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

If that observation yields version `"12"`, and the reviewed change remains authorized, submit that version:

```json
{
  "name": "task_update",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "description": "The complete replacement description.",
    "ifVersion": "12",
    "returnView": "full"
  }
}
```

Omitted metadata fields remain unchanged under this example. Dependency inputs have separate replacement semantics: submitting either dependency classification replaces both sets. Preserve all intended relationships when changing them; see [Dependencies](daynight://manuals/dependencies.md).

Read [Queries and lifecycle](daynight://manuals/queries-and-lifecycle.md) for complete-content selection and lifecycle conditions, and [Materials](daynight://manuals/materials.md) for deciding which content belongs in a description.

## Bind the write to the decision version

MCP versions are decimal strings representing positive signed 64-bit integers. Preserve their digits exactly. The supported range is `"1"` through `"9223372036854775807"`; leading zeroes, signs, fractions, exponent notation, zero and values outside the range are invalid. Do not convert a version through a floating-point JSON number.

Use the version of the object that the tool changes:

| Change | Relevant observation |
| --- | --- |
| Task metadata, status, properties or versioned deletion | The Task's version |
| Adding, editing, moving, setting status or deleting a Step | The parent Task version returned by the Steps resource |
| Renaming or deleting an ordinary Team | The Team version |
| Changing a Team member's role or removing membership | That user's membership version, not the Team version |
| Transferring a Project | The ownership version used by the transfer operation, not a Task or membership version |

Use the corresponding tool's actual schema and read result for other versioned resources. IDs and versions have different roles: knowing the right Task ID does not supply its current version, and a version from another object cannot protect the decision.

Some tools permit `ifVersion` to be omitted and perform a read before submission. That read cannot protect a decision made from an earlier observation. Supply the earlier decision's exact `ifVersion` whenever the change depends on it. If the operation has no version input, do not invent one or assume that a nearby object's version protects it.

A successful no-op can preserve the version and timestamps. A request for an already-current status or value still checks the supplied version; stale same-value requests can conflict. `in_progress` is not an executor lock, lease or proof of ownership.

### Resolve a conflict by making a new decision

When the service rejects a version conflict:

1. Keep the original decision and request identifiable.
2. Read the current object, relevant relationships and required mutable material again.
3. Compare the observed changes with the intended result, authorization and current scope.
4. Decide whether to abandon, revise or submit a newly justified change.
5. If another write is justified, use the exact version supporting that new decision.

Merely replacing `"12"` with the latest version and sending the original mutation again discards the concurrency protection. The conflicting change may alter the content, assignee, dependencies or meaning of the requested action.

## Read completion facts from the structured result

Daynight tool results place business data and completion information in `structuredContent`. The short success text `Completed.` is not the business result. A normal successful result has `structuredContent.data` and `structuredContent.meta`; a tool execution failure has `isError: true` and `structuredContent.error`.

| Field | Meaning |
| --- | --- |
| `structuredContent.data` | The returned business resource or receipt. Its shape depends on the tool and selected projection. |
| `structuredContent.meta.requestId` | The request correlation identifier for a successful result. Retain it when diagnosing the call. |
| `structuredContent.meta.outcome` | When present, operation-level change information such as `changed` or `unchanged`. This is not the same field as a failure's write-completion classification. |
| `structuredContent.error.code` and `.message` | The reported failure category and explanation. |
| `structuredContent.error.requestId` | The failed request's correlation identifier. |
| `structuredContent.error.writeOutcome` | When present, the established write-completion facts: `confirmed`, `not_committed` or `unknown`. |
| `structuredContent.error.phase` | When present, the operation phase associated with the failure. |
| `structuredContent.error.refs` | When present, supplementary identities or observations that help locate the affected operation. Fields vary by tool and failure. |

A request correlation ID is not a deduplication token. Reusing an MCP JSON-RPC ID or retaining `requestId` does not make a business mutation idempotent. Tools without an explicit submission identity do not gain one from the transport envelope.

Interpret `writeOutcome` separately from whether the tool returned an error:

| Established outcome | Required interpretation |
| --- | --- |
| `confirmed` | The write completed even though a later phase may have failed. Preserve that fact; investigate or read back the result without repeating the mutation. |
| `not_committed` | The service establishes that this write did not commit. Correct the actual failure and reassess current facts before deciding on a new operation. Earlier independent writes are not rolled back by this result. |
| `unknown` | The service cannot establish whether the write committed. Preserve the original operation context and inspect current facts; do not automatically repeat it. |
| No completion field or no usable result | The response supplies no write-completion classification. Do not infer rollback from its absence. Use whatever definite protocol or operation facts are available; otherwise preserve the uncertainty. |

A request rejected before the business operation runs establishes that this attempt performed no business write. Interpret an operation failure according to its returned completion facts. A disconnected transport, cancellation or generic server error does not by itself establish rollback. When the result includes explicit completion facts, retain them even if a later local presentation step fails.

### A tool error can follow a committed write

This excerpt shows the relevant tool-result fields for a Step operation whose write committed but whose output could not be constructed. The enclosing JSON-RPC response and protocol-version fields are omitted:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "The tool result could not be constructed."
    }
  ],
  "structuredContent": {
    "error": {
      "code": "internal_error",
      "message": "The tool result could not be constructed.",
      "requestId": "example-request",
      "writeOutcome": "confirmed",
      "phase": "output",
      "refs": {
        "projectId": "11111111-1111-4111-8111-111111111111",
        "taskId": "22222222-2222-4222-8222-222222222222",
        "stepId": "c0ffee01"
      }
    }
  }
}
```

The `isError` flag does not negate `writeOutcome: "confirmed"`. Read the original Task's Steps to recover the resulting resource. Do not add a replacement Step in response to this error.

An MCP protocol error outside the tool-result envelope may have no `structuredContent`. Keep that protocol error distinct from a Daynight tool execution error; do not fabricate completion fields that were not returned.

## Preserve identity when the result is uncertain

A timeout, cancellation or lost response can occur after a mutation takes effect. Cancellation does not prove rollback. Before deciding on another write, retain:

- The service and authenticated account context.
- The original Project, Task and other known resource IDs.
- The intended fields, decision version and relevant authorization.
- The returned request ID, error phase, completion facts and supplementary references, if any.
- Any resource or transfer identity known before submission or returned in a usable receipt.

Read the corresponding object or collection under the original scope. Explain what is currently known and what remains unconfirmed. Current facts and historical submission facts answer different questions.

For example, observing that a Task now has the requested description establishes its current content. It does not prove that the uncertain call caused that content. Another writer may have made the same change. A later absence also does not prove that a deletion succeeded: access changes, another deletion or other state changes can prevent a read.

For uncertain creation, do not create another resource because one search is empty or a matching title is present. Use complete fields, scope, known identities and the operation context to assess candidates. Preserve confirmed IDs and finish missing operations on the original resources when that is justified. If verification is unavailable, report the actual access or read error and preserve the uncertainty.

## Task Steps share the parent version

Steps use the parent Task version for concurrency. Read the current Steps and the Task definition needed by the decision; submit the observed parent version on the Step mutation. A real collection change increments that parent version once. Changes to other versioned Task fields can therefore invalidate a Step decision, and Step changes can invalidate a pending Task write.

A Step ID consists of eight hexadecimal characters. `task_step_add` accepts an optional explicit `id`; omitting it lets the service choose an ID. If an explicit identity is needed for subsequent investigation, choose it before submission and preserve it with the original scope. It is an object identity, not permission to replay an add.

```json
{
  "name": "task_step_add",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "id": "c0ffee01",
    "title": "Verify the attachment references",
    "status": "todo",
    "ifVersion": "12",
    "returnView": "summary"
  }
}
```

The MCP Step tool has no client request-UUID parameter. Preserve its Step ID and available request correlation and `refs` facts, but do not assume there is a replay key. An unknown add must not automatically be repeated with either the same ID or a newly chosen one. A present ID, absent ID or equal title describes current state; none proves the history of the unknown add.

A confirmed Step mutation returns a resource version and change facts. A summary receipt can identify the changed Step without including the complete collection. Request or read complete content when the next decision requires it.

## Thread posts have no caller submission identity

`task_thread_post` appends one immutable message or a reply to a message in the same Task. It does not accept a Task version or client message ID. The service assigns the message ID.

```json
{
  "name": "task_thread_post",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "body": "The acceptance criterion needs a concrete failure outcome."
  }
}
```

A supplied `claimId` authenticates optional execution attribution; it is not a post identity and must not be inferred from unrelated Task fields. Keep the confirmed message ID when a valid receipt returns. Reading or posting discussion does not start execution or change Task status.

If the response is lost, read normal Thread pages before deciding whether to send another message. Equal text cannot establish that the earlier post succeeded, and a new explicit post creates another message. Supplementary `candidateMessageId` references on an error are not a successful post receipt.

`clock_not_advanced` is a definite failed post when returned as the validated rejection. `message_outcome_unknown` explicitly retains uncertainty. More generally, preserve the reported write outcome rather than classifying every server error as a safe retry. A confirmed post receipt also does not move the reader's continuous read position past other participants' unread messages; see [Queries and lifecycle](daynight://manuals/queries-and-lifecycle.md).

## Attachments and multi-step changes

Attachment writes do not advance the Task version, status or update time. An unchanged Task version does not prove that required files are unchanged, and it cannot freeze references to other Tasks.

Read required mutable bytes again when the decision depends on their current content. A directory inventory, filename, size or timestamp is not a substitute for reading the required material. After upload, verify the bytes and metadata needed by the result. See [Files and references](daynight://manuals/files-and-references.md) for inline upload, resumable transfer identities, ranged snapshots and complete-content checks.

Task creation, attachment uploads, description replacement and status changes are independent writes. Several files can succeed only partially. For example:

1. A Task is created and its ID is confirmed.
2. Two attachments are uploaded; only the first is confirmed.
3. A later operation fails.

The Task and first attachment remain real results. Preserve their identities, determine the second upload's actual completion facts, and resume the missing work when justified. Do not recreate the Task or claim that all operations rolled back together.

Readbacks also have their own permissions and consistency scopes. A later read can fail after a confirmed write because access changed. Preserve the original confirmed receipt and report the failed read separately.

## Confirmation and authorization are separate

Some tools require `confirm: true` in addition to object identity and version information. That input means the caller is submitting the operation's confirmation; it does not supply the user's missing authorization, waive service permissions or bypass other preconditions.

For example, a Team membership change needs the observed membership version and its confirmation input. A Project transfer uses the ownership facts required by the transfer tool and may leave the actor without access after a valid receipt. Do not reinterpret a subsequent inaccessible Project as evidence that the transfer failed.

Before a destructive or consequential action, establish its actual scope and authorization, verify the relevant subject and version, and use the exact tool contract. Read [Operation boundaries](daynight://manuals/operation-boundaries.md) for the distinction between service permission, a workflow choice and operational authorization.
