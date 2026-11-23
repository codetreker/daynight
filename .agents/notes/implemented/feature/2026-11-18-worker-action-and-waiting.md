# Agent Note: Worker action and waiting guidance

Status: implemented

## Problem

A background Worker can repeatedly report no new activity while an existing CI
failure or review finding remains actionable. Ending a turn can also cause a
watchdog to wake the execution again without advancing it. A blocker that needs
external resources or input may not be a design conflict, yet cannot be resolved
by repeated waiting or autonomous adjustments.

## Decision

The full assignment uses shared execution guidance for startup, continuation and
periodic input. It directs the agent to inspect current CI, reviews and approval,
act on existing failures and feedback, and wait with a bounded delay only when
no actionable work remains. It describes watchdog continuation subject to the
original assignment and automatic continuation conditions.

When a genuine blocker cannot be resolved autonomously and requires external
input, permission, resources or a decision, the agent records its evidence and
attempts, confirms a pause and returns control. Resumption requires verifying the
original assignment, resolution and authorization. Ordinary recoverable problems
and normal CI or review waits alone do not justify pausing. The [Worker
specification](../../../../docs/spec/daynight-worker.md) owns the full contract.

This replaces the narrower intervention threshold in the [autonomous execution
decision](2026-11-11-worker-autonomous-execution.md), while preserving its limits
on changing confirmed goals, scope, acceptance and authorization.

## Alternatives

**Retain the severe design-conflict threshold.** It discourages unnecessary
intervention but cannot represent an unavailable external resource or permission
that is genuinely required to proceed.

**Replace startup text alone.** Continuation or ping could then reinstate the old
threshold, making the instructions depend on which input arrived last.

## Consequences

All business prompt paths share the new rules; existing fixed inputs retain their
original delivery identity. The change does not add a watchdog, scheduler, ping,
state transition or input delivery mechanism. Tests establish emitted wording and
packaging, not that every model will correctly diagnose a failure.
