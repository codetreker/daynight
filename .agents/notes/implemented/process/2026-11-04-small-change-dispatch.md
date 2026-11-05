# Agent Note: Small-change task dispatch

Status: implemented

## Problem

A short change request can omit the expected behavior, implementation boundary
or observable verification. Passing it directly to an implementing agent leaves
that agent to make requirement decisions. Platform requirements can also be
overstated by copying the current machine's OS, or understated when native
verification is necessary. A clear request should reach execution without
repeating task preparation and handoff decisions in every conversation.

## Decision

The repository-local [dispatch-small-change skill](../../../skills/dispatch-small-change/SKILL.md)
prepares one bounded, independently verifiable outcome. It reads relevant
implementation and requirements, checks existing work, and records the problem,
reason, scope, confirmed solution constraints, necessary sources and observable
acceptance. Unknown implementation details remain implementation work when the
target behavior is clear; consequential requirement decisions are clarified
before handoff.

The skill composes the canonical
[using-daynight workflows](../../../../packages/daynight/src/commands/skill/skills/using-daynight/SKILL.md).
Creation, task-content sufficiency, exact-version writes and handoff retain
their existing owners, including the
[content-sufficient handoff](2026-10-25-task-content-handoff.md) and
[account responsibility](2026-11-04-cli-create-default-assignee.md) decisions.
Discussion-only and registration-only requests retain their boundaries.

The existing requiredPlatform field expresses only the OS required for
implementation or verification. It stays unrestricted when no specific OS is
needed. Cross-platform verification requires a viable source of all necessary
evidence; a single enum value does not claim that several native environments
are available. Agent selection remains a Worker concern.

Successful handoff and readback are the skill's completion condition. The
Worker owns implementation and delivery. A handoff receipt distinguishes
automatic permission, actual execution ownership and completed delivery.

## Alternatives

**Copy task creation and handoff rules into the new skill.** This would make it
independent of workflow references but introduce a second owner for assignment,
state, concurrency and uncertain-write behavior. Composition keeps those rules
consistent with the existing CLI and Worker contract.

**Wait for a Worker claim before returning.** This would provide an execution
start observation, but completion would depend on Worker availability and
scheduling capacity after the task is already ready for automatic selection.
Verified handoff gives a bounded result without implying that execution started.

## Consequences

Small-change preparation has a discoverable repository entrypoint while existing
task and Worker behavior remains authoritative. It adds no runtime, task fields
or provider routing. The skill depends on the canonical workflow references
remaining readable and current.

The workflow exposes missing requirements and platform verification gaps before
automatic execution. A successful handoff can still leave the task awaiting a
compatible Worker or prerequisite completion. Monitoring implementation is a
separate responsibility; the receipt must not present enablement as delivery.
