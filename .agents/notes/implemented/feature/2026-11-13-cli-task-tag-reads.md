# Agent Note: CLI Task Tag Reads

Status: implemented

## Problem

Task and Goal consumers need each entry's current tag identities and names on
every read and receipt, including search, without confusing an absent association
with an incomplete or invalid server response.

## Decision

The CLI requires `tags` references on full Task and search responses, validates
their IDs and names, and retains them in structured output. Human output lists
names individually and explicitly shows an empty set. Graph nodes retain their
narrow contract. The [CLI manual](../../../../packages/daynight/README.md#task-management)
describes the output and failure behavior.

## Alternatives

**Default missing tags to an empty array.** This would hide a protocol mismatch
and falsely report that an entry has no associations.

**Resolve names through the catalog.** Extra requests could mix observations and
are unnecessary because each Task response already includes the current names.

## Consequences

Older responses without the required field fail explicitly. Search remains a
lean projection, and paginated reads publish no partial results on failure. Tag association writes use the [CLI association decision](2026-11-13-cli-task-tag-associations.md);
filter commands remain a separate capability.
