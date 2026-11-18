# Session messages and original-operation recovery

Read [Overview](daynight://manuals/overview.md) first.

Read [Write safety](daynight://manuals/write-safety.md) before sending. Use
[Session selection](daynight://manuals/session-reads.md) when target or execution
identity is unknown. An observation or attention hint grants no intervention
authority.

## Freeze one target and intent

`task_session_send` sends ordinary text to an explicit Task Web Session. The
caller must be its actual current owner; Project membership and Task assignment
do not establish Session ownership. Credentials, scope, validity, revocation,
Project/Task access, execution, connection and turn must permit submission and
dispatch. A retained Session ID cannot bypass hidden Task/deleted Project access.

Before submission retain Project/Task/Session IDs, a new caller-owned UUID
`operationId`, `claimId`, `executionGeneration`, `expectedTurnId` and exact text.
The execution fence is Session ID, claim ID and execution generation.
`connectionEpoch` observes a connection; it is neither an accepted send input
nor an extra command precondition. Reconnection preserves execution identity
while the current connection must still pass admission.

Idle requires explicit `expectedTurnId: null`; working requires the actual
current turn and real steer support. A changed execution/turn refuses the frozen
intent. Do not refresh current and redirect that intent to another execution.

Text is supplied directly, preserving Unicode and line endings. NUL, malformed
Unicode, whitespace-only text, more than 1 MiB UTF-8 text or more than 2 MiB
encoded command are rejected. Slash text remains ordinary text. Sending cannot
answer approvals, cancel a turn, queue input for later, create/resume Sessions
or write Herdr keys. It accepts no local-file, stdin or CLI-waiting inputs.

OAuth admission covers Task ordinary messages and receipts only, granting no
Controller, Test/Bot, upload or other command permission. Pending dispatch
reauthorizes the original Actor; revocation blocks dispatch without erasing
earlier dispatch facts.

## Separate service completion from native state

Successful `structuredContent.data.operation` is the original receipt.
`structuredContent.meta.writeOutcome: confirmed` with `meta.phase: commit`
establishes the service write, not Provider acceptance. Preserve `meta.refs`
with all four Project/Task/Session/operation IDs. Failures report completion in
`structuredContent.error.writeOutcome`, using Write safety's shared classes.
Output failure cannot undo the commit.

| `data.operation.state` | Native fact |
| --- | --- |
| `accepted`, `offered`, `dispatching` | Pending; service acceptance does not establish Provider acceptance. |
| `provider_accepted`, `confirmed` | Distinct native acceptance/confirmation facts; neither proves requested work finished. |
| `rejected`, `failed`, `expired` | Refusal, failure or expiration; preserve the reason. |
| `unknown` | Native outcome remains unconfirmed. |

Tool failure, service completion and native state are independent. Retain original
identities through timeout, cancellation or lost output; confirmed service
completion can coexist with pending/unknown native state.

## Recover through the original operation

Use a new operation UUID only for a first submission. The service binds it to an
intent hash of original execution, operation ID, ordinary-message kind, exact
text and expected turn. An identical retained intent can return the original
receipt without redispatch while admission remains valid; changed intent
conflicts. Transport IDs and `requestId` are not operation identity.

After any unknown send result, call `task_session_operation` with the original
Project/Task/Session/operation IDs, without resending. It checks current
credentials and visible Project/Task access, returning persisted `operation`
and `currentBinding`. It can read the original Session after a claim change;
`currentBinding: false` does not substitute a newer Session.

Recovery neither restores a command body, recreates a queue, mutates the
operation nor produces a write-commit result. Success metadata contains
correlation/refs, without send's `meta.writeOutcome` or `meta.phase`.

`not_found` means no receipt was available for that query; the original outcome
remains unknown. Retain the IDs and query again when appropriate. Never retry
send, choose a replacement operation ID, guess the old turn by refreshing
current, or infer resend permission from `not_found`. Authentication, permission
and transport failures are distinct from receipt absence.
