# Agent Note: Task and Goal Handoff Entrypoints

Status: implemented

## Problem

Requests to hand off one task or all unfinished tasks in a task group identify
different targets. Agents need discoverable entrypoints for both without creating
another owner for the rules governing task handoff.

## Decision

The repository provides [handoff-task](../../../skills/handoff-task/SKILL.md)
for one user-specified task and [handoff-goal](../../../skills/handoff-goal/SKILL.md)
for every unfinished task in a user-specified group. Each uses `using-daynight`
directly. The [content-sufficient handoff decision](../../archived/process/2026-10-25-task-content-handoff.md)
and its skill remain the owners of the handoff workflow and its safeguards.

## Alternatives

**Repeat the handoff workflow in each entrypoint.** Separate copies of review,
permission and reconciliation rules could diverge from their existing owner.

**Have the group entrypoint depend on the single-task entrypoint.** Both targets
already use the same handoff workflow, so the extra dependency adds indirection
without providing a distinct rule.

## Consequences

The entrypoints express target selection while `using-daynight` controls each
handoff. Changes to the shared workflow remain centralized; the group entrypoint
must still identify every unfinished task before handing them off individually.
