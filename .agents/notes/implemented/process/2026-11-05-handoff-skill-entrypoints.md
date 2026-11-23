# Agent Note: Task and Goal Handoff Entrypoints

Status: implemented

## Problem

Requests to hand off one task or all unfinished tasks in a task group identify
different targets. Agents needed discoverable entrypoints for both without creating
another owner for the rules governing task handoff.

## Decision

The repository originally provided the `handoff-task` and `handoff-goal` skills
as discoverable entrypoints for a user-specified task and every unfinished task
in a user-specified group. Each used `development-workflow` directly, leaving its
handoff workflow and safeguards centralized. The [content-sufficient handoff
decision](../../archived/process/2026-10-25-task-content-handoff.md) records their
original rationale.

The [retirement decision](2026-11-13-retire-handoff-entrypoints.md) replaces
these entrypoints. The current [handoff workflow](../../../skills/development-workflow/references/handoff.md)
remains the owner of the per-task process.

## Alternatives

**Repeat the handoff workflow in each entrypoint.** Separate copies of review,
permission and reconciliation rules could diverge from their existing owner.

**Have the group entrypoint depend on the single-task entrypoint.** Both targets
already used the same handoff workflow, so the extra dependency added indirection
without providing a distinct rule.

## Consequences

The entrypoints expressed target selection while `development-workflow` controlled
each handoff. Changes to the shared workflow remained centralized, and the group
entrypoint still had to identify every unfinished task before handing them off
individually. Their retirement removes those discoverable wrappers; the current
Goal selection contract is recorded in the [Goal workflow decision](2026-11-11-real-goal-workflow.md).
