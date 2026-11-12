# Agent Note: Goal-owned workflow materials

Status: implemented

## Problem

A multi-stage objective needs an identity independent of its execution graph and a
stable place for shared requirements, architecture and acceptance. Dependency
chains can cross objectives, and stage tasks can finish before later consumers
need their materials. The earlier [Goal workflow](../../archived/process/2026-10-22-goal-workflow-design.md)
and [spec confirmation](../../archived/process/2026-11-02-goal-spec-confirmation.md)
used an ordinary requirements task as the entry and material owner, before typed
Goal resources existed.

## Decision

The [Goal protocol](../../../skills/development-workflow/references/goal.md)
uses a real Goal as the container and shared material owner. Ordinary stage and
delivery tasks identify it through Parent. Producing tasks retain responsibility;
each delivery brief identifies both the architecture producer and the Goal and
paths holding its required shared sources. Confirmation, ordinary dependencies
and registration-before-completion remain stage gates on ordinary tasks.

The CLI and MCP product materials guides define the general ownership rule:
effective shared specifications, architecture, breakdowns, decisions, outcomes
and overall progress belong to the Goal regardless of which Session or child
Task produces them. Users update and verify that material when conclusions or
important progress change; child status accounting does not synchronize it.
Task-specific results and evidence remain with their producer. Required stage
tasks, files, confirmation and delivery gates follow the target project.

[Goal handoff](../../../skills/handoff-goal/SKILL.md) selects direct ordinary
children by Parent, checking each task independently. Dependencies can cross a
Goal boundary without transferring the other Goal's work. The public CLI manual
explains product operations and material ownership; repository stage policy
remains in development-workflow.

## Alternatives

**Keep an ordinary task as the container and material owner.** This conflates
execution and membership, cannot represent an empty Goal, and makes cross-Goal
dependency chains ambiguous as membership.

**Copy shared material into each successor.** Copies can diverge and obscure the
actual source; direct producer and Goal references keep indirect successors able
to find the confirmed material without duplicating it.

## Consequences

Goals can exist before their first discussion task and keep shared material after
stage completion. Existing tasks and materials are not migrated or inferred from
titles. The workflow must explicitly preserve source identities, stage gates and
per-task authority; a Goal's assignee does not authorize changing its children.
