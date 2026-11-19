# Agent Note: CLI Goal Acceptance Dependencies

Status: implemented

## Problem

CLI users need to inspect and edit Goal acceptance dependencies, including
relationships whose targets they can no longer read, without confusing them
with ordinary Task dependencies or losing an exact relationship revision.

## Decision

The CLI uses the independent [Goal dependency REST resource](2026-11-19-goal-dependency-rest.md)
for one-page reads and explicit add, remove and complete replacement operations.
Targets use Project and Goal UUIDs; opaque edge UUIDs allow removal or retention
of hidden relationships. Empty replacement requires an explicit clear. A supplied
revision is sent as an exact decimal string; otherwise one read obtains it before
the single edit attempt. Conflicts and uncertain outcomes are not replayed.
The product manual owns command usage and the REST specification owns the wire
contract.

## Alternatives

**Reuse ordinary Task dependency updates.** Task metadata versions and graph
semantics do not represent the separate Goal acceptance revision or hidden edge
identities, and would change existing Task client behavior.

## Consequences

Editors can retain or remove hidden edges without discovering their targets.
Each successor page is separately authorized and is not a frozen multi-page
snapshot. A later read after an unknown write shows current state but does not
prove the outcome of that write. Older services without the relationship route
cannot provide these operations.
