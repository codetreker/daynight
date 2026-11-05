# Agent Note: Separate Worker orchestration blocks from native recovery

Status: implemented

## Problem

A healthy native Session can outlive a temporary mismatch between its managed
worktree and original branch. The worktree check correctly rejects advancement,
but counting that rejection as native recovery exhaustion makes the Session
unavailable after the branch is restored. A persisted recovery report can then
disable history and input even while the same native generation keeps working.

## Decision

Web orchestration failures have their own durable classification and original
execution identity. They do not consume native recovery attempts. The Worker
rechecks recoverable conditions while retaining every worktree ownership guard;
a trusted original Controller remains observable and independently renewable.
Native recovery pauses retain their existing stop-proof and explicit-retry gates.

Resuming orchestration requires the complete original worktree binding, private
launch identity, authenticated live observation, native identity and process
instance proofs. It clears only the matching block and advances the startup
report revision atomically. It does not prepare or launch a Controller, change
generation, replay submitted input or reset native recovery count. An unfinished
first launch may bind its native identity from the authenticated original
Controller and submit the original operation only when both durable and live
observations prove it has not been submitted. Unknown delivery stays fenced.
An allocated retry completes on the same healthy generation; its retained
authorization flag does not authorize or require another replacement.
A proven stopped original generation can hand back to the existing native
recovery path, preserving its pause, budget and authorization checks. Clearing
an orchestration block does not grant a replacement writer.
The [Worker design](../../../../docs/design/daynight-worker.md#web-backend-与执行证据)
owns the checks and persistence format.

Legacy correction is restricted to the known branch-check misclassification.
The old report, zero native count below the frozen limit, matching historical
Worker errors and current original-generation health must agree. Historical
logs establish the classification source only; they cannot authorize process
replacement or substitute for current ownership. Their bounded correlation
window includes the old producer's capability and summary request deadlines:
its final diagnostic is emitted after those requests, not when the report is
persisted. Missing or ambiguous evidence
keeps the pause visible.

The existing startup report describes native startup and recovery, while the
Worker waiting phase describes orchestration. No wire field or UI layout is
added. Healthy history and native input retain their existing independent
connection, permission and identity checks. The previous
[recovery pause decision](2026-11-04-web-recovery-pause.md) remains authoritative
for actual native failures; its ordinary-failure classification is superseded.
The [startup observation decision](2026-11-05-session-startup-observations.md)
continues to own report identity and ordering.

## Alternatives

**Remove the worktree guard or trust a connected Session.** A live transport does
not prove that the directory, claim or native process still belongs to this
execution. Neither fact permits unsafe advancement, replacement or cleanup.

**Clear every zero-count recovery pause.** Native identity and stop-proof errors
can occur before consuming a recovery attempt. A narrow source check plus live
identity verification avoids turning unrelated unknown failures into authority.

**Change only the UI or add a new report state.** UI changes would leave the
Worker locked and could hide real native failures. The existing ready/none
report already represents the healthy native state; local orchestration needs
its own persistence without expanding the Session protocol.

## Consequences

Temporary worktree drift can recover within the same native generation without
disturbing another task. Native budget exhaustion and uncertain writer identity
remain blocked. The local SQLite upgrade is additive and preserves execution
records; older binaries reject the upgraded version rather than misreading it.
There is no wire upgrade or new server rollout dependency.

Legacy correction depends on retained diagnostics. Missing logs or conflicting
identity require explicit investigation; this mechanism cannot reconstruct
arbitrary historical causes. Normal worker shutdown still stops owned native
processes, so a graceful restart is not evidence of uninterrupted generation
recovery. Runtime acceptance must distinguish controlled service fixtures from
real provider execution and production recovery.
