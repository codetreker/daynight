# Agent Note: Session History Loading from Reading Position

Status: implemented

## Problem

Reading earlier Session activity stops at a button even when the reader keeps
scrolling upward. Display filtering can also leave a short viewport or several
pages with no visible rows. Loading every older page would waste requests and
disrupt reading, while treating an unchanged DOM as the end of history would
hide valid content. Concurrent connection changes can leave an older request
holding loading state or allow its late error to affect a newer connection.

## Decision

Session history loading follows demand in the actual timeline viewport. User
scrolling near the loaded history's top can request an older page; a short
viewport can fill serially after initial tail positioning and layout. A filled
viewport does not scan history on mount, mode changes, or programmatic anchor
restoration. Loading is compact and accessible; errors remain visible with an
explicit retry, and exhaustion adds no permanent notice.

The Session controller uses successful page revisions, loading/error state and
current viewport demand to continue after rendering. This supports filtered
empty pages without relying on DOM growth or another observer intersection.
The existing [reading intent decision](2026-10-28-session-reading-and-draft-ownership.md)
continues to own text anchors and following. Prepend captures and restores that
same anchor rather than adding a separate scroll-height correction. Short-page
fill preserves the existing following intent.

Automatic continuation is limited to the active, visible, current, authenticated
and online view with ready history. Identity, history and connection changes,
returning to latest and unmount invalidate old continuation. Older-page requests
also carry their own ownership token, so stale completion or authentication
failure cannot mutate the newer request. More-history cursors must be nonempty
and progress without returning to a previously visited cursor. Fresh tail
hydration establishes a new progress record; cursors remain opaque values.

The [display reading decision](../architecture/2026-11-04-session-display-reading.md)
originally retained manual loading to keep display filtering independent of
network policy and avoid unbounded fetching through hidden pages. Automatic
loading replaces only that pagination policy, using viewport demand, successful
page state and cursor progress to bound continuation. Filtering, preferences,
resource indexes, latest revisions and the shared scroll contract remain owned
by their existing mechanisms. Discussion timelines do not acquire Session's
automatic request policy.

The [Session design](../../../../docs/design/task-session-protocol.md#session-view-的阅读与输入状态)
owns the controller and client interfaces. The
[requirements](../../../../docs/spec/task-sessions.md#session-历史自动加载)
own observable behavior and reading-position tolerance.

## Alternatives

**Retain a manual button for every page.** This bounded requests but interrupted
continuous reading and required repeated action through filtered empty pages.
Explicit action remains appropriate for retrying a failed request.

**Continue only on a new observer intersection or increased DOM height.** A
successful page may contain only hidden tools or merge existing revisions.
Neither event then occurs, although an older cursor and reading demand remain.

**Fetch until a visible row appears.** Visibility alone does not establish current
demand: the reader may leave the top, return to latest, hide the view or change
identity while a request is pending. Every completed page must yield to layout
and recheck both availability and demand.

**Add scroll-height compensation around prepend.** The shared hook already
restores a text anchor across reflow. A second correction would move the same
viewport twice and cannot identify a retained line inside a long message.

## Consequences

Task and Test Session views share automatic history behavior in both display
modes and viewport sizes without changing the server paging protocol. Complete
archives keep their existing all-content read. Client snapshots expose history
readiness, successful-page revision and connection generation; cursor progress
requires one set per current history traversal.

Browser geometry remains necessary evidence for text continuity, input methods
and layout changes. Unit geometry and request counts cannot prove that the same
rendered text remains within the required pixel tolerance. Authentication,
resource loading, reset handling and native operation semantics stay separate
from the automatic request policy.
