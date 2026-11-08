# Agent Note: Bounded Webhook Retention

Status: implemented

## Problem

Webhook histories and retired configuration must eventually release storage without losing material needed by active deliveries, late observations, operation receipts or a capture that has frozen its audience but has not committed. A single delivery can have an unbounded number of original matches.

## Decision

The maintenance component closes eligible history under Delivery then Attempt locks before deleting children in bounded batches. It checks shared Event references and retains original hashes after payload expiry. Separate configuration and receipt collectors preserve their own lock prefixes. The global overlap-key expiry scan has a partial btree index on `(overlap_until, endpoint_id, id)` for `slot = 'overlap'`; the query supplies the current time, keeping the index predicate immutable. [Logical receipt expiry](../bug-fix/2026-11-08-webhook-receipt-results.md) is enforced by the management service independently of collection progress. A transaction snapshot barrier drains captures that could have observed a retired identity before configuration reclamation; capture requires an assigned transaction ID and Read Committed. The [retention design](../../../../docs/design/webhook-retention.md) describes the lifecycle and failure handling. The [plaintext storage decision](../simplification/2026-11-08-webhook-plaintext-storage.md) replaces the initial master-key maintenance design; target snapshots follow their existing Delivery retention.

## Alternatives

**Delete a complete delivery atomically.** Its match count has no configured bound, so one delete cannot also guarantee a bounded maintenance batch.

**Delete configuration after one empty reference query.** A capture may have frozen an older committed audience and subsequently commit a new reference; the query alone cannot see that in-flight transaction.

**Reuse only the endpoint-and-slot unique index for expiry scans.** That index serves a fixed endpoint's bounded signing set. The collector searches expiry across endpoints, so its time-range filter needs an expiry-leading index.

**Use a zero-reference scan as a master retirement decision.** The initial encrypted design rejected this shortcut because a still-running producer or retained backup could still require the old key. That rationale applies if application-level encryption is reconsidered; current plaintext retention has no master-key retirement lifecycle.

## Consequences

Closed history can be reclaimed across process exits without confusing a partially deleted proof with an active one. Long transactions can delay configuration collection, and the snapshot barrier is reacquired after restart. Overlap inserts, rotation updates and removal maintain an additional index; current keys do not occupy it. Retained targets and signing secrets remain readable to database and backup readers until their own records are reclaimed. The [application runtime](2026-11-08-webhook-application-runtime.md) owns composition and coordinated shutdown.
