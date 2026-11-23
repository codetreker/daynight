# Agent Note: Web Task and Goal Creation Tags

Status: implemented

## Problem

Creating a Task or Goal with project tags must preserve the user's complete
selection through failures without producing an item with only part of that
selection. A tag created in the selector has its own catalog lifetime.

## Decision

Both creation stores use the shared tag picker with an initially empty selection.
They capture the selected IDs with the other creation fields and send one create
request. The client validates the returned resource and exact tag set. Pending
and unknown outcomes retain the submitted snapshot; an unknown outcome is not
replayed. Cancelling an unsubmitted form discards its association draft; a failed submission
retains its draft on reopening. An independently created catalog tag remains available.

## Alternatives

**Create the item and then attach tags.** A second write can fail after the item
exists, leaving a partial result that does not represent the user's request.

## Consequences

Task and Goal creation share the existing catalog and picker behavior without
inheriting a Parent's tags. A mismatched receipt is treated as an unknown outcome
because a successful response may represent an already committed write.
