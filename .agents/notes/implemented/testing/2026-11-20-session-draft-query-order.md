# Agent Note: Session Draft Query Ordering

Status: implemented

## Problem

A browser test of an earlier image draft must distinguish the automatic query
started when the target changes from a user's explicit operation check. Both
use the same operation endpoint, and an in-flight automatic query can consume a
shared fixture response intended for the button. Confirmation can remove that
button before Playwright completes its click, obscuring whether the interaction
was exercised.

## Decision

The Session draft browser fixture captures the response state for each operation
query on arrival and can hold selected requests by operation ID, source and
target. Test-only headers capture the client state when the request starts. The regression
observes the target-change query and controls its 404 response separately from the
explicit button query's confirmed response. It exercises both response orders
through the real client and DOM, retaining draft identity, storage, image and
send assertions. The automatic-first case waits for the owner load to settle
before clicking. The explicit-first case releases the older automatic response
only after the button's confirmation has changed the UI.

## Alternatives

**Switch a global query response before clicking.** An already-started automatic
query can receive confirmation and remove the button; a visible enabled button
alone does not establish that the explicit check ran.

**Delay or force the click.** Timing and forced interaction do not identify the
request that received confirmation or prove ordinary user interaction.

## Consequences

The fixture observes request identity and browser state while retaining real
reconciliation and a bounded test deadline. The controlled API does not establish
which request caused any historical failure or prove behavior against a live
service. The [browser acceptance decision](2026-11-13-session-draft-browser-acceptance.md)
retains the suite's execution and evidence boundaries.
