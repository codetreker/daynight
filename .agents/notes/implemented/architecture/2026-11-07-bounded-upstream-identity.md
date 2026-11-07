# Agent Note: Bounded Upstream Identity

Status: implemented

## Problem

Identity retrieval can consume an unbounded response before the SDK decodes it.
A time limit alone does not bound the decoded bytes, and large profile values
can then be persisted and propagated to other consumers. A rejection must retain
the one-time login consumption that precedes the upstream request.

## Decision

The dedicated UniAuth client bounds actual response body reads after transport
decompression, while preserving the existing deadline, cancellation, close and
no-redirect behavior. Identity admission checks individual field bytes and the
normalized profile encoding before local user, Personal Team and session writes.
The [authentication design](../../../../docs/design/daynight-auth.md#uniauth-一次性交接)
owns the limits, failure mapping and transaction order. The
[identity boundaries decision](2026-11-05-server-identity-boundaries.md) owns the
separation of consumption, external retrieval and local transactions.

## Alternatives

**Trust Content-Length or bound compressed bytes.** Either can underestimate the
actual decompressed data, and a length header can be absent or misleading.

**Truncate or discard oversized profile fields.** This would silently change
accepted identity data and could replace an existing profile with incomplete
values. Explicit rejection preserves the prior profile.

## Consequences

The SDK can stop reading at a fixed decoded-byte boundary without a fork or a
retry of its one-time code. The independent field and encoded-object budgets
both apply, including JSON escape expansion. Legitimate nullable values and data
URLs remain unchanged; an oversized response or profile requires a new login,
because the pending transaction has already been consumed.
