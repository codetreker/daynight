# Agent Note: Webhook History Batch Reads

Status: implemented

## Problem

A historical Delivery view needs its immutable event and proof, current resource and owner facts, destination revision and retained Attempts. Reading those inputs separately for every candidate multiplies database round trips even when a filtered page is empty. Page limits constrain returned items while the candidate range may be much larger.

## Decision

History lists use three typed collection reads per nonempty candidate batch within the existing read-only Repeatable Read snapshot. The first selects up to 100 ordered Delivery candidates and their one-to-one facts. The other reads fetch all original Matches with current references and all required Attempts for exactly those Delivery IDs. Child collections are grouped once by Delivery ID, and the original parent slice determines page order. Empty candidate batches need only the first query.

SQL owns data access, nullable presence and membership/grant facts. A shared pure eligibility rule and the existing Go proof, protocol, hash and projection rules own decisions. Missing immutable events and damaged proof remain errors; LEFT JOIN preserves absence rather than dropping the Delivery. Full disclosure, current eligibility, any-continuous-match semantics, suppressed projection and last-returned cursors retain their independent meanings.

The main query supplies one database statement timestamp for the batch's fact/payload checks and availability projection. This replaces independent per-item observations with an explicit batch observation point. Candidate-retention predicates keep their existing transaction-time now(), and cursor watermarks keep their independent fresh observations. The [history design](../../../../docs/design/webhook-history.md) owns the complete read contract; the [history and redelivery decision](2026-11-08-webhook-history-redelivery.md) retains point-read, operation and receipt rationale.

## Alternatives

**Keep per-Delivery reads and timestamps.** This preserves separate time observations but retains round trips proportional to candidate count, including repeated reads of the same Endpoint and authorization facts.

**Join both child collections directly to each Delivery.** Two one-to-many relations multiply rows and repeat parent bodies. Independently aggregating both into one SQL statement avoids multiplication but adds nested transport mapping for proof and Attempt collections. Separate typed batch results keep their individual ordering and errors explicit.

**Push all final filters and view policy into SQL.** Event/resource filtering follows disclosure, and displayed state depends on current eligibility. Moving these rules requires a separate rule/query contract; the batch-read boundary keeps facts reusable without introducing a second business policy in SQL.

## Consequences

Database round trips depend on candidate batches rather than individual Deliveries. Existing Delivery-leading child indexes support the batch ID predicates; measured plans still determine actual database cost. Grouping is linear in returned parent and child rows, while proof sorting/encoding and hashing retain their existing byte and collection costs. Holding event facts and child collections for a batch can increase live data, so performance evidence includes allocation or memory observations as well as query counts and elapsed time.

Batch observation changes expiration-boundary behavior: all records in a batch use its observation time, and the next batch observes afresh. Boundary tests distinguish projection time, candidate retention time and cursor watermarks. All three queries must share the same snapshot, close each result before the next query and retain cancellation, iteration and transaction-completion errors.

This decision leaves whole-range filtered scans, Disclosure fingerprints, sender/retention operations and external API shape with their existing owners. Later filtering work can reuse the fact/projection separation, but must preserve disclosure and cursor semantics. Runtime improvements are established by source-bound measurements rather than the number of SQL statements alone.
