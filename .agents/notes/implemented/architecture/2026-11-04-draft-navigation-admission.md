# Agent Note: Draft Navigation Admission

Status: implemented

## Problem

Task draft protection must decide whether to leave before a keyed detail view
unmounts. Program navigation, local dialog selection and browser traversal have
different timing: a popstate event arrives after the browser has moved, while
local dialog close does not change the URL. Independent location subscribers
would let one component retire a draft before another asks the user.

## Decision

One window-owned `BrowserNavigation` publishes admitted locations. Program writes
and local detail actions request admission before mutation; indexed traversal
retains the admitted view while the user decides. Confirmation adopts the latest
arrived history target without pushing; cancellation traverses to the original
entry. The [Steps design](../../../../docs/design/daynight-task-steps.md#web-呈现导航与大集合)
owns the API, scope lifecycle and accepted history limits.

Draft readers and discard callbacks belong to the authenticated cache instance,
project and task. Cleanup releases registration without choosing to discard.
Confirmation preserves a live registration so subsequent input remains protected;
its synchronous continuation can reuse that admission before React renders the
discarded state. Identity abort and proven resource retirement clear private
content immediately rather than offering a cancellable security decision.

History markers contain a segment and index; exact URLs live only in the
navigation owner's memory. A native fragment can copy state without adding an
application index, so its URL must match the in-memory entry. The
[invitation cleanup decision](../bug-fix/2026-11-04-invitation-history-state.md)
records why URLs are excluded from serialized markers and how fragment cleanup
keeps indexed and native entries coherent.
An application write from an unindexed position starts a new segment on the
written entry. Older segments cannot supply a valid distance across unnumbered
entries. Native traversal alone never repairs an entry or assigns an invented
index. Capturing a project or Team invitation scrubs its fragment through the
same owner and publishes the clean admitted location. Cleanup preserves an
indexed entry; an unindexed native entry loses any copied marker and remains
unindexed. Only a later application navigation write starts a new segment.

## Alternatives

**Guard only `navigate`.** Native traversal would still publish through other
location subscribers, and local modal close/relation changes never call it.

**Decide during unmount cleanup.** The old view and input would already be lost;
cleanup cannot recover the history position or reverse security retirement.

**Bounce before asking.** Moving back before showing a choice adds traversals
and requires replaying an approved target. Holding the rendered location allows
direct adoption of the target the browser has already reached.

**Repair native history entries.** This would expand the accepted scope into
index reconstruction and recovery. Starting a new application segment keeps
distance calculations honest without claiming protection across missing indexes.

## Consequences

Every application route consumer must use the admitted-location subscription.
Task-local actions that retire an editor must request admission, while same-task
tabs keep the editor and its registration mounted. The small browser host imports
the production owner and confirmation directly, allowing browser-history and
focus checks before any Steps form or HTTP write exists.

Native document departure uses the browser's beforeunload policy. Unindexed and
cross-segment traversals retain their accepted recovery and draft-loss risks.
State remains private to one window and is neither durable routing storage nor
business recovery. Extending protection to native entries requires revisiting
the history owner, not the Steps API.

Task-owned native message and attachment dialogs dismiss before a leave choice
mounts. Their browser top layer would otherwise make the shared confirmation
inert. Cancellation preserves the draft without reopening the dismissed child
dialog, and one Escape handles only the active leave choice.
