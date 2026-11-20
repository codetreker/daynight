# Agent Note: Unsigned usage pagination

Status: implemented

## Problem

Usage reads are unavailable when a deployment lacks a stable cursor signing key,
although each page already requires current authorization and a consistent result
revision. The extra configuration couples read availability to unrelated secrets.

## Decision

Usage cursors retain their existing JSON payload as unpadded Base64URL without a
signature. Each request authorizes its actual scope and checks binding, revision
and the original 15-minute expiry. Old signed cursors cause an authorized reset.
Usage routes no longer require a cursor key or derive one from the S2S key. The
[usage design](../../../../docs/design/task-token-usage.md) describes the format
and version transition. This changes pagination in the [usage architecture](../architecture/2026-11-18-single-table-token-usage.md).

## Alternatives

**Offset pagination.** Changes in earlier rows could shift positions and mix or
skip results; retaining keysets preserves the existing continuation semantics.

**A server-side pagination cache.** A cache adds state, lifecycle and availability
requirements without improving the existing authorization and revision checks.

**Retaining signed cursors.** A shared stable key adds configuration and can
prevent all usage routes from mounting even when reads could be authorized.

## Consequences

Cursors are client-modifiable and provide no integrity or issuer guarantee. They
cannot grant access, alter the authorized filter or page limit; they are only
continuation hints. Existing signed cursors require a reset during rollout, and
rollback to the old server requires its valid key for usage availability.
