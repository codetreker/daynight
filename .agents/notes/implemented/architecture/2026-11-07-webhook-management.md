# Agent Note: Webhook Management Receipts and Secrets

Status: implemented

## Problem

Webhook owners need to change destinations and signing credentials without exposing secrets or duplicating a configuration when a database commit or HTTP response is lost. Concurrent permission changes and bounded storage also affect whether a write can be accepted.

## Decision

The private management module uses an owner-scoped operation fence and stores a receipt in the same transaction as the configuration effect. A subsequent authorized snapshot supplies the current projection after the write connection is released. Receipts bind normalized intent separately from the received body digest. The PostgreSQL implementation serializes shared capacity accounting and stores recoverable AES-GCM envelopes bound to their resource and purpose. The private routes are independently mountable; application registration and subscriptions remain separate responsibilities.

[The management design](../../../docs/design/webhook-management.md) describes the delivered boundaries.

## Alternatives

**Retry a new create after a lost response.** A second server-generated endpoint can result from a committed first request, and cannot prove which request created it.

**Store only a secret hash.** A sender must later recover the signing key, so a one-way hash cannot supply the required credential. Authenticated encryption permits recovery while binding ciphertext to its intended resource.

**Project a response inside the write transaction.** A nested snapshot needs another connection and can deadlock a single-connection pool; a previously observed administrator role can also expose a later destination after demotion.

## Consequences

Operations consume bounded receipt capacity until retention maintenance reclaims it. A lost commit result remains unknown until the original operation is read; a missing or unauthorized receipt does not prove rollback. Master-key recovery depends on retaining the keys needed by existing ciphertext. Endpoint subscriptions, dispatch, and background rekey are outside this module.
