# Agent Note: Withdraw Task Approval Before Execution

Status: implemented

## Problem

An accepted task may need further review before execution begins. The original
approval lifecycle provided no supported way to withdraw that acceptance, so a
premature approval could only remain actionable or be corrected outside the
normal versioned API. Concurrent task selection also requires a withdrawal to
compete with claim without cancelling work that has already started.

## Decision

The original withdrawal delivery added a versioned todo-to-proposed unapprove
action to the [approval lifecycle](2026-10-22-task-approval-lifecycle.md). Ready
and blocked todo qualified; active/done did not. It reused project locking,
membership and exact version checks, preserved all materials and timing, and
did not change successors or release active work. Same-version withdrawal/start
and withdrawal/withdrawal had one winner; a blocked start refusal did not prevent
withdrawal. HTTP authentication, Origin, no-store and strict parsing, CLI project
selection, lossless versions and no-retry behavior shared existing owners.

The [three-state assignment decision](../architecture/2026-10-24-task-status-assignment.md)
supersedes that public route and its approval meaning. Runtime tasks now default
to todo, use one status setter, migrate legacy proposed rows and reject the deleted
state. This note retains withdrawal's original rationale and the client ownership
mechanisms that continue under status/allowAgents.

The original Web extension put task-specific confirmation in a common header,
available on both tabs. Confirmation froze resource, source, target and exact
version, invalidated on known changes, focused Cancel first, kept the lower dialog
inert and restored focus without a write on cancellation. One session/confirmation
owner preserved pending and unknown outcomes across close/reopen and prevented
competing submissions. Exact target/version responses, confirmed revision floors,
GET-only reconciliation, identity isolation and mounted attachment reading remain
part of the successor. A graph-refresh failure cannot restore old detail.

The body reserves reading space among panels, shrinkable context and independently
bounded errors. The [compact header decision](../simplification/2026-10-24-compact-task-detail-header.md)
owns full-title bounded native scrolling. This allocation preserves tabs, materials
and actions when long titles and errors coexist, across narrow screens. The
current menu/confirmation behavior is specified in the Web and status documents.

## Alternatives

**Restore generic status editing.** Arbitrary updates would again allow callers
to bypass approval or claim and would require a reopening policy for active and
completed tasks. A single predecessor-constrained action provides withdrawal
without restoring those paths.

**Correct individual approvals directly in the database.** A one-off correction
would not provide a supported operation for future mistakes and would bypass
the normal membership, version, transaction and client error handling. The same
public action serves both deliberate corrections and ordinary future use.

**Cap the title using viewport subtraction.** Limiting only the heading text
cannot reserve reading space when retained-error and stale notices also consume
the fixed dialog. Allocating the actual body between panels, shrinkable context
and bounded errors covers their combined height while preserving full text.

## Consequences

The original narrow withdrawal avoided reopening active/completed work and
introduced no migration. Its preservation of materials, successor independence,
exact decision versions and uncertain-result handling remains valuable. Task
approval and withdrawal are removed by the successor; they no longer restrict
status setting or add execution barriers. Status still grants no delivery rights
and cannot stop a process or transfer ownership.

Production acceptance proves actual service persistence, version races, refusal
and uncertain outcomes separately from frontend-only appearance and interaction.
Bulk mutations and process cancellation remain independent state/permission
decisions. The later [worker force-withdrawal decision](../architecture/2026-10-27-worker-force-withdrawal.md)
provides a separate claim reset and automatic-permission change with an explicit
delayed-stop boundary.
