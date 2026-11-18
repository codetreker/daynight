# Agent Note: Explicit Task Body History Protocol

Status: implemented

## Problem

Retained Task messages need a narrower resource closure than live tool output.
The existing history ledger validates image capture positions and final archives;
removing tools without distinguishing the retained source would either break
tool images or describe an intentionally filtered archive as a complete tool trace.
Strict existing readers also cannot consume new manifest fields silently.

## Decision

Task body histories use an explicit `task_body` policy, bound to the original
claim Session and immutable after the first committed history. The existing
source sequence barrier remains independent of retained entry positions.
Schema3 manifests add a negotiated policy variant without changing their file
layout. Both Go and TypeScript readers validate the policy and actual entry
kinds. Legacy histories and manifests keep their exact field sets.

The capability response header allows producers to establish support before
uploading body history. Raw manifest reads require the matching request version
for body archives; older readers receive `upgrade_required`. Web readers opt in,
retain the policy, and explain the archive's message-only scope. Existing public
history JSON remains unchanged, with policy exposed through negotiated headers.

Active body history carries a bounded cumulative set of online image positions,
without tool text. Final history empties that set and retires online references
through the existing resource transaction and lease-aware reclamation. Shared
body resources remain referenced. Live inspection keeps its complete online
meaning. The [history design](../../../../docs/design/task-session-history.md)
owns the wire fields and lifecycle.

This protocol supplies the consumer side of the
[storage contract](2026-11-18-session-storage-contracts.md). Producer activation,
local online storage and its cleanup remain separate responsibilities.

## Alternatives

**Add fields to every old response.** Strict readers would reject otherwise
valid archives as corrupt. Negotiated reads preserve the old response contract
and identify readers that require an upgrade.

**Introduce a new physical archive schema.** The timeline/blob layout is
unchanged. A schema bump would require unrelated archive storage constraints and
migration changes without improving policy validation.

**Remove tool image positions with tool text.** Live capture would lose its
original position authority. Bounded position metadata preserves that authority
without retaining command arguments or output in body history.

## Consequences

Protocol support can precede producer activation while old executions continue
to work. New body archives require upgraded raw-manifest readers; an already-open
old Web client receives an explicit upgrade error rather than malformed data.
Online image positions consume bounded ledger capacity until finalization.
Body archive completion does not implement retention deadlines, directory
grouping, Bot cache eviction or native recovery.
