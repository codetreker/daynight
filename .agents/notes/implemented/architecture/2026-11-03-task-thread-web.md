# Agent Note: Bounded browser task discussions

Status: implemented

## Problem

Task participants need durable discussion in the browser without depending on an
active execution environment. A bounded browser view must preserve complete
messages, identity and incremental continuity while users read history, send
messages, change accounts or return from a hidden page. A late successful POST
can coexist with earlier unseen messages, and a lost response cannot establish
whether the service committed it.

## Decision

Discussion is an always-present task-detail tab with a page-owned controller
scoped only by account, project and task. It uses the Thread service rather than
Task mutation or Session control. The authenticated shell supplies its existing
current-account context. The controller reuses account admission and revocation
signals without storing Thread messages, drafts or cursors in TaskCache,
IndexedDB or task-sync.

Web reuses the browser-safe Thread source and resource parser in the CLI API
library. Network, principal admission, error presentation and controller lifetime
remain browser-owned; command invocation, terminal rendering and CLI Operation
lifetime remain CLI-owned. Raw source spans retain the service's escaped byte
bounds and duplicate-member checks. This reuse does not create a shared feature
controller or a second message identity.

A separate consumed-after ID advances only after a fully validated forward page
is retained. POST receipts, history and reference reads cannot move it. The
fetched window represents one retained contiguous service segment; detached
anchors and own receipts can remain visible without becoming its endpoints.
Pruning selects one edge run from the complete candidate sequence and preserves
a fetched member for navigation. Forward pages extend that run only through a
captured boundary or overlapping returned IDs; otherwise they remain a complete
incoming segment. Ordinary empty-buffer jumps preserve the established run;
capacity release can retain its newest fetched member. Reveal uses the complete
buffered segment, including visible echoes. Notification counts include only
buffered IDs that are not currently displayed.

Visible, incoming and reference windows have count and byte caps. Only one
reading anchor, one latest confirmed receipt and one in-flight POST reservation
can be fixed. New receipts release previous receipt pins, and explicit window
navigation can evict already displayed own receipts before a forward GET covers
them. Such eviction never advances continuity. Revealing all retained incoming
messages plus the fixed set leaves capacity for another complete forward page.
History tickets belong to a captured window revision, direction and actual
boundary. Explicit reference navigation or incoming reveal replaces that window,
aborts its history request and releases the slot. Admission, merge and error
handling reject stale tickets so an old result cannot alter the replacement
window or its requests.

The API distinguishes waiting for authentication from dispatch, validates a 201
and its body/reply/actor echo, and records the confirmed remote result before
waiting for same-account publication admission. The response timer ends at that
confirmation. Later local cancellation cannot turn a known commit into an
unknown result, while scope retirement still discards publication. A later local
admission failure is a read/admit error that retains the confirmed resource, not
a failed-send result. Dispatched uncertain results preserve drafts and are never
replayed automatically.

The message-details dialog owns its keyboard layer and tells the task Surface
when the child layer is occupied. This prevents parent Escape and focus-reclaim
behavior from closing or stealing focus from the child dialog. Markdown and
reading-intent scroll behavior are shared pure UI primitives, with consumer-owned
labels and resource policy.

## Alternatives

**Reuse Session or Task properties.** Session ownership follows execution and can
require its Controller; Task properties require versioned mutation and graph
projection. Neither provides an independent append-only discussion lifetime.

**Build a shared client feature module.** A common controller would couple CLI
invocation/output lifetime to browser auth, visibility and UI state. Reusing the
already browser-safe parser keeps a single wire contract without merging those
consumer responsibilities. The [CLI decision](2026-11-03-task-thread-cli.md)
retains the original reason for rejecting a shared feature lifecycle.

**Use the visible last message as the incremental cursor.** A locally returned
POST can sort after another participant's unseen message. Advancing to that
receipt would skip the earlier message. The independent consumed position is a
structural requirement even when the visible list is small.

**Keep all unconsumed own receipts pinned.** A burst of confirmed local posts can
fill the visible budget while earlier unseen history fills incoming. Revealing
incoming cannot free enough space if all own receipts remain fixed. A fixed-size
pin set and explicit eviction preserve both bounded memory and progress.

**Retry uncertain posts or reconcile equal bodies.** Repeating a POST can append
a duplicate; equal text cannot identify the original submission. Ordinary reads
support a new explicit decision without an operation ledger or lookup endpoint.

## Consequences

Discussion survives task execution changes while browser state stays temporary.
Refreshing or leaving the task loses its draft, references and read position;
messages remain on the service. Incoming counts describe retained messages,
not the service's total backlog. Explicit navigation can replace displayed
history, which remains reachable through existing before/after ID pagination.

Horizontal gutters use the Discussion container width. An ordinary 960px task
modal retains 30px gutters; standalone and fullscreen views retain the 1080px
default and 1280px wide reading limits. Existing narrow-screen spacing and the
10px send label remain. Viewport-derived gutters would consume or clip the
reading area inside a fixed 960px modal on a wide screen.

Safe error details expose only a validated code and request ID on demand. A
private console warning records task scope, phase/direction, bounded code/status,
validated request ID, a fixed cause category and the known remote outcome. It
never records drafts, bodies, names, credentials or raw error objects, and adds
no persistent telemetry or submission identity. Existing request IDs can relate
browser failures to service events without implying Agent consumption.

The bounded windows add admission and retention decisions. Their count and data
byte limits do not claim a precise JavaScript heap bound. Each reveal must leave
room for a complete forward page; changing caps requires preserving that proof.
The parent-reference resolver uses at most two existing list reads on demand,
with an exact target check and a bounded cache rather than eager per-row work.

The production and dev-ci image use the same frontend build, whose context and
COPY inputs include the browser-consumed CLI API/session trees and the exact
pure text utility. These sources must stay available without host worktree
artifacts. Changes to the API/session trees or text utility select both CLI and
Web validation, so a shared contract change cannot bypass its browser consumer.

Mutable messages need a separate change-reading contract. Inbox, directed
routing, receipts, automatic wakeups and notification recovery remain separate
capabilities with no dormant schema or controller machinery here.

The [Web design](../../../../docs/design/task-thread-web.md) owns mechanisms;
[Thread requirements](../../../../docs/spec/daynight-task-thread.md) own observable
behavior and the [storage decision](2026-11-03-task-thread-storage.md) owns database
ordering and commit semantics. Runtime validation belongs to the tested source
revision and its artifacts, not to this decision record.
