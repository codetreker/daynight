# Agent Note: Assistant task claim credential ownership

Status: implemented

## Problem

An assistant task can be transferred by its user or previous holder while the
receiving Bot runs on another Worker. A server-generated secret returned only to
the transfer caller does not reach that Worker. Persisting only its hash also
prevents recovery when the original success response is lost. Registration can
therefore name a holder that cannot renew or perform protected writes.

The initial delivery brief also required renewal to replace the token and
generation. That makes a normal renewal race with CLI writes using the same
Bot's local state. Its API integration matrix included expiry, conflict and
concurrency cases that belong to module and real PostgreSQL tests under the
repository's test ownership rules.

## Decision

The adopted [claim contract](../../../../docs/design/assistant-task-claims.md)
assigns secret generation and durable preparation to the Bot that will use the
credential. Transfer immediately changes the holder and invalidates the old
generation. The receiving Worker binds its own saved secret to that pending
generation, without another user approval. Only the hash reaches storage.

Renewal extends the lease without changing the secret or generation. Successful
operations persist immutable receipts in the same transaction as their effects.
Recovery reads the original operation and separately checks the current claim;
an absent receipt is not proof of rollback or permission to resend.

The contract assigns each required assertion to the layer that owns the
behavior, retaining real database and cross-Worker acceptance where needed.
This note originally delivered the design decision without runtime support.
The [server implementation](2026-11-12-assistant-task-server.md) applies the
contract to the API and persistence layer. The [CLI implementation](../feature/2026-11-13-assistant-task-cli.md)
provides private operation records and single-writer coordination. The
[Worker runtime](2026-11-13-assistant-task-worker-runtime.md) uses them for
continuous renewal, transfer reception and application cancellation; its
cross-Worker behavior has separate acceptance evidence.

## Alternatives

**Server-generated secret returned to the transfer caller.** This was the
initial design. It keeps secret generation central but leaves the receiver
without a credential across Workers, and cannot recover a lost response from a
hash alone.

**Persist the secret in an event or introduce encrypted delivery.** An event
would violate the hash-only storage requirement and place credentials on a
message path. Encrypted delivery needs an additional key and recovery protocol
that the selected collaboration trust model does not otherwise need.

**Wait for the transfer lease to expire and claim again.** This produces a gap
after a reported transfer and treats a new acquisition as completion of the old
one. It does not satisfy immediate transfer and continuation.

**Rotate on every renewal.** This requires coordinated secret replacement and
recovery every minute and rejects concurrent operations that were valid before
renewal. Ownership changes already provide the required generation fence.

## Consequences

Transfer exposes a pending credential state until the target Worker receives
it. The target must bind and renew before starting application work; an offline
target does not imply active monitoring. Pending leases have the same fixed
five-minute expiry and participate in ordinary takeover eligibility.

The CLI and Worker need shared durable operation records and single-writer
coordination. A lost local secret remains unrecoverable from the server. Receipts
cost storage until task deletion, and an unresolved operation can stop work;
neither cost justifies guessing success or replacing the operation identity.

Successful API flows, module refusals, database races and actual Worker
continuation provide distinct evidence. Relocating assertions does not weaken
their required behavior or turn this design decision into passing acceptance.
