# Agent Note: Bounded Webhook Retention

Status: implemented

## Problem

Webhook histories and retired configuration must eventually release storage without losing material needed by active deliveries, late observations, operation receipts or a capture that has frozen its audience but has not committed. A single delivery can have an unbounded number of original matches.

## Decision

The maintenance component closes eligible history under Delivery then Attempt locks before deleting children in bounded batches. It checks shared Event references and retains original hashes after payload expiry. Separate configuration and receipt collectors preserve their own lock prefixes. A transaction snapshot barrier drains captures that could have observed a retired identity before configuration reclamation; capture requires an assigned transaction ID and Read Committed. The [retention design](../../../../docs/design/webhook-retention.md) describes the lifecycle and failure handling. Master rewrapping and recovery are described in the [key maintenance design](../../../../docs/design/webhook-key-maintenance.md).

## Alternatives

**Delete a complete delivery atomically.** Its match count has no configured bound, so one delete cannot also guarantee a bounded maintenance batch.

**Delete configuration after one empty reference query.** A capture may have frozen an older committed audience and subsequently commit a new reference; the query alone cannot see that in-flight transaction.

**Use a zero-reference scan as a master retirement decision.** A still-running producer or a retained backup may require the old key after the scan.

## Consequences

Closed history can be reclaimed across process exits without confusing a partially deleted proof with an active one. Long transactions can delay configuration collection, and the snapshot barrier is reacquired after restart. Key retirement requires evidence from the deployment and backup owners in addition to the database scan. Application composition and combined management API acceptance remain separate responsibilities.
