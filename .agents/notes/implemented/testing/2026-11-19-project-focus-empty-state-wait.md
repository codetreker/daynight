# Agent Note: Project focus empty-state wait

Status: implemented

## Problem

The empty-project refresh test waits for a heading while real cache history
purge and reconciliation complete. Repeatedly formatting the old DOM on failed
queries consumes part of the existing deadline and can delay the refresh itself.

## Decision

The empty-state test polls the same accessible heading with `queryByRole` inside
`waitFor`, observing `document.body`. The wait starts immediately after the
refresh click and retains Testing Library's default deadline and interval. The
remaining focus, modal, notification, statistics and tab assertions stay intact.

## Alternatives

**Keep `findByRole`.** Failed attempts format the DOM repeatedly while the
refresh is still pending, consuming time within the same deadline.

**Wait for a cache barrier before the heading.** Starting the DOM deadline after
the barrier would extend the time allowed after the click and change the test's
observable timing guarantee.

## Consequences

Missing headings no longer trigger full DOM formatting on each poll; a final
timeout still includes DOM diagnostics. The role, accessible name and uniqueness
checks remain in force. This reduces query overhead without establishing the
unique cause of historical CI failures or changing cache behavior.
