# Agent Note: Credential Usage Lock Recovery

Status: implemented

## Problem

A background metadata batch can encounter an authorization transaction's shared
credential lock. The NOWAIT refusal is a confirmed rollback, but retaining every
intermediate failure as a permanent drain cause makes a recovered batch fail
application shutdown. An unknown transaction outcome cannot establish rollback
and must not be replayed as though it had failed to commit.

## Decision

A pure confirmed uncommitted `55P03` failure becomes a diagnostic and a drain
cause only when the individual sample exhausts the existing three-attempt budget.
The original recovery decision retained intermediate diagnostics; the
[diagnostic decision](../bug-fix/2026-11-24-credential-usage-lock-diagnostics.md)
makes still-retryable contention silent while preserving final loss evidence.
Cancellation, deadlines, cleanup failures, other database failures and
committed cleanup errors retain their existing drain semantics. Unknown outcomes are abandoned
without replay; a newer event already admitted during the write remains a separate
candidate. The [recorder](2026-11-12-credential-usage-recorder.md) and
[sampler](2026-11-12-credential-usage-sampling.md) decisions retain their lifecycle
and bounded-state responsibilities.

## Alternatives

**Wait for the row lock or add retries.** Waiting can interfere with foreground
authorization and extending the budget delays shutdown. The existing NOWAIT and
bounded schedule already permit recovery from brief contention.

**Retry unknown outcomes because the timestamp update is monotonic.** An unknown
result does not establish rollback; monotonic updates do not supply a durable
submission identity or a reconciliation result.

## Consequences

A successful retry after lock contention no longer poisons shutdown, while an
exhausted or unknown sample remains observable as unconfirmed. Unknown outcomes
may have committed despite being counted as abandoned. Fault summaries still
retain the safe SQLSTATE and the original error chain remains available on drain
when recovery fails.
