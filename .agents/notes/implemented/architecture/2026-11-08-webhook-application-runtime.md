# Agent Note: Webhook Application Runtime

Status: implemented

## Problem

Persisted webhook responsibilities need a complete public management surface and a supervised execution owner. A healthy database alone cannot establish that delivery is running, and releasing shared resources while requests or workers still use them can corrupt shutdown and recovery.

## Decision

The application composes the existing management routes, sender and retention components over its shared persistence. Startup validates supported policy, current signing keys and endpoint revision waits. The runtime starts and supervises workers from its root and reports permanent failure through readiness. Dispatch maintenance mode stops configuration expansion and network claims while capture, recovery and retention continue. One deadline bounds HTTP, Session and worker shutdown before shared dependencies close. The [runtime design](../../../../docs/design/webhook-runtime.md) owns enablement, maintenance and restart procedures. The [plaintext storage decision](../simplification/2026-11-08-webhook-plaintext-storage.md) replaces the initial keyring and retained-ciphertext startup requirements.

## Alternatives

**Expose routes with independently managed workers.** A process could remain ready while its sender had exited, presenting an apparently usable management surface without delivery.

**Disable capture with dispatch.** Existing endpoints would lose responsibilities created during maintenance and restarting the sender could not reconstruct their original audience or bytes.

**Release resources after a timeout regardless of active users.** An unresolved request or worker could then access closed persistence; a timeout must remain an error with dependencies retained until users stop.

## Consequences

All writers sharing a database must deploy the capture and authorization contract, consistent switches and supported policy. Restart reads retained targets and signing secrets from their persisted plaintext rows. Receivers must tolerate an unknown external effect when an admitted process dies; leases fence state but do not prevent repeated delivery. The [delivery](2026-11-08-webhook-safe-delivery.md) and [retention](2026-11-08-webhook-retention.md) decisions retain their transaction and cleanup rationale. The single deadline replaces the separate cleanup budget described by the [application lifecycle decision](2026-11-06-server-application-lifecycle.md); on expiry it cannot guarantee completion before process exit.
