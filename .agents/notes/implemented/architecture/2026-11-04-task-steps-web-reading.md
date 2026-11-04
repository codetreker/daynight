# Agent Note: Task Steps reading in the shared detail session

Status: implemented

## Problem

Task records can contain large ordered Steps collections whose contents change
under the same version as ordinary task settings. A browser reader must keep
these records separate from cached task projections, preserve row identity and
exclude responses from retired authorization or older parent versions. Loading
all records into the DOM or retaining them after the reader leaves would make
the independent resource expensive even for people who never open it.

## Decision

The [Steps design](../../../../docs/design/daynight-task-steps.md#web-资源与单一写入所有者)
places a separate read state in the existing `TaskDetailSessions` entry.
`useTaskSteps` subscribes only while its tab is active. The owner compares real
summary, parent, confirmed-mutation and Steps versions, coalesces invalidations,
and admits results under the current identity and cache generation. Ahead results
wait for summary admission; skipped intermediate versions drive another read.
Validated pending parent versions participate in the floor. The highest verified
version remains a scalar lower bound through refresh, failed cache admission and
reader release; identity, cache-history replacement and retirement reset it.
Repeated reads below the same known floor fail explicitly instead of polling
forever. A waiting state keeps recovery available while parent synchronization
settles. A collection 404 checks the parent before access retirement.

Confirmed parent deletion cancels parent reads and fences admission before and
after asynchronous cache work. Late parent reads and submitted mutation receipts
cannot reopen the deleted presentation. Mutation receipts can still settle, and
the existing new-generation recovery policy remains available.

No Steps response enters the TaskDetail LRU or IndexedDB. The last active reader
releases the complete collection, pending admission and owned read controller.
Scope retirement synchronously clears these resources. The view retains
stable expanded IDs, a page number and its local draft while hidden.

The existing detail surface supplies the Steps panel to `TaskDetailReading`,
which owns one Task-root Markdown renderer and attachment controller. This keeps
ordinary reading independently composable and gives Steps the same link,
preview and keyboard ownership. Local pages mount at most 100 rows with global
numbering and numeric navigation; paging does not change the service resource.
Narrow layouts wrap the expanded tab set when height permits. At heights up to
500px, one horizontally scrollable row preserves reading space. The tab owner
reveals the target both on activation and after selection or locale layout;
native focus alone can leave a partly visible tab clipped when selected text
becomes wider. The tab scroller does not widen the page.
At heights up to 600px, the pagination controls scroll with the Steps list;
a sticky two-row control area can otherwise cover almost all of a short panel.

## Alternatives

**Store Steps with cached TaskDetail.** The independent resource can reach
64 MiB while existing details have much smaller limits. Persisting it would
couple ordinary task opening, eviction and cache migrations to optional reading.

**Let the panel own its requests.** This separates version invalidation from the
existing parent mutation receipts and authorization lifecycle. Reusing the
session owner keeps these guarantees in one place and preserves its sole write
gate for later Steps operations.

**Make TaskDetailReading require a detail session.** This unnecessarily couples
the generic Markdown/attachment composition to task loading. Supplying the panel
from the detail surface preserves the existing reading component's ownership.

**Wrap narrow tabs at every height.** Two tab rows keep all labels visible, but
at 320×240 they leave less than the existing minimum attachment reading space
beside claim metadata. A single scrollable row at short heights preserves both
tab reachability and the existing reading-height guarantees.

## Consequences

The original reader did not require a Session or enable write operations. The
[status write decision](2026-11-04-task-steps-web-status.md) and
[append form decision](2026-11-04-task-steps-web-add.md) extend the same
submission owner, Task-root renderer and stable row IDs.

Pagination bounds mounted rows, not resource decoding or memory while active.
Reopening the tab reads again after releasing the prior collection. API, session,
panel, routing and shared attachment tests protect these boundaries; real-service
browser evidence separately establishes production rendering and navigation.
