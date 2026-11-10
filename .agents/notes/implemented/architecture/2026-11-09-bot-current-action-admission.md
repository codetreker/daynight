# Agent Note: Admit Bot Actions Independently of Retained Display

Status: implemented

## Problem

Returning to a resident Bot must restore its own conversation before a new detail
read completes. A retained client still owns its draft, reading state and original
operation receipts, but that ownership does not establish that a new command is
for the currently selected, verified execution. Hiding the pane loses continuity;
button visibility alone cannot stop old callbacks or direct client calls.

## Decision

The existing detail cache supplies independent display and action bindings for
the current selection. The page consumes it with the actual three resident Bot
IDs. The complete identity includes owner, Bot, Session and test execution. The
Host retains stable pane DOM and applies the committed selection in a layout
effect. The existing navigation owner's accepted-location notification
synchronously suspends old clients before React commits another selection; same
locations and cancelled draft decisions do not leave the original pane frozen.

The Session cache revokes every pane's new-action admission before selecting,
including cache hits. Only the current valid pane with equal complete bindings
receives admission. Every Bot client starts with admission false; ordinary Task
and Test clients retain the true default. The final command path checks admission
before creating request/operation IDs or recording submission, intent and
progress. Interaction responses also check before creating their submission ID.
Refusal neither queues nor automatically retries the action.

Admission is separate from owner interaction, authentication pause and receipt
recovery. Local text, menus, applicable live form values and timeline navigation
retain their original owners. Remote submission is disabled independently. Hidden
clients can continue reading and recovering already dispatched operations under
their original IDs and fences. The [Session design](../../../../docs/design/bot-session-view.md#绑定和消费接口)
owns the interfaces and ordering rules.

This extends selection-specific behavior alongside the existing
[background-check display decision](../bug-fix/2026-11-05-bot-background-check-display.md).
That decision retains the bounded authentication transport pause; a detail
revalidation only revokes new actions and does not enter that pause. The
[original pane-cache decision](../../archived/architecture/2026-11-04-bot-session-cache.md)
remains the historical rationale for the three-client budget and lightweight
recovery state.

## Alternatives

**Keep hiding the pane until details return.** The original component can remain
mounted, but the user cannot read or edit it during a return visit. A delayed read
still interrupts the conversation and makes a cache hit appear cold.

**Use authentication pause or owner interaction for selection checks.** Those
rules also control publication, original receipt recovery or local editability.
Reusing them would stop work belonging to a valid retained execution even though
only its new-command qualification is missing.

**Disable only visible buttons.** Old event callbacks and direct client calls
would still create operations for a noncurrent pane. Synchronous final admission
is required before operation side effects.

## Consequences

Warm returns preserve the client, timeline, composer, draft and reading handle
without increasing the three-pane budget. Ordinary detail polling retains its
confirmation; a real failure removes action admission until a valid retry.
Deletion, account revocation and changed bindings retain their existing cleanup
rules. Default Task/Test and archive behavior remains independent of Bot selection.

The page, cache and final dispatcher each enforce their own timing boundary;
future image submission paths must consume the same admission before freezing or
submitting input. Persistent display previews, first-history facts and
snapshot-to-live merging have a separate
[history owner](2026-11-09-bot-persistent-history-preview.md) and cannot derive
permissions from readable cached history.
