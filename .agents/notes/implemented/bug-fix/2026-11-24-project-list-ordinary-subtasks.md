# Agent Note: Ordinary Subtasks in Project Lists

Status: implemented

## Problem

Ordinary subtasks share the project dependency graph with top-level Tasks. Treating
all Tasks without a Goal as project list members duplicates nested work and lets
subtask-only components, status, and activity appear as top-level work. Older
persisted summaries may omit the ordinary-parent field, so their absence does not
establish that a Task is top-level.

## Decision

The project standalone and chain lists classify the complete ordinary dependency
graph first, then select Tasks without either direct parent. A multi-member
component remains a chain even when one eligible member remains; an empty scope
produces no row. A subtask representative uses the earliest eligible member for
the project list title while graph and navigation retain real identities. List
matching and summaries use the eligible scope, while the full graph, project
statistics, Goal membership, search and direct Task reading retain their own
boundaries. Ordinary subtasks do not independently trigger the chain Worker
indicator. The [Web specification](../../../../docs/spec/daynight-web.md) owns
presentation and navigation.

The cache preserves unknown ordinary-parent facts and verifies older summaries by
a complete online delta at the current epoch. Same-version missing facts can be
filled without inventing a business version or discarding details; known values
cannot be downgraded and contradictory known values fail. The [sync design](../../../../docs/design/daynight-task-sync.md)
owns admission and legacy-server behavior.

This narrows project list presentation from the full-component title and activity
rules in the [Goal browsing decision](../feature/2026-11-11-goal-browsing.md)
and [Worker indicator decision](../feature/2026-11-11-chain-active-worker.md).
Their original cross-Goal rationale and complete graph identity remain applicable.

## Alternatives

**Filter before constructing dependency components.** This would break real
chains into separate rows or classify a remaining member as standalone, losing
the actual dependency context and navigation identity.

**Treat missing parent fields as null.** Old cached summaries could display nested
work as top-level indefinitely because incremental windows need not include the
old rows. A complete online read establishes the fact without per-Task requests.

## Consequences

Lists reflect direct ownership without changing dependencies or service records.
A complete verification read costs a project-sized response when legacy cached
facts are unknown; normal incremental sync resumes after verification. The graph
and direct detail retain nested Tasks and their real edges, while list counts and
progress no longer describe the entire component when subtasks are present.
