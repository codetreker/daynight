# Agent Note: Persistent Local Worker Lifecycle

Status: implemented

## Problem

A stop decision can arrive after an execution has passed a scheduling check but
before a Controller dispatches native work. Restart can lose in-memory admission,
producer ownership and the distinction between an unknown request and a stopped
process. A cloud response alone cannot prove local stopping, durable preservation
or eligibility to recover the original execution.

## Decision

A private Worker SQLite database owns local admission, the durable veto, epochs,
resource reservations, original lifecycle operations and observation outbox.
Reservations and local closure serialize in that database. The
[management root and execution scopes](2026-11-20-worker-execution-scopes.md)
retain their original ownership: management survives closure, while every new
scope receives fresh objects and cancellation. Controller tickets and journals
freeze the same lifecycle binding; final Provider boundaries read the original
persistent authority, including after asynchronous preparation.

Local disable saves its veto before IPC or network access. IPC wakes the original
manager and does not stand in for resource evidence. An unavailable manager permits
management under the original free instance lock, without taking over a live lock
or launching a business scope. The original identity must already exist.
Explicit management owners can stop original local resources without a saved
service token. Their network methods refuse before dispatch; missing credentials
cannot settle a cloud request or authorize recovery.

Explicit resume consumes complete original stop/save evidence and online service
activation before opening local admission. Original requests are queried or
resolved under their original identity; activation has its own child phase.
Normal reconnect and initial bootstrap cannot clear a local veto. Independent
Task pauses, claims, worktrees, native context and recovery budgets remain owned
by their existing mechanisms. A management-only command's activation receipt does
not mean a foreground Worker execution scope started.
Per-execution recovery observations come from the original Task and Bot owners
and are saved in the observation outbox. They retain independent blockers and
unknown results; opening the Worker gate alone cannot establish eligibility.

The [Worker design](../../../../docs/design/daynight-worker.md#持久停用与恢复)
owns the local state and command contracts. The
[service authority decision](2026-11-20-worker-lifecycle-authority.md) owns cloud
ordering and resolution. The retirement of
[released-Task resume](../simplification/2026-11-12-retire-worker-resume.md)
continues to prohibit a separate claim-eligibility exception.

## Alternatives

**Use cloud intent as the only stop authority.** An offline local stop could not
prevent new dispatch until the next successful request. An independent veto adds
storage and reconciliation but preserves the decision before network access.

**Check only the Worker loop or Controller input queue.** Already admitted work
can cross asynchronous setup and dispatch later. Persistent checks at the final
native boundary bind that dispatch to the same closed gate and generation.

**Treat a completed producer or matching external object as success.** A producer
can finish after losing a write response, and an existing object need not have
been created by that operation. Keeping the child request independently unknown
prevents false stopping and unsafe recovery.

## Consequences

The database, original journals and process proofs must be retained together.
Missing authority, incompatible schemas, unknown native stopping and unjoined
writers block recovery instead of permitting replacement identities. Local stop,
durable save and cloud synchronization remain independently observable.
Network failures preserve previously confirmed local stop/save evidence. Closed
old-generation resources and completed observation deliveries move to compressed
history with their complete canonical JSON and SHA-256. Unresolved resources
remain live. A report covered by a newer authority keeps that coverage proof
without claiming its original upload succeeded.

Ordinary assistant event, record, item, answer and attention writes currently
lack an original-operation result protocol. An unknown outcome remains a retained
responsibility and can block complete stop/resume; read-only discovery cannot
repair that protocol gap. Session acceptance confirms dispatch only, while native
stopping still needs its original owner. Platform and Provider acceptance require
runtime evidence beyond protocol and storage checks.
