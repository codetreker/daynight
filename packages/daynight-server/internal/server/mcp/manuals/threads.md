# Task discussion Threads

Read this for complete discussion pages, posts and same-Task replies. Posting
also requires [Write safety](daynight://manuals/write-safety.md).
[Materials](daynight://manuals/materials.md) owns the incorporation of accepted
conclusions into formal requirements and results.

## Read complete pages and preserve position

`task_thread_read` returns complete immutable messages, oldest to newest within
each page. With neither boundary it selects the latest page, not the beginning
of history. `count` defaults to 20 and accepts 1–100; a page can contain fewer
available messages, and bodies are not truncated. Reads require current
credentials and Project access to a live Task or Goal; a parent or access failure
must not be treated as an empty Thread.

The example is a `tools/call` params object with fictional IDs. Business data is
under `structuredContent.data`.

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

Data contains `items`, `hasMoreBefore` and `hasMoreAfter`. Each message has `id`,
`author`, `body`, `createdAt` and optional `replyTo`. The author contains `userId`,
nullable `displayName` and case-sensitive boolean `Agent`. With `details: true`,
verified Agent authors may include `execution` with `claimId`, `workerId` and
`provider`. A missing display name does not remove the author UUID or establish
an anonymous author.

| Purpose | Boundary and continuation |
| --- | --- |
| Read older history | `beforeId` is the earliest message actually returned; follow `hasMoreBefore`. |
| Read forward continuously | `afterId` is the latest message fully consumed; follow `hasMoreAfter` and retain that consumed position. |
| Empty forward page | Keep the previous `afterId`; no message has advanced the position. |

Supply at most one boundary. Both are message UUIDs belonging to this same Task,
not Task-list or Step-list cursors. A `message_not_found` refusal is not an empty
page. Initial latest-page reading does not mean earlier history was consumed;
read older pages when the decision depends on it.

Posting does not advance continuous consumption. If A was last consumed, another
participant's unseen B followed by a local post C must still be read from
`afterId: A`; jumping to C would skip B. Retain this position separately from the
local post's receipt.

## Post once under the actual scope

`task_thread_post` appends one immutable message or a `replyTo` message in the
same Task. It has no Task version or caller message ID; the service assigns the
ID. `claimId` authenticates optional execution attribution as the current owned
claim, not submission identity, and is never inferred from other Task fields.

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

Preserve the complete intended body and any reply/claim identity before sending.
Posting requires current credentials, write access and a live parent resource.
The body must be nonempty UTF-8 without NUL; the complete encoded message must
fit 64 KiB, including attribution; oversize content is rejected as
`payload_too_large`. Exact arguments belong to the tool schema.

A confirmed receipt contains the assigned message and ID. A post changes neither
Task status, version, timestamps, properties nor dependencies, and does not
trigger an Agent or start work. A message discussing a future upload does not
establish that the file exists or that its content was consumed.

## Preserve unknown submission history

A lost response or `message_outcome_unknown` retains uncertainty. Never
automatically resend. Read normal pages before making another explicit posting
decision; equal text cannot establish that the prior post succeeded, and a new
post creates another message. An error's `candidateMessageId` is a diagnostic
reference, not a successful receipt.

A validated `clock_not_advanced` rejection establishes that this post failed.
Other failures must be classified by their actual completion facts: an error
can follow a confirmed write, while cancellation or a generic server failure
does not establish rollback. Retain any confirmed message ID even if later
output or cleanup fails, and continue reading from the consumed position rather
than that receipt.
