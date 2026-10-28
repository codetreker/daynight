# Agent Note: Worker Log Transitions

Status: implemented

## Problem

Every reconciliation round observes existing agents and retained resources.
Reporting an unchanged observation each time floods both the foreground output
and JSONL, making real transitions and failures difficult to find. Concurrent
claims also interleave messages, so consecutive-line comparison cannot identify
stable state reliably.

## Decision

Execution decides when its observations become diagnostic events. The [worker design](../../../../docs/design/daynight-worker.md#观测关联和错误)
owns their reporting state and lifecycle. The diagnostics writer retains its
ordered output, credential redaction and error propagation responsibilities.
The [foreground runtime decision](../architecture/2026-10-27-foreground-worker-runtime.md)
retains ownership of runtime composition and correlated diagnostics.

Execution keeps one observation baseline per claim in memory. Stable polls and
native idle/working activity stay quiet; phase, terminal, session and deferred
input transitions remain visible. A successful start establishes the baseline
without hiding subsequent actual starts or recoveries. This decision originally
compared resource-preservation warnings across successful discoveries so a
resolved warning could be reported when it recurred. The later
[resource recognition decision](2026-10-28-worker-resource-recognition.md) removes
those warnings: unrecognized resources are silently excluded, while actual
managed-resource integrity failures remain errors.

Actual operations and failed attempts retain their events and original errors.
The reporting state is process-local and never supplies recovery authority.
Suppressing events before the common writer keeps foreground and JSONL output
consistent.

## Alternatives

**Deduplicate formatted lines in the diagnostics writer.** Interleaved tasks
break consecutive-line comparison, and the writer does not own native terminal,
phase or successful-discovery facts. Permanent per-message suppression would
hide a warning or waiting state that clears and later returns.

**Rate-limit all events by elapsed time.** A time window can hide an immediate
transition or a distinct failed attempt while still printing unchanged state
periodically. State changes provide the relevant reporting boundary without a
new interval setting or timer.

## Consequences

Routine polling stays quiet while first observations, recurring transitions,
real operations and failures remain visible. Observation baselines consume
memory only in the running process; restart reports the initial state again.
Logs remain diagnostics rather than a record of every polling round.
