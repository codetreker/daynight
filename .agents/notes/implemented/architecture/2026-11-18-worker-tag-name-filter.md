# Agent Note: Worker Tag Name Filter Rules

Status: implemented

## Problem

Workers need a project-independent way to compare configured tag names with
task tags and to identify the exact matching semantics across components.
Project tag IDs do not identify the same text across projects.

## Decision

The server's shared tag domain normalizes a `model.TagNameFilter` using the
existing tag name validation and ASCII folding rules. It retains the first
display spelling for each key, sorts keys by Unicode scalar order, and treats
an empty set as `any`. The pure matching operation implements any and all;
the digest hashes compact UTF-8 JSON `[match, sortedKeys]` without HTML escaping.
Invalid names or modes return errors rather than dropping a constraint.

## Alternatives

**Resolve names to project tag IDs.** IDs are project-specific and would make
an absent name disappear from an all-filter or require per-project resolution.

**Use Unicode case folding or normalization.** This would change the existing
tag catalog's equality semantics and could equate distinct tag names.

## Consequences

Configuration and claim consumers can share one server-side comparison and
digest contract. This foundation does not itself configure Workers, filter SQL
queries, or enforce claims; those integrations must use the same semantics.
