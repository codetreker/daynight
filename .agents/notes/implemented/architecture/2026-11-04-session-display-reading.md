# Agent Note: Session Display Filtering and Reading Position

Status: implemented

## Problem

Hiding timeline rows changes layout while users may be reading older content.
A removed row cannot supply its DOM position or its neighbors, and a short
filtered page does not mean history is exhausted or the reader wants to follow
new output. Display changes must preserve those distinctions without changing
session operations or stored history.

## Decision

`SessionTimeline` accepts an explicit display mode and renders the existing
[classification selector](2026-11-04-session-display-classification.md)'s result.
Its omitted-mode behavior remains Standard for internal compatibility. This
preserved ordinary entry points' visible history when filtering first shipped
without mode controls. The shared Session View now explicitly supplies its
selected preference and defaults to Conversation. The Conversation
empty message is localized separately from the original empty-session message.
History loading, failure and retry remain independent of visible row count.
The original filtering delivery retained manual pagination and prohibited
automatic loops through hidden pages. The
[automatic history decision](../bug-fix/2026-11-04-session-history-autoload.md)
replaces that policy with viewport demand and verified page progress while
preserving this decision's filtering and reading guarantees.

The shared `useTimelineScroll` accepts optional original and visible key orders
plus mode, separately from identity and content revision. A paused anchor keeps
its original order as well as row and text position. A surviving row uses its
text anchor; a filtered row resolves to the nearest visible predecessor, or
successor when no predecessor exists, at the row top. No visible rows leaves
the reading intent paused. Inactive views defer geometry work until activation.
The hook also exports an optional detached reading bookmark for unmount/remount.
It copies ownership identity, history epoch, following intent, one entry/text
anchor and at most two neighbor keys. It never exports the captured full key
order. A cold restore waits when the target is absent from an incomplete tail;
pagination capture cannot replace that target. After an authoritative history
boundary, absent rows fall back to the saved preceding neighbor, succeeding
neighbor, or first visible row. Filtered rows still use the current complete
order. Empty displays and inactive geometry retain the pending bookmark. When a cold
restore loses its text quote and the saved offset would hide the whole shortened
entry above the viewport, it uses the entry top rather than a later message.
SessionTimeline combines the caller's authenticated ownership scope with the
actual session fence, and checks historyEpoch separately. The container owns
bookmark lifetime and historical loading; the hook owns geometry and intent.

The [Session design](../../../../docs/design/task-session-protocol.md) owns the
complete rendering, pagination and scroll interfaces.

## Alternatives

**Use only the filtered list as the scroll revision.** It loses the removed
anchor's chronological position and cannot distinguish its predecessor from
unrelated surviving rows. Original order remains available independently of
mounted elements, including across inactive renders.

**Reset scroll identity when the mode changes.** Existing identity reset means
following the latest content. Applying it to a display setting discards the
reader's explicit pause and jumps away from the passage being read.

**Reuse the ordinary empty-session message.** A filtered empty page may contain
history and still have older pages. A distinct message explains the visible
result while the independent manual pagination control preserved access in the
original delivery. Pagination now follows the separately owned automatic
history policy.

**Export the complete captured order.** This would preserve every removed row's
chronological neighbors across unmount, but each retained bookmark would keep
an array proportional to loaded history. Two neighbor keys bound retained data;
if both disappear, the documented first-visible-row fallback sacrifices exact
chronology without switching to following.

**Treat a missing tail anchor as deleted.** This would allow immediate placement
but discard valid positions outside the loaded tail. Restore stays pending until
the caller loads the target or confirms the history boundary. Network progress
and retry remain with the existing Session owner.

## Consequences

Mode changes preserve retained message and interaction nodes, pending responses
and original entries. Hidden tool resources unmount; restored tools reuse the
existing timeline data and ordinary resource-loading rules, without dispatching
provider operations. Filtering itself needs no preference store, client or
protocol change.

While mounted, the hook retains one captured key order in addition to the current lists. Detached bookmarks retain only a constant number of keys and a bounded text quote; no database or cross-page retention is introduced. Its
display argument is optional so other timeline consumers preserve their API.
DOM geometry remains a browser acceptance concern: simulated unit geometry
checks selection rules but cannot prove native text wrapping or scroll events.
The [shared view integration](2026-11-04-session-display-integration.md) consumes
this explicit interface for Task, Test and readable archives. It owns default
selection and the menu; neither belongs in the scrolling hook.
