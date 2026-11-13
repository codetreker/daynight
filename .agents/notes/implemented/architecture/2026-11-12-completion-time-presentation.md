# Agent Note: Completion time presentation

Status: implemented

## Problem

Readers need to distinguish when a Task or chain completed from how long an
execution took. Existing Task rows already act as buttons, while a chain
represents multiple Tasks and has no detail page for its aggregate time. A
hover-only timestamp would exclude touch users, and nested controls would break
existing row interaction and accessibility.

## Decision

Task and Goal rows display a non-interactive completion label and attach the
exact time to the existing entry description; their details expose the exact
value. Project Goal disclosures reuse Task rows and scoped chain summaries. Goal
detail displays its own exact completion time in the common metadata row,
independently of child progress; task browsing remains in the project Goal list.
Chain summaries use their complete scoped members and provide a separate time
button in the metadata below the title, as described in the
[chain layout decision](2026-11-13-chain-completion-time-layout.md). Its tooltip
remains in the owning DOM subtree and uses a manual popover to escape clipping
without becoming a modal. The
[completion time design](../../../../docs/design/daynight-completion-time.md)
owns interaction, positioning and lifecycle details. The
[shared clock decision](2026-11-12-shared-completion-clock.md) owns time
sampling and scheduling.

## Alternatives

**Add a separate button to every row.** Task rows already open details where
touch users can read the exact time. Additional buttons would add focus stops
and complicate existing row controls without adding necessary access.

**Use a body portal for the tooltip.** A portal can leave the owning dialog's
inert and focus boundary. A manual popover retains DOM ownership while escaping
clipping.

## Consequences

Task navigation and chain expansion remain distinct from completion-time
reading. Tooltip positioning, owner-aware Escape handling and cleanup add local
interaction state. Task, chain and Goal consumers share this mechanism. Goal
facts remain independent of child progress, and project Goal chain summaries use
only their complete owned scope. The [Goal detail information decision](../feature/2026-11-12-goal-detail-information.md)
keeps those rows and summaries in the outer list while retaining the Goal
resource completion field.
