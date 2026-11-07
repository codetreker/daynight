# Agent Note: Bounded CI retries

Status: implemented

## Problem

A CI failure can require another observation before its cause is understood.
Requiring proof of transient infrastructure before any rerun prevents that
observation, while unbounded reruns can hide recurring failures and consume
runner capacity.

## Decision

The [repository instructions](../../../../AGENTS.md#validation-and-delivery) and
[managed delivery reference](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/autopilot-managed-task.md#sustain-complete-delivery)
permit at most two additional runs of each failed check on the same commit after
its failure logs are inspected. The initial run is excluded; sessions, restarts
and workflow reruns share the same retry count. Proof of transient infrastructure
is not a prerequisite. If both retries fail, the cause must be diagnosed and
repaired before further validation.

A successful retry establishes the observed result, not the root cause. Required
checks and acceptance criteria remain unchanged, and retries and observed results
are reported. This replaces the retry restriction recorded in the
[Web quality isolation decision](../../archived/testing/2026-10-26-web-quality-job-isolation.md#consequences)
without changing its job isolation or deadlines.

## Alternatives

**Require a proven transient infrastructure cause before every rerun.** This was
the earlier rule and limited attempts to obtain a passing result without a fix.
It also prevented a bounded observation when the cause was still unknown.

**Allow unlimited reruns.** This can conceal recurring failures and has no
predictable runner cost or point at which diagnosis and repair become mandatory.

## Consequences

An unchanged check has at most three total attempts, including its initial run.
Retry history must survive delivery-session changes. Repeated failure still
requires a repair, and a passing retry leaves any unconfirmed cause unresolved.
