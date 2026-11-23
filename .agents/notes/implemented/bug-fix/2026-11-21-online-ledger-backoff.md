# Agent Note: Bound online history ledger capacity retries

Status: implemented

## Problem

An active Controller can encounter archive capacity refusals while establishing
an image history checkpoint. Immediate failure causes repeated contention, but
unbounded retries can consume the Server's image preparation response window.
Connection changes and uncertain writes also leave the original ledger identity
and receipt responsible for reconciliation.

## Decision

The active ledger uses the shared archive capacity policy for its status GET and
same-chunk PUT. A round retains four retries and thirty seconds from its first
capacity refusal across advancing checkpoints. Each request retains its own
exponential retry sequence and fifteen-second timeout. The current connection
owns cancellation and fence checks. The original intent and unknown-write
status observation remain authoritative.

Image preparation waits at most ten seconds from Controller entry for the
checkpoint, including source acknowledgement. Timeout or a changed connection
releases its media block; Markdown capture cancellation also ends its foreground
wait. Independent HTTP cancellation is not propagated by the Server and cannot
release the block early. A still-valid background synchronization keeps its own
lifetime. The [ledger design](../../../../docs/design/session-image-archives.md#活动账本与最终完整历史同步)
owns the detailed protocol. The shared policy and terminal uploader rationale
are recorded in the [terminal archive decision](2026-11-20-terminal-archive-backoff.md).

## Alternatives

**Reset the whole budget after each checkpoint.** A continuously advancing
source could then hold a single logical round indefinitely and repeatedly consume
capacity. A shared budget returns control to the existing scheduler.

**Cancel background synchronization when preparation expires.** A foreground
deadline does not invalidate a current connection or frozen ledger intent.
Canceling it would discard useful progress and increase contention for later
requests.

**Propagate independent HTTP cancellation to the Controller.** This requires
Server and Controller protocol changes, including compatible capability
negotiation and coordination of concurrent waiters for the same durable request.
It is deferred from this CLI delivery. The immutable request identity, fence and
unknown-outcome reconciliation remain intact so a later design can coordinate
cancellation without assuming that a disconnected waiter rolled back an already
dispatched operation.

## Consequences

Capacity pressure is bounded without changing ledger identity or replaying an
image operation. A foreground request can fail temporarily while its ledger
continues; it requires a later explicit attempt. Retries do not guarantee
availability or fairness across clients.
