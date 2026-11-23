# Agent Note: Ordinary Task Parent Write Protocol

Status: implemented

## Problem

Clients need to create ordinary children and explicitly cancel an unfinished
subtree through the existing public Task tools. Default Goal navigation, scoped
write receipts and precommit response limits must remain usable by existing
clients. A false confirmation field must not bypass its target-type restriction.

## Decision

REST and MCP accept ordinary-parent creation and descendant-cancellation inputs
through their existing create and status operations. The
[parent write design](../../../../docs/design/daynight-task-parent-writes.md)
owns parsing, scope, typed-parent immutability, fault references and byte admission.
Cancellation retains field presence independently of its value, so both true and
false are restricted to ordinary cancelled requests before same-status handling.
Shared service transactions implement the lifecycle; protocol adapters do not
walk or mutate the subtree. This exposes the
[parent lifecycle decision](../architecture/2026-11-23-task-parent-lifecycle.md)
through public inputs without changing default read representations.

## Alternatives

**Treat false as an omitted field.** This loses the request's explicit input and
allows a field that belongs only to ordinary cancellation on Goals or other
status operations.

**Introduce a separate cancellation tool.** Existing status tools already carry
exact versions, scope and write-outcome semantics; a separate tool would duplicate
those contracts without adding a business capability.

## Consequences

New clients can use ordinary parents while existing clients retain Goal-only
parent IDs. Extended representations count their actual UTF-8 bytes before
commit. Strict old services reject the new fields; callers must retain that
failure and must not silently resubmit a weaker cancellation. Module tests own
refusals and budgets; normal real-server flows prove REST/MCP assembly and
persisted readback.
