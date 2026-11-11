# Session messages

Read [write safety](write-safety.md) before sending. Use
[Session reads](session-reads.md) to establish Project, Task, Session and execution
identity as needed; eligibility grants no input authority.

## Send an authorized ordinary message

Only Web Sessions accept ordinary messages; Herdr remains a terminal recording.

| State | Eligibility |
| --- | --- |
| Idle | New message when authorized. |
| Working | Steer only if the actual Provider supports it and the original turn still matches. |
| Waiting input | May be an approval; ordinary text cannot substitute for or answer approval. |

Choose exactly one source:

```bash
daynight task session send TASK SESSION --project PROJECT --text 'Please check the failing test.' --json
daynight task session send TASK SESSION --project PROJECT --file ./message.txt --wait-seconds 0 --json
daynight task session send TASK SESSION --project PROJECT --stdin --json < ./message.txt
```

Files must be regular. The CLI preserves Unicode, BOM, line endings and trailing
newlines without trimming or execution. Slash-prefixed text stays ordinary input,
never a management command. Before recording/submitting, it rejects NUL, malformed
Unicode, whitespace-only input, UTF-8 text >1 MiB or encoded commands >2 MiB.
Sending cannot cancel a turn, queue a future send or create a Session.

`--wait-seconds`: 0–60, default 30; queries the original operation, not completion
of requested Agent work. Retain emitted operationId and original target through
timeout, interruption or output failure.

The CLI normally generates a new operationId; `--operation-id NEW_UUID` selects a
first-submission ID. Without a local record, it first queries that ID. An existing
receipt makes the command return original identity/query guidance, without
confirming this body. Receipt absence does not prove nothing was sent. This
first-submission entry cannot recover unknown results or cross-machine operations.

## Recover the original operation

```bash
daynight task session operation TASK SESSION OPERATION --project PROJECT --json
daynight task session operation --operation-id OPERATION --json
```

The second form resolves the current account/service's local recovery record.
Cross-machine queries need explicit original Project/Task/Session/operation IDs;
new claims never redirect historical queries. Permission is rechecked: lost
access permits neither service bypass nor reading another account's records.

Before first POST, the CLI durably saves a private record without text/credentials
and marks dispatch_unknown. Any retained record, including prepared, makes repeated
send verify original target/body hash, then **only query**; mismatch fails.
Never refresh current to reconstruct the old turn. Stopping between record and
POST can leave unknown despite no submission.

[Uncertain results](write-safety.md#uncertain-results): timeout, disconnect,
interruption and not_found never permit automatic replacement IDs/resubmission.
Query the original identity; never erase recovery evidence to resend. Local
save/output failures cannot undo server receipts.

## Interpret results

| State or condition | Meaning | Exit |
| --- | --- | --- |
| accepted, offered, dispatching | Pending service operation; no Provider confirmation | 3 |
| provider_accepted | Provider accepted input; requested work need not be complete | 0 |
| confirmed | Original input operation confirmed; requested work may continue | 0 |
| rejected, failed, expired | Definite original operation failure | 1 |
| unknown, not_found, wait expiry | Unresolved; query original ID | 3 |
| Protocol, authentication or output failure | Command contract failed; retain any known original ID | 1 |
| Invalid arguments | Correct invocation before a first submission | 2 |
| User interruption | Original identity printed when available; query it | 130 |

JSON uses stdout, diagnostics stderr; readable text escapes terminal controls.
Assess native acceptance from receipt state; output/HTTP 202 is insufficient.
For authorized progress checks, reobserve Task and Session activity; acceptance
is not Task completion.

## MCP equivalents

`task_session_send` submits first ordinary input; `task_session_operation` queries
its original result. Before sending, hold `operationId` (caller-owned), `projectId`,
`taskId`, `sessionId`, `claimId`, `executionGeneration`, `expectedTurnId` and `text`.
Include `expectedTurnId`, null when idle. Transport request ID is not operationId;
the execution fence excludes inspection connectionEpoch.

MCP has no file/stdin input; HTTP Submit intent and owner checks apply. Identical
intent returns its original receipt; unknown results require queries, never
automatic resubmission. Keep `WriteOutcome`/`Phase` (service write),
`data.operation.state` (native operation) and `refs` (original resource identity)
separate. WriteOutcome=confirmed with state=accepted does not prove Provider
acceptance. Operation-tool not_found retains refs: unknown outcome, not safe
retry. PAT/OAuth scope/expiry/revocation still apply; the service reauthorizes
the original actor before dispatch.
