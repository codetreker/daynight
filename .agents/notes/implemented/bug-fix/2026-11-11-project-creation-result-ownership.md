# Agent Note: Project Creation Result Ownership

Status: implemented

## Problem

A Project creation can finish while identity admission prevents its result from
being displayed. Holding the local operation open until admission resumes leaves
the form busy indefinitely. Finishing locally also lets a user edit or navigate
before a delayed result is displayed, so the old result can affect a newer draft
or destination. Cancellation cannot establish that a dispatched write rolled back.

## Decision

The Project creation dialog owns its operation and any cancellable delayed
publication. It distinguishes actual dispatch from a trusted creation receipt,
settles the local busy state without waiting for presentation admission, and
retains the existing unknown classification for dispatched writes without a
confirmed receipt. Unknown results prevent another write, and a confirmed result
prevents resubmission of the same draft while allowing further edits. Result and
error publication remain subject to the original identity admission. A confirmed
Project is published and the list refreshed independently of automatic navigation;
publication failure is distinct from creation failure. Closing or navigating also
requires the original dialog, draft revision and navigation context to match and
no pending navigation decision since submission. Otherwise the dialog retains the
draft and provides a link to the created Project. A new submission, owner change
or disposal cancels publication and handles errors. The [auth design](../../../../docs/design/daynight-auth.md)
describes the resulting contract. The [Team Project creation decision](../../archived/architecture/2026-11-04-team-project-creation.md)
records the transaction and original identity-bound unknown outcome rationale.

## Alternatives

**Hold the operation until admission resumes.** A permanent pause would retain
the pending state and its promise indefinitely, even after the write outcome is
known or locally cancelled.

**Use a general mutation and form framework.** The existing dialog already owns
the operation and its lifetime; a shared framework would introduce a wider
contract without resolving this owner's draft and navigation checks by itself.

## Consequences

Local editing can continue after settlement without authorizing remote work.
Temporary admission recovery can publish the same confirmed result, while newer
editing, navigation decisions or owner disposal prevent destructive effects from
the old completion. An unknown write is not replayed, and reading the current
directory cannot reconstruct its original receipt.
