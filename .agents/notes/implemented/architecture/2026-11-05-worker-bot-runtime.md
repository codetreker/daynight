# Agent Note: Worker Bot Execution Evidence and Shared Controller Processes

Status: implemented

## Problem

An independent assistant must launch without a task worktree, retain its native
writer after uncertain process or HTTP results, and keep relay credentials valid
while task discovery sleeps. Reusing task execution records would couple this
lifetime to claim capacity, cleanup prompts and mandatory archives. A spawn
receipt alone cannot establish that the assistant is available to its user.
A restart must also distinguish a deliberate healthy shutdown from a failed
writer: counting both as failures exhausts recovery during routine restarts,
while resetting the counter erases evidence of repeated abnormal failures.
Deletion must retain proof of the original writer's stop even after its journal
is removed. A failed file deletion or lost completion response must not reopen
execution, lose responsibility or authorize removal of a replacement file.

## Decision

Bot launch uses the existing independent Session and Controller contracts with
no initial user input. Frozen registration and role intent retain their
existing inventory ownership; the
[inventory decision](../../archived/architecture/2026-11-04-worker-bot-inventory.md)
records the original separation. A separate execution
table introduced in Worker format 9 stores monotonic submission evidence, process
identity, observations and alias ownership. Format 10 retains recovery provenance,
predecessor stop proof and private paths across generations, and separates the
current Controller instance from the immutable registration. Format 11 protects
deletion progress and the original stop receipt stored in the inventory JSON.
Older Workers reject the newer format instead of silently dropping evidence
needed to prevent a second writer or reconcile a completed local deletion.

Task and Bot share only actual spawn, authenticated observation, per-execution
serialization, grant-maintenance and shutdown-error aggregation mechanisms. Task lifecycle responsibilities
remain in its backend. Bot readiness requires the matching local initialization
and remote synchronized Session, including its native identity.

Discovery and credential maintenance run independently. Per-Bot jobs do not hold
the discovery loop while starting a native provider or removing private sources.
The runtime requires a deletion manager and dispatches authoritative deletion
observations through it, retaining failures for the next reconciliation. The
[runtime design](../../../../docs/design/worker-bot-runtime.md) owns the interfaces,
persistence and cancellation rules.

Shutdown joins in-flight management before attempting every original writer's
stop. It retains the Session and journal instead of calling StopTest or requiring
an archive. Process-tree verification and journal stop evidence precede an atomic
transition of the Bot intent and execution row. The next generation retains the
same native Session, role, configuration and operation journal; an unreachable
Controller alone never authorizes replacement.

Windows Job termination is asynchronous, so an empty member list does not prove
that every retained original process has exited. The stop owner retains the
original guardian Job handle before IPC, seals admissions, verifies the final
native process identities and commits the matching journal receipt before
releasing it. The original deadline limits starting another complete confirmation
round; an already started native probe must finish. Unknown queries, missing
original ownership and exhausted budgets retain the execution evidence. The
[Controller Job ownership decision](../bug-fix/2026-11-11-windows-controller-job-ownership.md)
records the exact handle and receipt boundary.

Deletion runs under the same per-Bot serializer as launch and grant renewal.
The persistent deletion observation blocks new execution actions, while process
birth and current-generation observations from an already submitted child remain
recordable. Otherwise a deletion arriving between spawn and its acknowledgement
could hide the evidence needed to stop that child.

After exact process-tree stop, Worker SQLite retains the stop receipt and the
restricted private-resource plan outside the sources being removed. Each
completed target is recorded so a retry does not revisit a path that may now
belong to another instance. Local cleanup removes the Bot's execution sources,
retained tickets and their exact launch-scoped temporary files, IPC endpoints and
registered aliases, then reduces local records to
deletion responsibility without conversation content. The
[server deletion decision](../../archived/architecture/2026-11-04-bot-history-deletion.md) records the rationale for admission and
receipt identity; the Worker submits its exact persisted receipt only after
observing the original remote deletion state.

A fresh healthy observation records orderly shutdown provenance before stopping.
Only that provenance exempts a subsequent error-free stopped generation from an
abnormal recovery increment. Existing counts and blocked reasons survive shutdown
and restart. Recovery-grant response loss is reconciled against the persisted
target fence, not by allocating another generation.

## Alternatives

**Reuse Task backend records.** This would require artificial claim/worktree
identity and import Task completion behavior into a long-lived independent
Session. Dedicated records retain the shared Controller without those policies.

**Treat a failed spawn response as permission to retry.** The child can already
exist after the response is lost. Persisting unknown before spawn and observing
only the original ticket avoids a duplicate native writer at the cost of
retaining unavailable executions until lifecycle recovery can prove termination.

**Renew grants from task polling.** A long task interval or slow startup would
delay authorization for unrelated assistants. An independent maintenance loop
preserves the existing credential threshold without changing task polling.

**Stop first, then clean outside execution serialization.** An in-flight launch
or credential write could recreate private data after removal. A shared
per-Bot serializer keeps stop, durable responsibility and cleanup ordered while
allowing unrelated Bots to progress.

**Keep the only deletion receipt in the execution journal.** Removing private
conversation sources would also remove the proof needed to retry after a lost
response. Worker SQLite retains the minimal responsibility and the original
completion identity independently of the files it authorizes removing.

**Add optional cleanup JSON without a format admission change.** Older inventory
writers rebuild the record and discard unknown fields. Although their deletion
marker prevents startup, they could erase the only receipt after journal removal.
Format 11 rejects those writers without adding a separate table.

## Consequences

A spawned recovery child can precede its shared journal generation transition.
Shutdown uses only current-fence snapshots but still attempts to stop the child
from its persisted process birth proof. An unavailable current-generation stop
record remains a reported failure after that attempt.

Ordinary cwd and independent input semantics are preserved. Exact registration
and role fingerprints survive response loss and upgrades. Additional local state
is intentional: lost process outcomes retain private sources and alias ownership.

Recovery and orderly shutdown consume the original process proof and journal;
unknown stop outcomes remain unavailable with their evidence intact. Retained
launch and alias paths permit exact deletion without touching the ordinary cwd,
shared native home, Tasks or worktrees. Deletion needs no cleanup prompt or
archive upload. A partially removed private source remains retryable from its
SQLite responsibility; it cannot be advertised as completed while local removal
or the remote completion observation is unresolved.

A registration intent can survive without confirmation of its Session binding,
and a recovery target can be durable before its grant outcome is known. When
local evidence cannot identify that binding or the server's current generation,
deletion retains the sources and reports the ambiguity instead of fabricating
a never-started proof. Formal ticket ownership and protected cwd/native-home
paths are checked before capturing a removal plan.

Preflight resources created before durable intent remain discoverable only
through cleanup handles retained by the current process. Orphan preflight alias
directories from a prior Worker crash have no durable Bot attribution and are
not guaranteed to be discovered; deleting the shared alias root would exceed
this ownership boundary.

The [assistant composition](2026-11-05-assistant-composition.md) connects formal
runWorker scheduling, product entry and assistantHost advertising. These remain
integration responsibilities rather than execution-layer side effects. Provider-owned history and user
exports have no physical-erasure guarantee.
Controlled tests establish the execution mechanics, not complete live Provider,
browser, or production acceptance.
