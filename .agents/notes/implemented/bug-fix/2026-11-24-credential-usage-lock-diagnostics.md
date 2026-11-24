# Agent Note: Credential Usage Lock Diagnostics

Status: implemented

## Problem

Background credential metadata deliberately gives way to foreground row locks.
The [lock recovery decision](../architecture/2026-11-23-credential-usage-lock-recovery.md)
keeps a recovered NOWAIT refusal from failing shutdown, but retained intermediate
fault summaries still produce application errors for ordinary, recoverable
contention. A batch can contain samples with different remaining attempt budgets,
so suppressing its entire diagnostic would also hide samples actually lost.

## Decision

The Recorder passes its existing pure, confirmed-uncommitted lock-conflict
classification to the Sampler. The Sampler retains a flush fault for that
classification only when the individual sample is abandoned. A sample still
eligible for retry produces no intermediate application diagnostic at any level.
The three-attempt budget, one-second retry interval, pending observations and
failure counters remain unchanged.

Cancellation, deadlines, independent joined errors and transaction cleanup
failures cannot receive this classification. Other failures and independent lag
faults retain their diagnostics. An exhausted sample retains the final SQLSTATE
and original drain cause; unknown transaction outcomes remain unreplayed.
The [authentication design](../../../../docs/design/daynight-auth.md#凭据使用记录器)
owns the current recording and diagnostic behavior.

## Alternatives

**Lower the log level or filter SQLSTATE globally.** Normal recoverable attempts
would still produce logs, and a global filter could hide exhaustion, unknown
outcomes or cleanup failures carrying the same SQLSTATE.

**Suppress the complete batch when contention is recoverable.** Samples in one
batch can have different attempt counts. This would hide the diagnostic for an
older sample that exhausted its budget while another sample remains retryable.

## Consequences

Recovered contention no longer occupies fault-summary capacity or emits noisy
application errors. Failure counters still include these attempts. Final loss
remains observable per sample, and database/server logging configuration is
unchanged. Intermediate pure lock conflicts have no application log history;
only exhaustion retains their diagnostic.
