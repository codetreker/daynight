# Agent Note: Webhook Application Runtime

Status: implemented

## Problem

Persisted webhook responsibilities need a complete public management surface and a supervised execution owner. A healthy database alone cannot establish that delivery is running, and releasing shared resources while requests or workers still use them can corrupt shutdown and recovery.

## Decision

The application composes the existing management routes, sender and retention components over its shared persistence. Startup validates supported policy and current references and authenticates retained ciphertext against the configured keyring. The runtime starts and supervises workers from its root and reports permanent failure through readiness. Dispatch maintenance mode stops configuration expansion and network claims while capture, recovery and retention continue. One deadline bounds HTTP, Session and worker shutdown before shared dependencies close. The [runtime design](../../../../docs/design/webhook-runtime.md) owns deployment and recovery procedures.

## Alternatives

**Expose routes with independently managed workers.** A process could remain ready while its sender had exited, presenting an apparently usable management surface without delivery.

**Disable capture with dispatch.** Existing endpoints would lose responsibilities created during maintenance and restarting the sender could not reconstruct their original audience or bytes.

**Release resources after a timeout regardless of active users.** An unresolved request or worker could then access closed persistence; a timeout must remain an error with dependencies retained until users stop.

## Consequences

All writers sharing a database must deploy the capture and authorization contract, consistent switches and supported policy. Retained encrypted material still needs its master keys during maintenance and recovery. Receivers must tolerate an unknown external effect when an admitted process dies; leases fence state but do not prevent repeated delivery. The [delivery](2026-11-08-webhook-safe-delivery.md) and [retention](2026-11-08-webhook-retention.md) decisions retain their transaction and cleanup rationale.
