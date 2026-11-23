# Agent Note: Persist Worker tag filter application proofs

Status: implemented

## Problem

A saved Worker tag filter does not prove that the local Worker has applied it.
New claims must use the applied filter even across restart, configuration changes
and failed checkpoint writes. Large name collections must also fit the existing
observation and claim budgets without losing application or removal history.

## Decision

The raw desired document owns the complete names. A synchronous application item
stores the SHA-256 of compact UTF-8 JSON `[match, sortedKeys]`, using validated tag
names, ASCII folding and Unicode scalar ordering. Empty filters canonicalize to
`any` and an empty collection. Only a synchronized, durably applied item whose
digest matches the current target publishes the effective filter and claim key.
Unavailable proof blocks new claims while retaining Projects and existing work.
An absent field on a synchronized older service preserves its original behavior.

Schema 11 distinguishes digest-bearing records from historical formats. Schemas
1–10 retain their deployed validation before conversion. A newly recognized
opaque filter starts pending with no actual value or provenance; migration
preserves the pending-application flag, source, application anchor, failures and
removal ownership. The current decoder validates schema 11 separately from the
frozen historical type, wire and source definitions. This extends the
[stored decoder decision](2026-11-17-worker-stored-configuration-decoder.md) and
[Web checkpoint decision](2026-11-17-worker-web-configuration-checkpoint.md).

The bounded digest item always accompanies the existing prioritized removal;
other observation records, including global native configuration, keep rotating
under the measured storage and full-request budgets. Foreground runtime supplies
the proof to admission and requests an authority reread plus report wake on stale
hints. Control runtime keeps its existing claim-management and one-shot exchange
behavior. A stale hint does not establish a conflict's cause.

## Alternatives

**Store the full filter in every application item and claim.** Legal desired
names can occupy the configuration budget and exceed the smaller claim budget;
repetition also consumes bounded observation capacity.

**Treat the desired value or migrated opaque source as applied.** Neither proves
a successful durable local application and both can authorize claims after a
failed checkpoint replacement.

**Stop existing execution when proof is unavailable.** The filter governs new
claims; existing claims retain their original execution and cleanup obligations.

## Consequences

Checkpoint publication remains owned by the existing serial atomic writer.
Digest records are bounded, while full names remain available for effective
projection from their authoritative source. Older binaries cannot read schema
11. Migration preserves historical facts without promising binary downgrade.
The [Worker design](../../../../docs/design/daynight-worker.md#云端接收与本机提交)
owns the detailed mechanism and validation boundaries.
