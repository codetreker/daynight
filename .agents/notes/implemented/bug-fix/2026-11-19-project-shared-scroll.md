# Agent Note: Shared Project Page Scroll Position

Status: implemented

## Problem

Switching between sections of the same project can move the page away from the
position the reader was using, even when both sections are long enough to show
it. Per-section saved positions and native history restoration also replay old
coordinates on Back or Forward. A shorter section can legitimately reduce the
scrollable range, but restoring its predecessor's old position on return makes
that change unpredictable.

## Decision

The project page owns one nonnegative finite window offset per authenticated
account and project. Its separate browser key avoids inheriting old task-list
positions. Ordinary outer section and inner category switches keep the current
offset, subject to the browser's natural range limit; same-project history
traversal does not restore an entry's historical coordinate. Initial entry or
reload restores the saved offset at most once after the target content is usable,
unless navigation, user scrolling or explicit positioning takes priority.
Loading, failed or hidden content and overlay locks do not save temporary
positions. Actual project history entries use manual native restoration, while
settings and other routes retain their own behavior.

This replaces the separate Overview and task-list positions in the archived
[task-list scroll decision](../../archived/bug-fix/2026-11-03-shared-task-list-scroll.md)
and [section restoration decision](../../archived/bug-fix/2026-10-25-project-section-restoration.md).
Those choices preserved the reading position in each workspace; the shared
position now follows the current page across sections. The
[project URL decision](../feature/2026-11-17-project-tab-urls.md) retains real
links, draft admission and section history. The [filter decision](../feature/2026-11-05-task-list-status-filter.md)
retains the independent filter and task-list semantics. The
[Web specification](../../../../docs/spec/daynight-web.md) owns observable
behavior and the [Web design](../../../../docs/design/daynight-web.md) owns the
current mechanism and storage format.

## Alternatives

**Keep separate section positions.** This resumes a section's earlier reading
location but causes a visible jump on every switch, even when the current
position fits both sections. It also brings back a stale position after a short
section clamps the page.

**Leave native history restoration enabled for project entries.** Browsers can
restore each entry's earlier offset independently of application state, so Back
and Forward would still jump despite a shared application position. Restricting
manual restoration to project entries preserves the other routes' existing
history behavior.

## Consequences

The saved offset is browser-local and isolated by account and project. Existing
task-list scroll records are intentionally ignored. A short page may reduce the
shared offset; returning to a longer page starts from that reduced position.
Explicit navigation still controls its target and focus, while detail panes and
graph viewports remain independent. Storage errors remain visible and do not
prevent in-memory navigation. Real-browser tests must observe the transition
frames as well as final offsets, since a transient jump can disappear before a
final-only assertion.
