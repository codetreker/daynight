# Assistant tasks

Assistant tasks are user-owned collaboration resources, separate from Project
Tasks, Worker execution claims, Steps and Threads. They contain a manual,
appendices, revision proposals, items, records, inquiries and delivery events.
No Project argument or repository discovery is required. Read
[write safety](write-safety.md) before mutations; command help owns exact flags.

## Identity and reads

```bash
daynight assistant-task list --json
daynight assistant-task show <task-id> --json
daynight assistant-task manual show <task-id> --json
daynight assistant-task record list <task-id> --limit 200 --json
daynight assistant-task item list <task-id> --json
daynight assistant-task item show <task-id> <item-id> --json
```

All commands support `--json`. Lists return one page with `items`, `nextCursor`
and `observedAt`; follow `--cursor` explicitly. Versions and generations are exact
decimal strings. Retain the observed version for `--if-version` and the observed
claim generation for `--expected-generation`. Canonical lowercase nonzero UUIDs
identify tasks, Bots, resources and operations.

`DAYNIGHT_BOT_ID` supplies the collaborating Bot identity through
`X-Daynight-Bot-Id`; it does not replace the authenticated user. The service
validates Bot ownership and deletion. Without this environment variable,
terminals can read and perform user operations. Bot-only operations fail locally
before authentication or network access. Do not remove a Bot identity to approve
its own proposal or perform a user-only action.

## Claims and recovery

```bash
daynight assistant-task claim <task-id> --if-version <version> --expected-generation <generation> --operation-id <uuid> --json
daynight assistant-task transfer <task-id> --target-bot <bot-id> --if-version <version> --expected-generation <generation> --json
daynight assistant-task bind <task-id> --expected-generation <generation> --json
daynight assistant-task renew <task-id> --json
daynight assistant-task release <task-id> --expected-generation <generation> --json
daynight assistant-task claim-operation show <task-id> <operation-id> --json
```

Claims and credential-protected Bot writes require an absolute
`DAYNIGHT_BOT_STATE_DIR`. Asking, event acknowledgement and another Bot’s
intervention records only need Bot identity. The directory must
be private (0700 on POSIX); files are 0600. The CLI isolates saved state by service
origin, authenticated owner, Bot and task, uses a shared task lock, and persists
random credentials and complete request intent before dispatch. Tokens never
appear in ordinary or JSON output. Keep this state for later invocations and the
Worker host; loss of the file cannot be repaired by generating a new token for
the same live claim. User release/transfer use private state below the configured
Daynight state directory and require `--if-version`.

Claiming succeeds only when unowned or expired. A live `pending` or `active`
claim cannot be replaced. Transfer invalidates the old credential immediately
and assigns a pending target; it does not deliver a token to the target. That
Bot runs `bind`, then `renew` with its saved credential before application work.
Binding preserves generation and the original transfer deadline; renewal grants
five minutes and preserves the token. This command group does not run a renewal
loop; the Worker host owns continuous execution and its scheduling.

Claim writes retain the original operation ID. A lost response, invalid receipt
or transport failure is an unknown outcome, never proof of rollback. Query
`claim-operation show` with the original ID: this only reads the receipt and
reconciles private state, never repeats a write. A matching historical receipt
cannot revive an expired, transferred or released credential. A missing receipt
does not prove noncommit. Preserve pending state and do not create a replacement
operation while that original request could still grant a usable claim.

## Manuals, proposals and records

```bash
daynight assistant-task appendix add <task-id> --text "Observed behavior" --source-record <record-id> --json
daynight assistant-task propose <task-id> --base-version <manual-version> --body "Revised manual" --reason "Evidence" --evidence-record <record-id> --json
daynight assistant-task proposal list <task-id> --json
daynight assistant-task record add <task-id> --kind fact --text "Observed result" --json
daynight assistant-task ask <task-id> --question "What is the current finding?" --json
daynight assistant-task answer <task-id> <inquiry-id> --answer "Observed result" --json
```

The responsible Bot needs a current saved credential for protected writes.
Another Bot can ask a question or append an `action`/`note` intervention record;
other record kinds require the holder. Inquiries have a fixed five-minute
deadline. Read `inquiry list` and `record list` to distinguish an answer from a
timeout. Appendices cite records; proposals cite evidence and retain the base
manual version. Proposals do not change the effective manual until a user decides.

User terminals can create/update/pause/resume/delete tasks, edit/delete appendices,
decide proposals and roll back manuals. `proposal decide` uses `approved`,
`edited` or `rejected`; an edited decision can supply replacement body/rules.
Rollback appends a new version with the selected historical content. Pausing
stops application work while allowing claims and renewal. Deletion removes the
resource and its materials; it is separate from releasing a claim.

## Events and write outcomes

`events pull` reads a page globally or for one task. `events ack <task-id>
<event-id>` takes a Bot identity and operation ID to mark delivery or expiry.
Acknowledgement records delivery, not completion of the application work.
User-only `events clear-attention --target-bot <bot-id>` clears eligible attention
markers; pending proposals remain until a decision.

Every write accepts `--operation-id` (otherwise generated once). Claims and event
acknowledgements send it as the protocol operation identity. Creation and append
commands use it as the new resource ID. Version-based updates, decisions,
answers, deletions and attention clearing retain it only as a client diagnostic
identity: it does not add service idempotency. No mutation is automatically
retried. On uncertainty, retain the task/resource/operation IDs and inspect the
current task and corresponding lists before a new decision. Equal current values
alone cannot identify which request committed. A confirmed remote write remains
confirmed if local output or cleanup fails.
