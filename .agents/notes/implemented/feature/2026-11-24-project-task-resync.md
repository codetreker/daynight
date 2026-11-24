# Agent Note: Project Task Resynchronization

Status: implemented

## Problem

A user needs to rebuild one project's browser task baseline from the service,
including an empty result and resources absent from an old local set. Ordinary
incremental reads merge facts into the existing baseline and cannot by themselves
establish that the local set is complete. A failed or superseded read must not
discard still-authorized work or affect another project or account.

## Decision

Project Management offers a task resynchronization action under the existing
project and task read permissions. The settings card owns progress, result and
retry feedback; the shared task-sync executor obtains a local ticket and issues
one request without `epoch` or `since`. The complete snapshot replaces the
authorized project baseline. Same-history replacement retains the generation and
known removals, records missing known summaries, and publishes a rebuild witness
even when the difference is empty. A qualifying new-history snapshot is installed
atomically before old history is retired. A stale ticket, a history becoming
uncertain during a request, or a failure ends the attempt without an automatic
second full request. A manual retry begun after uncertainty captures that history
revision and confirms it with one new snapshot in the commit transaction. An
access denial racing a committed replacement cleans only its exact successor,
leaving a subsequently advanced baseline intact.

Attachment reads retain valid requests through an ordinary initial snapshot.
An invalidated read either restarts on a manual rebuild hint or presents a
retryable error when the hint is absent. A confirmed attachment write whose
original history cannot yet be established retains its owner and blocks another
dispatch until a read-only observation resolves it; a different history or lost
access retires the old view.

Confirming the same epoch after an uncertain observation keeps the original
ownership of dispatched operations while retiring their old read qualifications.
An open direct Task retained by a same-history rebuild keeps its reading subtree
while its detail is revalidated; deletion, access loss and real history changes
still withdraw the affected content.
An initial direct GET without a receipt keeps its request when a rebuild retains
the target; its response still requires the original fence and at most one
automatic reread if that fence has expired. An absent target is rechecked.

The [atomic cache decision](../architecture/2026-11-24-task-sync-atomic-deletions.md)
owns durable ordering and the [read-admission decision](../architecture/2026-11-24-task-removal-read-admission.md)
owns independent readers. The [sync design](../../../../docs/design/daynight-task-sync.md)
owns the current mechanisms and the [requirements](../../../../docs/spec/daynight-task-sync.md)
own the user-visible contract. The [deletion activation decision](../architecture/2026-11-24-activate-task-deletion-deltas.md)
keeps ordinary deletions in the same project history.

## Alternatives

**Use an unbounded same-epoch delta.** That path merges results and cannot prove
that a previously cached summary absent from the response must be removed.

**Clear the old baseline before fetching or observing a new history.** A network,
storage or concurrency failure would discard an otherwise usable authorized
baseline and a new epoch would require another request to restore it.

## Consequences

The full response and graph validation cost scale with the project, so the action
is explicit rather than part of ordinary polling. Other tabs and independent
readers recheck committed evidence; a broadcast is only a hint and does not grant
access. Conflicts require a user retry, while normal synchronization continues
with the committed epoch and coverage. The operation does not change server data.
