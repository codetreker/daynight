# Agent Note: Retire Task and Goal Handoff Entrypoints

Status: implemented

## Problem

Dedicated task and Goal handoff skills expose separate routes to a process already
owned by the development workflow. Maintaining those routes alongside their owner
can leave discovery and guidance inconsistent, while Goal handoff still requires
explicit target selection and independent checks for each Task.

## Decision

The repository no longer exposes the `handoff-task` or `handoff-goal` skills.
The [development workflow](../../../skills/development-workflow/SKILL.md) owns
handoff through its [handoff workflow](../../../skills/development-workflow/references/handoff.md)
and [Goal protocol](../../../skills/development-workflow/references/goal.md); the
`using-daynight` manual owns product operations. The [Goal workflow decision](2026-11-11-real-goal-workflow.md)
retains the Goal target selection and per-task boundaries.

This replaces the [entrypoints decision](2026-11-05-handoff-skill-entrypoints.md),
which records why the separate discoverable routes were originally adopted.

## Alternatives

**Retain the dedicated entrypoints.** They make the two targets discoverable,
but keep additional routes synchronized with a workflow that already owns the
handoff rules.

**Remove the entrypoints without preserving their contracts.** That would leave
broken references and lose Goal membership and per-task authority boundaries.

## Consequences

Task handoff uses the shared workflow, and Goal handoff applies it to each
selected unfinished direct child. The separate discovery routes disappear, so
readers use the development workflow and product manual for the process. Goal
membership and permission checks remain explicit without another wrapper skill.
