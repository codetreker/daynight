# Agent Note: TaskSync Session list admission

Status: implemented

## Problem

Task chain annotations and shortcuts require only a current reliable Session
classification, but a separate per-Task Current scheduler repeatedly reads full
content and duplicates the project's existing synchronization work. Moving the
classification into a project response introduces a different race: Task cache
merging can preserve a newer execution than the response actually observed.
Both a returned state and an omitted key can then affect the wrong execution.
Receipt time also loses its freshness meaning if decoding or storage waits
replace it with the publication time.

## Decision

The existing fifteen-second TaskSync is the only list Session read. Its required
complete four-state map feeds a page-local store owned by `useTaskGraph`, with
`ProjectPage`, `ProjectTaskWorkspace` and the summary Provider passing the same
instance to presentation consumers. The Provider owns presentation activity,
not another producer or scheduler. Existing annotations, pending shortcuts,
whole ordinary chain membership and warning/notice/working precedence remain.

The API returns local `TaskSyncRead {sync, receivedMonotonic}`. The successful
reader captures the monotonic receipt immediately after `response.text()` and
before JSON decoding, source scanning or validation. Error responses retain
their original decoder and error pipeline. Subsequent history and cache waits
reuse that receipt, and the store rejects observations older than thirty
seconds before publication. Local expiry and visibility restoration recheck
the same deadline; rendering and cache hints cannot renew it.

`TaskSyncTicket` retains a slim immutable execution-binding baseline from the
same existing transaction that reads the manifest and Task watermark. Snapshot
observations use only returned Tasks; delta observations overlay actual returned
Tasks on that baseline. The store compares this observation with the currently
accepted Task binding after the existing sync application and scope checks.
Returned values and omitted keys require the same eligible binding, including
Task status, claim, Worker, Worktree, Worker state and control mode. A Task's
unchanged ID cannot attach an old observation to a replacement claim. The page
captures the existing `authRequestsPauseRevision()` before HTTP and requires it
to remain unchanged after history and cache waits before Session replacement.
A pause retracts contributions; a later resume cannot make a pre-pause response
republish them. This gate applies only to Session publication and preserves
the existing Task application, graph publication and authentication shell.

Session state remains only in the page store. Other cache sources and tabs may
invalidate mismatched bindings through existing notifications, but never
publish or renew Session observations. Session-only changes do not write Task
properties, versions, timestamps or IndexedDB; do not enter BroadcastChannel or
ordinary Task notifications; and do not invalidate detail bodies or add graph
construction. The existing TaskSync application still performs its own normal
Task work once.

The [TaskSync design](../../../../docs/design/daynight-task-sync.md) owns request
and cache responsibilities; the [Session status design](../../../../docs/design/task-session-status.md)
owns binding admission, expiry and presentation. The [server projection decision](2026-11-08-task-sync-session-projection.md)
owns the narrow state producer. The [original annotation decision](../../archived/feature/2026-11-04-task-session-status.md)
established reliable shortcuts and complete chain membership when Current was
the available authoritative observation; those requirements survive the change
in list data source.

## Alternatives

**Keep full per-Task Current reads with a longer interval.** Frequency falls,
but unnecessary payloads, repeated authorization/transactions and an independent
scheduler remain proportional to Task count.

**Create a lightweight per-Task endpoint.** Smaller responses still require
per-Task requests and separate observation admission alongside TaskSync.

**Derive observation identity from the final merged cache.** A late C1 response
can be merged while the cache retains C2. Using the final C2 binding would grant
C1's value or omission authority over C2 and incorrectly renew its freshness.

**Publish Session maps from every cache producer or across tabs.** Multiple
producers need additional ordering, replay or revision rules. A single page
producer and existing Task invalidation preserve isolation without a Session
version protocol.

**Capture freshness after parsing or cache application.** CPU and IDB delays
would extend stale observations beyond their actual thirty-second window. A
local body receipt survives those delays without another server clock field.

## Consequences

List visibility, disclosure and filtering no longer generate full Current
requests. One complete bounded map shares the project's existing synchronization
period; ordinary polling waits retain unexpired states, while accepted failures
and auth/scope loss retract them. Reliable pending Sessions keep their shortcuts
without an annotation. Full Current content and control authorization remain
owned by the detail client.

Request binding reconstruction and scope admission remain necessary work even
though Session values are small. TaskSync still performs its existing graph
validation and cache transaction; this decision does not claim to remove that
cost. The fifteen-second observation period and thirty-second lifetime are the
chosen freshness bounds. Structural request reduction does not establish an
unmeasured production CPU or bandwidth saving.

The Web parser strictly requires the new Session map. Server support precedes
the Web consumer, and server rollback first requires rolling back that consumer.
No cache schema migration, missing-field fallback, incremental Session history
or cross-instance live-state infrastructure is introduced.
