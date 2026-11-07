# Agent Note: Webhook History and Explicit Redelivery

Status: implemented

## Problem

Operators need to diagnose a delivery and retry an eligible event without exposing data after access changes or confusing an uncertain registration with a new operation. History, authorization and retention can change while a request waits for locks.

## Decision

History and endpoint summaries read current authorization and retained attempts in one snapshot. Payload reads independently authorize and return the persisted bytes with their digest. An operation fence and locked current proof govern manual registration; its receipt, generation, count and FIFO ticket commit together. The runner persists a separate Attempt before sending. The [history design](../../../../docs/design/webhook-history.md) describes the read and execution boundaries.

## Alternatives

**Rebuild payloads from current tasks.** Later edits and deletion would change or lose the bytes that the receiver actually saw.

**Send directly from the management request.** A lost response or failed attempt insert would make the external effect impossible to reconcile with a durable admission.

**Use endpoint visibility as resource permission.** Team membership or endpoint management does not necessarily authorize the original project and task data.

## Consequences

Readers must reauthorize on each page and handle history gaps after retention. Matching receipts preserve the original operation outcome while current delivery views may have changed. The original retry and payload deadlines remain in force; receivers still need to deduplicate event IDs.
