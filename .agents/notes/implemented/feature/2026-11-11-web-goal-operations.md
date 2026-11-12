# Agent Note: Web Goal Operations

Status: implemented

## Problem

Goal resources and Task membership can be changed through the API, but people
using the Web need to organize work without losing drafts or confusing a Goal's
state with the state of its children. Concurrent edits and lost responses also
make an apparent write result insufficient evidence of the committed state.

## Decision

Goal detail uses the existing Task detail session for versioned edits, ownership,
status and deletion. Task membership changes use the child Task's version and
the same session. Goal and Task creation use the typed API and preserve explicit
Parent and owner choices. Confirmations describe the different effects of ending
and deleting a Goal. The [Goal requirements](../../../../docs/spec/daynight-goals.md)
own the user-visible contract. The original Task detail membership editor was
later replaced by the [read-only Goal link](../simplification/2026-11-12-task-detail-goal-link.md);
Goal creation and adding existing Tasks retain their membership operations.

Goal detail shares the compact status menu with Task detail and places it beside
the assignee while retaining progress in the metadata row. The menu takes the
Goal-specific four states and permits reopening cancelled Goals; ordinary Tasks
retain their five states and cancelled lock. Goal terminal choices retain their
confirmation and reviewed version, while nonterminal changes use the current
detail version. The archived [compact Task header decision](../../archived/simplification/2026-10-24-compact-task-detail-header.md)
records the original Task control allocation.

## Alternatives

**Create a separate Goal mutation session.** A parallel owner would duplicate
version admission, unknown-result reconciliation and deletion retirement, and
could publish an old detail after the shared resource history has changed.

**Keep the separate native Goal status field.** It preserves the Goal lifecycle,
but its labeled, larger control differs from the adjacent Task detail status
interaction and provides a different keyboard interaction.

## Consequences

A shared menu keeps presentation and keyboard behavior consistent while each
resource supplies its own status choices and lifecycle policy. Goal operations
retain the existing resource identity and material lifecycle.
Parent changes do not rewrite dependency edges or child execution state. An
unknown write requires observation and a new user decision rather than an
automatic replay; this can require extra interaction after a lost response.
Confirmed Parent receipts and statuses of Goals and their Tasks bridge the
in-memory view until sync catches up; identity and history fences prevent them
from restoring retired content.
The persisted sync remains authoritative for dependency projections.
