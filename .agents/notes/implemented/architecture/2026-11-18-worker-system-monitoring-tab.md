# Agent Note: Worker System Monitoring Tab

Status: implemented

## Problem

Worker detail combines task and scheduler observations with hardware and software
telemetry. The long combined surface makes each kind of information harder to
find. Separating them must preserve the identity, freshness and failure semantics
of their existing independent reads and the editing drafts on the same page.

## Decision

Worker detail presents Runtime monitoring, System monitoring, Configuration and
Prompts as peer tabs. Runtime monitoring retains task, scheduler, capacity,
activity, failure and recovery observations. System monitoring presents host
resources, environment and software, including actual tool paths and the shortcut
to their configuration. Both monitor tabs share the existing Worker snapshot and
clock; the system refresh reads only that snapshot. Monitoring errors remain on
the runtime tab. The system surface retains its own loading, unavailable, offline
and snapshot refresh failure states.

The account- and Worker-bound history selection includes the system tab without
changing the URL or payload version. Hidden panels are not interactive; runtime
reading anchors do not move the page while their panel is hidden. Neither monitor
tab starts the editing coordinator, and already opened editors and their drafts
remain retained. The [Web requirements](../../../../docs/spec/daynight-web.md#我的-worker)
and [design](../../../../docs/design/daynight-web.md#我的-worker-列表与详情)
own the detailed behavior and presentation.

This extends the [prompt tab decision](2026-11-12-worker-detail-prompt-tab.md),
the [account history decision](../feature/2026-11-11-account-reading-history.md),
and the [Web monitoring decision](2026-11-09-web-worker-monitoring.md), while
preserving their original editing, history and independent observation rationale.

## Alternatives

**Keep host telemetry at the end of Runtime monitoring.** This preserves the
single long surface but leaves machine information mixed with the task and
scheduler information operators also need to scan.

**Load a separate snapshot for the new tab.** The same telemetry already belongs
to the page's Worker snapshot; a second read could disagree about freshness and
would add requests without providing a different resource.

## Consequences

Operators can inspect system telemetry without traversing runtime activity, while
both tabs retain the same online and 72-hour admission decisions. The page must
keep tab-specific refresh and errors distinct even though the machine snapshot is
shared. Tool-path navigation still relies on the existing asynchronous,
identity-bound configuration request, and the API and Worker reporting lifecycle
remain unchanged.
