# Agent Note: Web Project Deletion

Status: implemented

## Problem

Deleting a Project affects all its visible contents while active Worker claims
can still block the operation. A browser can lose a response, change routes or
identity, or fail local cleanup after the server has committed. A later access
check cannot reconstruct the original write outcome, and an old result must not
withdraw a newly authorized Project generation.

## Decision

Project Settings previews the actual Project and blocking claims and requires
exact name confirmation. A shared guard serializes its management writes. The
original identity retains dispatched operations across route changes; a separate
result owner stores confirmed receipts before withdrawal and navigation. The
owner uses the dispatch generation for immediate withdrawal, waits for identity
admission before publishing results or navigating, and retries local cleanup
and navigation independently. Standalone pages present the retained result in a
collapsible region so that other Task controls remain usable. Session fullscreen
retains visual viewport dimensions and offsets while reserving the measured
result-bar height, including when a mobile keyboard changes the visible area. Unknown results allow only
read-only checks and retain their uncertainty after a 404. The
[Web design](../../../../docs/design/daynight-web.md#项目删除) owns the complete
interaction and outcome rules, and the [projection decision](../architecture/2026-11-06-web-project-projection-withdrawal.md)
owns withdrawal consumers.

## Alternatives

**Treat a later 404 as deletion success.** Access can disappear for another
reason, so this cannot establish whether the original request committed.

**Keep the result in the settings route.** Navigation could unmount the operation
or hide a late response and leave no actionable result.

## Consequences

The page retains an operation owner while its result remains unresolved. A
confirmed deletion stays confirmed when local cleanup or navigation fails, and
those retries do not issue another DELETE. Generation checks can leave later
authorized content intact rather than applying a stale receipt to it.
