# Agent Note: Targeted Task Removal Read Admission

Status: implemented

## Problem

A project graph cannot identify every resource hidden by a deletion. Direct
readers, attachment workspaces, account inventory pages and cross-project Goal
relations can outlive that graph or publish a response started before the
delete. Retiring the whole project on each deletion interrupts unrelated
reading, while accepting delayed results can restore removed private content.
An unordered peer hint cannot prove either deletion or a new authorization.

## Decision

Separate a trusted resource hint from an authoritative cache commit. A current
opening or mutation ticket binds a successful DELETE or `410 task_deleted` to
its original identity, project, target and observed history. `reportTaskDeleted`
immediately withdraws the confirmed target and advances local admission for
potentially affected readers. Immutable ordinary Task ancestry can prove
unrelated resources; mutable Goal membership cannot. Pending readers need a
fresh observation, and a shared background sync must start after the hint.
The hint does not write removal identities, advance coverage or retire project
history. The complete graph and business dependency state change together only
when an authoritative sync commits.

`TaskReadAdmission` owns transient resource revisions and active projection
interests. Direct read tickets capture these revisions and the durable
baseline; `verifyTaskRead` checks current shared removal and rebuild evidence
before publishing. Query consumers capture a projection ticket before fetching
and batch-qualify every returned project/id before publication, including
projects absent from the local graph. Search, My Tasks and Goal relation readers
register their actual project interests for peer hints without granting access.
Committed IDs withdraw only matching details, relations, attachments, Session
catalogues and list or graph contributions. Related pagination restarts while
valid filters, navigation and unrelated content remain.

Every complete snapshot, including the initial baseline, establishes a rebuild
revision and emits a baseline-rebuilt event after commit. Subsequent same-history
deltas retain that marker for peer notification. A separate manual rebuild
revision qualifies direct readers and peer projections across explicit rebuilds.
An ordinary initial snapshot retains independently authorized reads for resources
in its baseline and rechecks absent active resources. Same-history replacement
keeps removal identities; a real new history also applies the existing generation
and history fences. An active resource missing from an authorized complete
baseline loses its old qualification and must follow its existing GET or
pagination protocol to revalidate. An unknown
resource's absence is not a permanent removal; only the difference from the prior
authorized complete summary set creates durable removal identities. Real epoch
replacement and access or identity loss retain their existing stronger retirement
rules. An old-history DELETE or Gone response cannot withdraw resources in a
replacement history.

This supersedes deletion-driven project retirement in the
[ordinary-subtree lifecycle decision](2026-11-24-web-subtask-lifecycle-retirement.md)
while retaining its cancellation intent and real-history retirement rules.
The [atomic sync decision](2026-11-24-task-sync-atomic-deletions.md) owns durable
commit ordering. The [sync design](../../../../docs/design/daynight-task-sync.md)
and [deletion design](../../../../docs/design/daynight-task-deletion.md) own the
mechanisms and reading contracts. The [activation decision](2026-11-24-activate-task-deletion-deltas.md)
keeps ordinary deletion in the same project history; the Web admission mechanism
also handles genuinely observed replacement history.

## Alternatives

**Retire the whole project on a resource signal.** This avoids relying on cached
ancestry but resets valid graph and query presentation. A delayed receipt also
cannot establish which rows in a newer history are unsafe.

**Remove only the target and cached descendants.** A partial or outdated graph
misses direct readers and newly hidden descendants. A shared authoritative
removal set and candidate admission checks cover those readers.

**Trust peer messages or only an in-memory deletion set.** Unordered messages
have no authorization or commit proof. Independent readers and tabs must check
current shared durable records, including rebuilds and history changes.

## Consequences

Deletion keeps unrelated reading and same-history graph interaction stable.
Pending direct readers incur fresh reads, and retained deletion records are
checked before candidate publication. Batch qualification reduces repeated
project scans but still reads the relevant stored removal set. Optional peer
hints accelerate convergence; without them the normal periodic or visibility
reads and candidate publication checks remain responsible for convergence.
Transient hints cannot substitute for successful atomic sync, and a failed
recheck does not make stale detail or a prepared write eligible again.
