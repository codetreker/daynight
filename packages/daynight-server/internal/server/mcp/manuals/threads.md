# Task discussion Threads

Read [Overview](daynight://manuals/overview.md) first. Use this topic for complete discussion reads, posts and same-Task replies. Posting also requires [Write safety](daynight://manuals/write-safety.md); [Materials](daynight://manuals/materials.md) owns incorporation of accepted conclusions into formal material.

## Read and retain the consumed position

`task_thread_read` returns complete immutable messages, oldest to newest within a page. Without a boundary it selects the latest page. `count` defaults to 20, range 1–100; available pages may be shorter, and bodies are not truncated. Reads require current credentials and Project access to a live Task or Goal. Parent/access failures are not empty Threads.

Results contain `items`, `hasMoreBefore` and `hasMoreAfter`. A message has `id`, `author`, `body`, `createdAt` and optional `replyTo`. Author has `userId`, nullable `displayName` and case-sensitive boolean `Agent`. With `details: true`, verified Agent authors may include `execution` containing `claimId`, `workerId` and `provider`. A missing display name does not remove identity or establish anonymity.

| Continuation | Boundary |
| --- | --- |
| Earlier history | `beforeId`: earliest returned message; follow `hasMoreBefore` |
| Forward reading | `afterId`: latest fully consumed message; follow `hasMoreAfter` |
| Empty forward page | Retain the previous `afterId` |

Supply at most one boundary, using a message UUID from the same Task. Task list cursors are not Thread boundaries. `message_not_found` is a refusal, not an empty page. Reading the latest page does not consume earlier history; read it when needed.

Posting does not advance reading. If A was last consumed, unseen B then local post C must still be read from A; jumping to C skips B. Retain the consumed position separately from posting receipts.

## Post and interpret the receipt

`task_thread_post` appends one immutable message or a reply to `replyTo` in the same Task. There is no Task version or caller message ID; the service assigns the ID. Optional `claimId` authenticates attribution to the caller's current owned claim, not submission identity; do not infer it from Task fields.

Retain the complete intended body and reply/claim identity before sending. Posting requires current credentials, write access and a live parent. Body is nonempty UTF-8 without NUL. The entire encoded message, including attribution, must fit 64 KiB; otherwise `payload_too_large` is returned.

A confirmed receipt contains the assigned message and ID. With scoped credential admission enabled, a credential lacking `thread:read` receives only `projectId`, `taskId` and `messageId`; retain that ID as the confirmed receipt. Reading requires `thread:read` and posting requires `thread:post`. Posting changes no Task status, version, timestamps, properties or dependencies, and triggers no Agent or execution. Discussion of a future upload establishes neither file presence nor consumption.

## Recover uncertain posts

A lost response or `message_outcome_unknown` does not permit automatic resend. Read normal pages before another explicit posting decision: equal text cannot establish the previous post's success, and another post creates another message. `candidateMessageId` in an error is diagnostic, not a receipt.

A validated `clock_not_advanced` rejection establishes that this post failed. Interpret other failures through their actual completion facts under [Write safety](daynight://manuals/write-safety.md). Retain a confirmed message ID through later output/cleanup failures and continue reading from the consumed position, not that receipt.
