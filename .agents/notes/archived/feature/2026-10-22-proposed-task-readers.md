# Agent Note: Four-State Task Readers

Status: implemented

## Problem

An approval stage requires tasks to remain visible before they become actionable.
A valid new stored state cannot be activated while CLI or Web response decoders
reject it, project summaries omit it, or chain badges misrepresent its progress.
Existing task rows, revisions and timestamps must survive the representation
change without a data rewrite.

## Decision

The original reader preparation made a future stored proposed state readable
before public creation could produce it. Migration 007 widened the status CHECK
without rewriting task rows, versions or timestamps. It prepared service task/list/
graph projections, required proposed summary counts, CLI four-state filters and
unfinished ordering, distinct localized purple presentation and the proposed-only
chain fallback. A later [approval lifecycle](2026-10-22-task-approval-lifecycle.md)
enabled proposed creation and dedicated writes after all readers were ready.

The [three-state assignment decision](../architecture/2026-10-24-task-status-assignment.md)
supersedes this fourth state. Migration 014 reclassifies every proposed row to
todo once, retaining all other facts and advancing only converted revisions and
update time. Current service/CLI/Web readers reject proposed, expose six summary
counts, order unfinished work without a fourth group and use the three-state
chain aggregation. Applied 007 remains unchanged as genuine schema history.

The durable preparation principle is coordinated stored-format and consumer
delivery: all active callers/readers change with the migration. Runtime fallback
does not substitute for data conversion. External prerequisite context remains
outside chain progress, and each project task contributes once to statistics.
Current requirements and architecture own exact fields and runtime behavior.

## Alternatives

**Activate new creation and lifecycle operations with the reader change.** That
would combine stored representation, all consumers and mutation policy in one
review. Preparing the final reader representation first keeps every valid new
state consumable before public creation can produce it. Approval, claim,
completion and the new creation default were kept in the separately delivered
lifecycle so that valid new rows could not reach unprepared consumers.

**Expose proposed through a temporary generic status input.** The list and update
paths share status validation. Allowing that input during reader preparation
would also permit status writes before approval rules exist. Retaining the
existing validator avoids a temporary split that lifecycle activation must undo.

## Consequences

The original staged rollout prevented an unreadable state from appearing in
already shipped consumers and introduced no public generic status write. Its
specific four-state resources and presentation are historical. The successor
coordinates the inverse operation: migrate the removed state, reject old protocol
values, and retain truthful task counts, dependency readiness and pagination.
Historical migration fixtures pin the original migration prefix; current fixtures
exercise the current schema without preserving runtime compatibility branches.
