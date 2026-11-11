# Session messages and original-operation recovery

Read this with the complete [Write safety](daynight://manuals/write-safety.md)
Resource before sending. Use [Session reads](daynight://manuals/session-reads.md)
when the exact target or execution identity has not been established. An
observation or attention hint is not authority to intervene.

## Freeze one authorized target and intent

`task_session_send` sends ordinary text to an explicit Task Web Session. The
caller must be the actual current Session owner; Project membership or Task
responsibility does not replace that ownership. Current credentials, scope,
validity, revocation, Project/Task access, execution, connection and turn must
permit the operation at submission and again before dispatch. Hidden Task or
deleted Project access is not restored by retaining an old Session ID.

Retain Project, Task, Session, a new caller-owned `operationId`, `claimId`,
`executionGeneration`, `expectedTurnId` and exact text before submission. The
command execution fence is Session ID, claim ID and execution generation. The
inspection's `connectionEpoch` observes the connection; it is not an accepted
send parameter or extra command precondition. Reconnection does not select a new
execution, but the current connection still has to pass admission.

For idle, `expectedTurnId` is explicitly null. Working requires the real current
turn and actual steer support. A changed execution or turn refuses the frozen
intent; do not refresh current and silently send it elsewhere.

```json
{
  "name": "task_session_send",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "sessionId": "33333333-3333-4333-8333-333333333333",
    "operationId": "44444444-4444-4444-8444-444444444444",
    "claimId": "55555555-5555-4555-8555-555555555555",
    "executionGeneration": "1",
    "expectedTurnId": null,
    "text": "Please inspect the failing test."
  }
}
```

Text is supplied directly, with Unicode and line endings preserved. Reject NUL,
malformed Unicode, whitespace-only text, more than 1 MiB UTF-8 text or more than
2 MiB encoded command. Slash text remains ordinary text. This operation does not
answer approvals, cancel a turn, queue input for later, create/resume a Session or
write Herdr terminal keys. It has no local file, stdin or CLI waiting arguments.
OAuth admission is limited to Task ordinary-message and receipt purposes; it
does not open Controller, Test/Bot, upload or other command permissions. Pending
dispatch reauthorizes the original Actor; revoked authority prevents dispatch
without erasing dispatch facts that already occurred.

## Read service completion and native state separately

Successful `structuredContent.data.operation` is the original operation receipt.
`structuredContent.meta.writeOutcome: confirmed` and `meta.phase: commit` establish
this service write, not Provider acceptance. Preserve `meta.refs` with all four
Project/Task/Session/operation IDs. On tool failure, completion facts appear in
`structuredContent.error.writeOutcome`, with the same shared confirmed,
not_committed and unknown meanings. Output failure does not undo a commit.

| `data.operation.state` | Native operation fact |
| --- | --- |
| `accepted`, `offered`, `dispatching` | Still pending; service acceptance is not Provider acceptance. |
| `provider_accepted`, `confirmed` | Distinct native acceptance/confirmation facts; neither proves the Agent completed the requested work. |
| `rejected`, `failed`, `expired` | Preserve the actual refusal, failure or expiration and its reason. |
| `unknown` | Native outcome remains unconfirmed. |

Tool error, service write completion and native state are independent. A
confirmed service write may still have a pending or unknown native outcome.
Keep its original identities through timeout, cancellation, lost output and
other failures; use the original-operation read to learn subsequent facts.

## Query the original operation without resending

Use a new operation UUID only for a first submission. The service binds it to an
intent hash containing original execution, operation ID, ordinary-message kind,
exact text and expected turn. An identical retained intent can return its original
receipt without another dispatch when admission remains valid; changing the
intent conflicts. An MCP transport ID or `requestId` is not that operation identity.

After any unknown send result, query the original four IDs:

```json
{
  "name": "task_session_operation",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "sessionId": "33333333-3333-4333-8333-333333333333",
    "operationId": "44444444-4444-4444-8444-444444444444"
  }
}
```

The read checks current credentials and visible Project/Task access and returns
the persisted `operation` with `currentBinding`. It can read an original Session
after a Task claim changes; `currentBinding: false` does not substitute a newer
Session. It does not restore a command body, recreate a queue, modify the
operation or produce a write-commit result. Success metadata contains correlation
and refs, without the send tool's `meta.writeOutcome` or `meta.phase`.

`not_found` means no receipt was available for that query. The original outcome
stays unknown; absence does not prove no send occurred. Keep the IDs and query
again when appropriate. Never retry send, choose a replacement operation ID,
refresh current to guess the old turn or treat not_found as permission to resend.
Authentication, permission and transport failures are not receipt absence.
