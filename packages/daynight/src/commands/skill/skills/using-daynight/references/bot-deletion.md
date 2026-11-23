# Bot deletion recovery

Use this procedure for an existing Bot deletion failure on the configured
service. It does not require a Project or Git repository and does not repair
ordinary Worker operation, Task execution or a running Bot.

```bash
daynight bot show <bot-id> --json
daynight bot recover <bot-id> --deletion-id <deletion-id> --json
```

Read the original Bot first and retain its deletion ID. On the original
execution's machine, use the original `DN_CONFIG_DIR`, service and account, stop
the Worker, and explicitly run `bot recover`. The command takes the existing
Worker and Bot locks, checks the original deletion and local ownership, and
uses retained evidence to stop and clean the original execution. It does not
create a replacement execution. Locked or unreadable storage is a failure, not
permission to remove it.

When full stop proof and private cleanup are confirmed, the command reports
through the existing completion protocol. Both Worker and server cleanup must
be completed before deletion is complete. A timeout, lost response or output
failure does not prove rollback; read the same Bot with `bot show` before another
attempt. Preserve original records and confirmed receipts.

If the execution row is missing but the original intent, ticket and journal
still validate, explicit recovery can stop that generation and retain its real
stop proof in the original journal. Historical cleanup evidence remains missing,
so the command still fails with `reason: evidence_missing` and a hint that the
generation stopped but deletion is incomplete. It creates no execution row or
partial cleanup plan, retains the ticket and journal, and sends no completed
receipt. Repeated compensation preserves the original stop time.

The existing `execution_evidence_missing` failure stops the Worker's repeated
invalid completion attempts across restarts. Reads continue. Completely lost
evidence may leave deletion failed; there is no unverified settlement or promise
of server cleanup. Missing files, absent process names and user confirmation
cannot replace original execution proof. Ordinary working directories, shared
Provider history and shared personal access tokens remain outside this recovery.

The website only reads known Bot deletion status and gives these CLI instructions.
It neither runs local compensation nor submits another recovery protocol.
