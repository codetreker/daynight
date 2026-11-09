# Agent Note: Immutable Webhook Receipt Results and Logical Expiry

Status: implemented

## Problem

A client recovering a lost rotation response needs the original overlap deadline,
including after another rotation removes the former key. A receipt row retained
by delayed maintenance must also stop serving as confirmation after its stated
expiry; otherwise reconciliation depends on collector scheduling.

## Decision

Every operation projection carries nullable `overlapUntil` from its immutable
stored result. Rotation responses bind their sibling signing key and deadline to
the same receipt. Nonrotation and immediate rotation results carry `null`.

The service checks receipt expiry using the database clock after current owner
and actor authorization and intent-conflict checks. GET hides logically expired
receipts with `not_found`; matching retained replays return `operation_expired`
without configuration or delivery effects. Raw DAO lookup and the operation fence
continue preserving occupied identity. Live replay precedes first-admission time
checks, while requests whose receipt has been collected require fresh admission.
The same expiry check applies to authorized postcommit projections. The
[management design](../../../../docs/design/webhook-management.md) owns these
rules; the [management decision](../architecture/2026-11-07-webhook-management.md)
and [retention decision](../architecture/2026-11-08-webhook-retention.md) own the
transaction and collector mechanisms.

## Alternatives

**Recover the deadline from current signing state.** Another rotation or endpoint
deletion changes or removes that state, so it cannot describe the original effect.

**Filter expired rows out of the DAO lookup.** This makes a retained occupied
identity appear unused to mutation admission and discards its conflict evidence.

**Wait for receipt collection.** Busy fences and bounded cleanup can retain rows
past their deadline, turning maintenance progress into externally visible expiry.

## Consequences

Clients can reconcile the original rotation from GET alone. The extra nullable
field is required by strict receipt parsers; no legacy response fallback is
provided. Original results remain immutable, but finite retention bounds their
availability. A missing or expired receipt cannot establish rollback, and an
otherwise committed write whose fresh projection cannot be verified remains
unknown. Logical expiry requires a database-clock observation in receipt
projection without adding a migration or changing physical retention.
