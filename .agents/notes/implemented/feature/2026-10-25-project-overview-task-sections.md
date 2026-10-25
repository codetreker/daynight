# Agent Note: Project Overview and Task Sections

Status: implemented

## Problem

Project statistics and task browsing serve different reading actions but occupy
the same page. Separating them must not lose the current graph inspection,
viewport, expanded chain or detail operation. The existing task-category page
positions must also remain independent of scrolling through project statistics.

## Decision

Each project opens Overview, which presents its six statistics. Task list holds
the existing Standalone tasks and Task chains categories. Desktop section tabs
are vertical beside the selected content; narrow layouts use horizontal tabs
with matching keyboard direction. The outer choice is local to the current
project mount, has no URL or storage record, and starts at Overview after reload
or returning to a project. Empty projects retain both section destinations.

`ProjectView` remains the single owner of the project snapshot, synchronization,
preferences, detail selection and project session subscription. Both sections
derive their content from the same snapshot. Overview needs current statistics,
so the existing visible-page synchronization continues in either section. The
detail dialog is outside both section panels and retains its existing lifetime.

Task list mounts on first use and then stays mounted behind `hidden` and `inert`
while Overview is visible. This preserves the same graph, inspection and
viewport across outer section switches. The
[inner category decision](2026-10-22-project-task-views.md) still owns its original
conditional content mounting: switching between Standalone tasks and Task chains
can recreate the canvas while retaining the stored chain witness and category
page position. Outer retention does not change that existing inner contract.

The [browsing preference records](2026-10-21-task-browsing-preferences.md) keep
their exact shapes and project scope. Task page scroll ownership is active only
when Task list is selected and a snapshot is available. Leaving Tasks saves the
current category position and releases its scroll/pagehide listeners during the
layout boundary; returning restores after the panel becomes visible. Overview
uses a separate in-memory position, initially zero. Its scrolling and the first
snapshot arrival never read or overwrite the task offsets. A connected element
inside hidden Tasks is not a valid detail-close focus target; restoration uses
an available control in the visible section or the project heading.

The [Web specification](../../../../docs/spec/daynight-web.md) owns required
behavior, and the [Web design](../../../../docs/design/daynight-web.md) owns the
current composition. The production-component browsing fixture is the current
layout reference; the original static task-category preview retains its earlier
visual baseline and state examples.

## Alternatives

**Unmount Task list on every outer switch.** This releases hidden work but loses
graph inspection, pan and zoom, and couples layout navigation to task and detail
lifetimes. Retaining the visited subtree separates those concerns.

**Mount hidden Tasks from the initial Overview render.** This performs task
rendering before it is requested and introduces hidden-canvas initialization.
First-use mounting avoids that work while the graph's existing positive-size
initialization remains authoritative.

**Separate routes or a persisted outer selection.** These give the sections
independent navigation identity but change the chosen default and require a new
route or stored format. Local section state keeps the project URL and existing
task preferences unchanged.

## Consequences

Statistics and task browsing have clear destinations with one data owner. Outer
switches do not add requests, caches, index construction or timers. A retained
hidden task subtree keeps its existing task-clock subscriptions; that is the
deliberate runtime cost of preserving interaction state. Authentication changes and project unmount retain their existing owner cleanup.
Snapshot invalidation clears private task children rather than retaining stale
content in the hidden panel.

Browser verification must distinguish outer retention from inner category
remounting, and prove scroll isolation with real document geometry. Layout tests
also cover empty projects, recoverable refresh failure, long content, responsive
orientation and visible focus restoration. Existing production acceptance and
capacity scenarios retain their gates and measurement boundaries. Explicit
Task list entry remains part of cold start where measurement already begins
before project navigation; warm graph operation measurements remain unchanged.
