# Session messages

Read [write safety](write-safety.md) before sending. Establish the exact Project,
Task, Session and execution identity with [Session reads](session-reads.md) when
needed; observing eligibility does not authorize input.

## Send an authorized ordinary message

Ordinary messages are available for Web Sessions. Herdr remains a terminal
recording and does not accept messages through this command. Idle allows a new
message when authorized; working permits steer only when the actual Provider
supports it and the original turn still matches. Waiting input can be an
approval and must not be answered through ordinary text as a substitute.

Choose exactly one input source:

```bash
daynight task session send TASK SESSION --project PROJECT --text 'Please check the failing test.' --json
daynight task session send TASK SESSION --project PROJECT --file ./message.txt --wait-seconds 0 --json
daynight task session send TASK SESSION --project PROJECT --stdin --json < ./message.txt
```

Files must be regular files. Text preserves Unicode, BOM, line endings and
trailing newlines; it is not trimmed or executed. NUL, malformed Unicode,
whitespace-only input, more than 1 MiB of UTF-8 text or more than 2 MiB of encoded
command is rejected before recording or submitting. Slash-prefixed text stays
ordinary text, not a management command. The command does not cancel a turn,
queue a future send, create a Session or answer an approval.

The default wait is 30 seconds; `--wait-seconds` accepts 0 through 60. Waiting
only queries the original operation, not completion of the Agent's requested
work. Keep the emitted operationId and original target even if the command times
out, is interrupted or cannot finish output.

The CLI normally generates a new operationId. Use `--operation-id NEW_UUID` only
when deliberately choosing the identity of a first submission. With no local
record, the command first checks that original ID. An existing receipt cannot
prove that this new body was accepted, so it only returns the original identity
and directs a query. A missing receipt alone does not establish that an earlier
request was never sent. Do not use this first-submission entry for a previously
unknown result or cross-machine recovery.

## Recover the original operation

```bash
daynight task session operation TASK SESSION OPERATION --project PROJECT --json
daynight task session operation --operation-id OPERATION --json
```

The second form uses the current account and service's local recovery record.
Another machine must use the explicit original project, Task, Session and
operation IDs. A new claim does not redirect a historical receipt query.
Permission is checked again; losing access is not a reason to bypass the service
or read another account's records.

Before a first POST, the CLI durably saves a private record without text or
credentials and marks dispatch_unknown. Any retained record, including prepared,
makes a repeated send verify the original target and body hash and then **only
query**. A mismatch fails. It never refreshes current to reconstruct the old turn.
If the process stopped after recording but before POST, the conservative result
can remain unknown even though nothing was sent.

Follow [uncertain results](write-safety.md#uncertain-results): timeout, disconnect,
interruption and not_found never authorize an automatic replacement ID or
resubmission. Local save or output failure does not undo a server receipt. Keep
the original identity and query it; do not delete recovery evidence to make the
same operation send again.

## Interpret results

| State or condition | Meaning | Exit code |
| --- | --- | --- |
| accepted, offered, dispatching | Service operation is pending; not Provider confirmation | 3 |
| provider_accepted | Provider accepted input; requested work is not thereby complete | 0 |
| confirmed | Original input operation is confirmed; requested work can still continue | 0 |
| rejected, failed, expired | Definite original operation failure | 1 |
| unknown, not_found, wait expiry | Original outcome remains unresolved; query original ID | 3 |
| Protocol, authentication or output failure | The command could not complete its contract; retain any known original ID | 1 |
| Invalid arguments | Correct the invocation before a first submission | 2 |
| User interruption | Original identity is printed when available; query it | 130 |

JSON goes to stdout and diagnostics to stderr. Text output escapes terminal
control characters. Use the actual receipt state, not the presence of output or
HTTP 202, to assess native acceptance. Reobserve Task and Session activity when
the authorized work calls for checking progress; acceptance is not Task completion.

## MCP equivalents

Use task_session_send for a first ordinary send and task_session_operation for
the original result. Send requires caller-owned operationId, projectId, taskId,
sessionId, claimId, executionGeneration, expectedTurnId and text. expectedTurnId
must be present, including null for idle. The caller must hold these identities
before submission; the MCP transport request ID is not the operationId. The
execution fence excludes the inspection connectionEpoch observation.

MCP has no local file/stdin input. It uses the same Submit intent and owner
checks as HTTP. A repeated identical intent returns the original receipt;
unknown results must be queried, never automatically submitted again. Keep
WriteOutcome and Phase as service-write facts, data.operation.state as native
operation facts, and refs as the original resource identity. In particular,
WriteOutcome=confirmed with state=accepted does not prove Provider acceptance.
The operation tool's not_found error retains refs and means the original send
outcome is unknown, not that retry is safe. PAT/OAuth retain their real scope,
expiry and revocation constraints; the service reauthorizes the original actor
before dispatch.
