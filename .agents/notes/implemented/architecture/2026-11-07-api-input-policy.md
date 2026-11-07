# Agent Note: Shared Candidate Input Policy

Status: implemented

## Problem

A historical-data inventory and future online admission need to agree on field
units, normalized property values and protocol bytes. A transport-only check
misses internal callers, while changing structural normalization would also
change how existing data is read.

## Decision

Domain packages own candidate limits and pure admission, with a versioned policy
catalog for inventory. Property normalization remains separate from admission;
Task and Step share text limits. Protocol projections and measurement share the
actual response representation without a core dependency on HTTP handlers.
Typed violations report measurements without retaining the input. The
[specification](../../../../docs/spec/daynight-api-input-limits.md) records the
candidate limits and their activation state.

## Alternatives

**Enforce only in HTTP handlers.** Internal and MCP writes could bypass the same
business limits, and an inventory could disagree with the actual write path.

**Put size checks into structural normalization.** Storage reads use that same
normalization, so this would silently change historical-data handling before an
inventory or migration decision.

**Keep separate inventory and output encoders.** Escaping, envelopes and newline
handling could make a compliant inventory disagree with a production response.

## Consequences

The policies can be exercised independently and do not themselves enable online
limits. Existing historical data still needs an explicit inventory and resolution
before activation. Complete unpaged directories and cumulative storage remain
unbounded. The existing [Task data ownership decision](2026-11-05-task-data-ownership.md)
continues to own the distinction between property structure, write permissions,
and Step/Thread encoding.
