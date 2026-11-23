# Bot deletion recovery

Use these commands for account-owned Bots on the configured service. No Project
or Git repository is required. Writes also require [write safety](write-safety.md).
Keep the original Bot ID, deletion ID, exact version and decision operation ID.
This procedure compensates for an existing Bot deletion failure. It is not a
general recovery procedure for ordinary Worker operation, Task execution or a
running Bot. The website reads a known deletion and shows CLI instructions; it
does not submit recovery decisions or discover account-wide deletion history.

```bash
daynight bot deletion inspect <bot-id> --json
daynight bot deletion inspect <bot-id> --server-only --json
daynight bot deletion recover <bot-id> --deletion-id <deletion-id> --json
daynight bot deletion resolve <bot-id> --if-version <version> --deletion-id <deletion-id> --operation-id <uuid> --accept-local-unverified --reason 'Original execution records are unavailable' --json
daynight bot deletion retry-cleanup <bot-id> --if-version <version> --deletion-id <deletion-id> --operation-id <uuid> --json
```

Start with `inspect`: it reads the service's recovery resource and inspects retained local
evidence under the original `DN_CONFIG_DIR`. It does not stop a process, delete
a file or submit a decision. `--server-only` reads the same authoritative decision
from any machine without opening local Worker storage. The result includes the
original binding, both cleanup phases and any saved decision. Missing or
unreadable records do not establish that native execution stopped.

When inspection finds usable original evidence, use `recover` on the hosting
Worker's machine after the Worker is stopped. Read
`hostingWorkerId`; a migrated Bot can retain a different original `workerId`. It
requires the original Worker lock, service, account and execution identity. It
uses retained evidence to stop the original execution, clean owned private
resources and report through the ordinary stop-proof protocol. A locked or
unreadable store is a failure, not permission to remove it. Keep the original
records when stopping or cleanup remains unconfirmed.

If the Bot execution row is missing but its original intent, ticket and journal
still validate, explicit `recover` can stop that original generation and retain
the real stop proof in its journal. Historical private cleanup evidence remains
missing, so the command still fails with `reason: evidence_missing` and a hint
that the original generation stopped but deletion is incomplete. It does not
recreate an execution row, prepare partial cleanup, remove the ticket or journal,
or report completed cleanup. Preserve those records and inspect the remaining
responsibility before considering `resolve`; repeated recovery retains the
original stop time. This compensation is not performed by automatic retries.

When the service reports `execution_evidence_missing` and the original evidence
cannot be restored, the Bot owner may explicitly accept unverified local cleanup
with `resolve`. Supply a stable nonzero operation UUID, the version just read,
the original deletion ID, a reason and `--accept-local-unverified`. This records
who accepted the limitation and when, and invokes the service's actual cleanup.
It does not manufacture a successful Worker receipt. Server completion leaves
local execution and files **unverified**; it does not prove a native process
stopped, remove ordinary working directories or Provider history, or revoke a
shared personal access token.

Unknown submission results must be read with `inspect --server-only`. Compare
the saved decision's operation ID, original request version and reason. Retain
that operation ID; do not generate another ID or automatically repeat a write
after timeout, cancellation or malformed output. A matching saved decision
establishes its acceptance, while `serverCleanup` establishes the actual cleanup
result. A failed read proves neither absence nor rollback.

`retry-cleanup` is for incomplete server cleanup after a decision was saved; it
does not retry local execution recovery or replace the decision. Reread its current version
and explicitly use `retry-cleanup` with the **same** operation ID. A retry claims
that exact version before cleaning; conflicts require another inspection and
decision. Repeating `resolve` does not retry physical cleanup. Confirmed receipts
remain confirmed if subsequent output or local cleanup fails.

Recovery requires a service supporting the separate deletion-recovery resource.
An HTTP 404, including a plain-text response from an older service, can mean that
the route is unsupported or that the requested resource is unavailable. Check
the configured service and Bot ID, and upgrade the service to a version supporting
deletion recovery before inspecting again. This failure does not confirm Bot
cleanup. Ordinary Bot responses retain their existing cleanup states; upgraded clients use the recovery
resource to distinguish a closed server deletion from verified local cleanup.
