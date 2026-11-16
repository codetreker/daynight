# Agent Note: Nonterminal discussion and research tasks

Status: implemented

## Problem

Requirements discussions and research can produce a useful result without
finishing the work it informs. Treating that result as the end of the chain can
leave subsequent work without a registered owner.

## Decision

The [completion conditions](../../../skills/development-workflow/references/task-execution.md#completion-conditions)
define requirements-discussion and research Tasks as nonterminal by default.
They require registered and verified successors before completion unless the user
explicitly confirms that the current result ends the work. The existing
successor registration and authorization rules continue to apply. This extends
the context of the [earlier successor registration decision](../../archived/process/2026-11-02-goal-spec-confirmation.md),
which addressed already-confirmed following work.

## Alternatives

**Leave terminal status implicit.** The existing registration gate covers
confirmed successors but does not establish a default for these task types,
leaving their results vulnerable to premature closure.

## Consequences

These tasks retain a tracked continuation by default, while an explicit user
confirmation can make the current result the end of the work. The definition
does not grant authority to register or execute successor work.
