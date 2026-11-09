# Agent Note: Webhook Management Receipts and Secrets

Status: implemented

## Problem

Webhook owners need to change destinations and signing credentials without exposing secrets or duplicating a configuration when a database commit or HTTP response is lost. Concurrent permission changes must not expose a later destination to a former administrator.

## Decision

The management module uses an owner-scoped operation fence and stores a receipt in the same transaction as the configuration effect. A subsequent authorized snapshot supplies the current projection after the write connection is released. Receipts bind normalized intent separately from the received body digest. PostgreSQL stores canonical destination JSON and recoverable 32-byte signing secrets directly as plaintext bytes. The [plaintext storage decision](../simplification/2026-11-08-webhook-plaintext-storage.md) replaces the initial authenticated-envelope storage while preserving the management and receipt boundaries. The routes are independently mountable; application registration and event delivery remain separate responsibilities. Versioned typed policies set time and retention rules without maintaining storage quotas.

[The management design](../../../../docs/design/webhook-management.md) describes the boundaries. The [receipt result and lifetime decision](../bug-fix/2026-11-08-webhook-receipt-results.md) preserves original rotation deadlines and makes validity independent of physical cleanup.

## Alternatives

**Retry a new create after a lost response.** A second server-generated endpoint can result from a committed first request, and cannot prove which request created it.

**Store only a secret hash.** A sender must later recover the signing key, so a one-way hash cannot supply the required credential. The initial management design used authenticated encryption for recoverability and resource binding; the later plaintext decision retains recoverable secrets with a different storage exposure.

**Project a response inside the write transaction.** A nested snapshot needs another connection and can deadlock a single-connection pool; a previously observed administrator role can also expose a later destination after demotion.

**Maintain owner and global storage quotas.** Accounting introduces shared locks and rejection paths unrelated to the requested management behavior. Actual storage failures instead roll back the complete operation and remain visible.

## Consequences

A lost commit result remains unknown until the original operation is read; a missing or unauthorized receipt does not prove rollback. Ordinary configuration projections remain redacted and secret reads remain separately authorized. Database and backup readers can recover stored targets and signing secrets. Dispatch is outside this module.
