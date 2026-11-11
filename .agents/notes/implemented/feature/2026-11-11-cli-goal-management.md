# Agent Note: CLI Goal Management

Status: implemented

## Problem

Goal and Task resources share identity and materials, but callers need to create
Goals and manage Task membership without confusing membership with dependency
chains or losing the distinction between an omitted field and an explicit clear.

## Decision

The existing Task commands select Goal type and accept a Parent UUID or `none`.
The query form of `none` selects unassigned Tasks; the write form sends null.
Omission preserves the server's create defaults or leaves an update unchanged.
Terminal Goal creation uses the same impact confirmation as terminal status
changes, with `--force` bypassing only that client confirmation. Explicit write
versions remain authoritative and unknown writes are not replayed. The CLI
manual owns the command details; the [typed resource decision](../architecture/2026-11-11-typed-task-resources.md)
owns the shared identity and existing ID-based safeguards.

## Alternatives

No additional alternative was considered for this implementation; the shared
Task commands and presence contract were selected in the Goal architecture.

## Consequences

The same commands address both types while the server remains authoritative for
Goal capabilities and Parent validity. Callers must explicitly select Goal type
for Goal creation and queries; existing ordinary Task defaults remain intact.
