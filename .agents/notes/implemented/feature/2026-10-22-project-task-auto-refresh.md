# Agent Note: Automatic Project Task Refresh

Status: implemented

## Problem

Task status, readiness and dependency changes made through the service can leave
an open project page stale. Requiring a manual refresh interrupts monitoring.
Repeated reads also risk cancelling useful work, replacing a graph with a mixed
snapshot, moving keyboard focus or resetting a task's attachment form and
preview while it is being used.

## Decision

An open project synchronizes its task summaries every five seconds while the
document is visible. The [persistent summary-cache decision](../architecture/2026-10-24-persistent-task-summary-cache.md)
replaces the original complete-graph transport while preserving this scheduling
and the complete derived snapshot presented to components. Hiding the document pauses new periodic reads without
cancelling an active read. Returning to a visible document starts a read
immediately unless one is already active, and restarts the five-second interval.
Automatic ticks skip an active project sync. Manual refresh cancels the current
sync read and starts immediately. Navigation and unmount release the timer and
owned requests; resource identity and request generation continue to reject late
responses.

The [original dashboard design](../../archived/architecture/2026-10-20-task-dashboard-mvp-design.md)
adopted manual refresh to keep graph projection independent of request triggers
and mutations. This decision partially supersedes that trigger policy while
retaining the [dashboard's](../../archived/feature/2026-10-20-project-task-dashboard.md) complete-snapshot
ownership. Changed graph data replaces statistics, indexes and both task-category
lists together. Equivalent graph data reuses the graph and index, preserving
projection and layout references. Every successful read advances the receipt
revision and time, including equivalent responses. The
[detail-cache decision](../architecture/2026-10-24-task-view-timestamp-window.md)
uses summary business versions and project generations for content reads;
ordinary duplicate receipts do not reread unchanged details. Openings, failed
reads, raw graph disagreements and operation reconciliation retain live GETs.

Same-task detail reads serialize and coalesce pending refreshes into one
follow-up. Automatic detail starts and queued follow-ups wait while hidden;
in-flight reads may finish. Refresh and recoverable failure retain the successful
detail body;
background reads leave its tabs, focus, attachment selection, file/path inputs,
pending writes and preview frame mounted. Ordinary reads add no heading
progress paragraph; unchanged responses keep the heading, tabs and active panel
bounds stable even while the request is pending. The
[quiet-detail decision](../bug-fix/2026-10-23-quiet-task-detail-refresh.md)
owns this presentation and its in-flight geometry checks. Equivalent ordered PR values retain
their array reference and local page; a changed collection uses the existing
page-reset behavior. Task and project changes immediately isolate the new
resource and release old task state.

Recoverable failures retain old data, its successful receipt time and a visible
error. Automatic attempts keep that error until success clears it, including
initial failures without retained data, so retries do not repeatedly announce
loading. In task details, the
[notification layer](../bug-fix/2026-10-24-task-detail-notifications.md) owns
timed error presentation and keeps recovery reachable after expiry; the stored
error remains unchanged. A principal-verified same-user project not_found response
clears its snapshot and persistent base; missing or malformed identity headers
remain protocol failures. Unavailable detail reads clear their own content.
A 401 follows the authentication owner's session-loss lifecycle and
releases user-owned content. Project listing and attachment metadata/content
retain their existing independent refresh and mutation rules.

The [requirements](../../../../docs/spec/daynight-web.md) own observable behavior;
the [design](../../../../docs/design/daynight-web.md#请求刷新与故障) owns request and
component responsibilities. Hook and component validation cover scheduling,
visibility, request priority, late responses, recovery and retained state. The
existing production `refresh-staleness` journey covers task changes from the
real service without manual refresh, retaining the native/container inventory
and its existing performance and cleanup gates.

Attachment and language isolation checks control the browser clock when counting
requests attributable to an action. Capacity checks keep native browser timers
and performance clocks: test-side instrumentation labels each project-sync request as
an initial read or a five-second callback read, proving collapse/reopen adds no
read while periodic requests remain observable. This avoids replacing a causal
guarantee with an absolute request count over a timed workflow. Scroll recovery
samples actual `scrollTop` until it is stable for 100ms, using a test-process
monotonic clock and a 3,000ms bound so controlled browser timers cannot stall it.

## Alternatives

**Keep only manual refresh.** It retains the original read trigger and avoids
periodic network reads, but an unattended project page remains stale until an
explicit action. It does not meet automatic task-status monitoring.

**Use SSE or WebSocket notifications.** Push could reduce unchanged reads and
propagate changes sooner, but requires a server notification transport and
connection lifecycle beyond task-page refresh. It remains an additive capability:
a future notification can trigger the same project synchronization. Keeping graph
projection, detail ownership and resource isolation independent of the trigger
preserves that extension without replacing their consistency rules.

## Consequences

Open project pages observe task changes without navigation or manual input.
Reads are bounded to visible project pages, serialized and scoped to current
resources; a slow read can make a successful refresh arrive later than one
five-second interval. Hidden pages may apply an already active read and obtain
fresh data again on return. Automatic cycles update successful receipt time
without repeatedly showing the manual-refresh busy state.

Polling can repeatedly transfer the final timestamp-overlap window. Reference
reuse avoids unnecessary layout work; duplicate summaries also avoid persistent
writes, broadcast and unchanged-detail GETs. Intrinsic detail reuse and its live
admission policy belong to the
[detail-cache decision](../architecture/2026-10-24-task-view-timestamp-window.md). Push transport should be reconsidered if this load
or the five-second visibility delay becomes material. A live detail and project sync
remain independent reads; stale-data detection still offers a full graph refresh.
The [approval lifecycle](2026-10-22-task-approval-lifecycle.md) separately supplies
versioned status setting and its shared task sessions. Task descriptors, current read
errors and explicit reconciliation determine whether a fresh read is required;
receipt-only optional polls do not invalidate an already observed CAS version or
block approval while their GET runs. loadedRevision remains the successful GET's
starting receipt. Known task/prerequisite disagreement still blocks approval,
including when derived blockers change without a task revision. Approval-triggered
refreshes retain other active task panels under the same rules. A 404 removes
private task content; an unresolved approval retains only operation/error feedback
and GET-only reconciliation controls. General task
editing, project-list polling, attachment polling and server push remain outside
this automatic-trigger decision's scope. Their separate owners and refresh actions remain visible
rather than being coupled to the graph timer.
