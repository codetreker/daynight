# Agent Note: Worker Fresh Session Information

Status: implemented

## Problem

Every newly claimed task starts with a NULL native session ID. Logging that
state as a warning makes a normal first launch appear to require attention. The
same launch path also handles recovery when no native session ID was saved.

## Decision

The worker emits `kind: "info"` with the message `Starting a new native
conversation in the task worktree.` before starting a NULL-ID conversation.
The event remains correlated with the task and claim in stderr and JSONL.
Known IDs still select resume, and live agents still reconnect without starting
another conversation.

This supersedes only the warning classification in the [claim-records decision](../simplification/2026-10-27-worker-claim-records.md).
Its NULL-ID startup behavior and persistence limits remain in force.

## Alternatives

**Keep Warning for a NULL ID.** This exposes a possible loss of continuity during
recovery, but it also warns on every ordinary first launch. A NULL ID alone does
not establish that a previous conversation existed or that anything failed.

## Consequences

Normal fresh launches remain visible without creating false warnings. Recovery
with a NULL ID can still lose continuity with an earlier conversation. Known-ID
resume failures and conflicting observed IDs remain visible errors.
