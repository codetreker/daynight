# Agent Note: Worker maintenance for assistant tasks

Status: implemented

## Problem

An idle assistant cannot renew a five-minute lease, notice an expired holder or
start a scheduled turn by itself. Running those obligations through model turns
would consume input while the assistant is busy and leave lease health dependent
on model behavior. A lost Session response or Worker restart can also duplicate
a notification unless its original operation survives locally.

## Decision

The [Bot runtime](../../../../docs/design/worker-bot-runtime.md#助手任务维护)
owns four independent minute loops for renewal, takeover, delivery and triggers.
It shares the CLI's [claim state](2026-11-12-assistant-task-claim-contract.md),
including its file lock, pre-generated secret and receipt-only recovery. A
pending transfer binds and renews before application work starts. Healthy local
Controller observations gate maintenance; applications receive cancellation and
a guard that verifies the original claim before external effects.

Each notification persists its complete command and event set before its only
submission. Pending or ambiguous outcomes query that original operation.
Provider acceptance precedes event acknowledgment. Definite HTTP admission
refusals can be reconsidered; a stored receipt permits a new decision only for
the service's explicit pre-dispatch refusal or expiry. A native rejection does
not itself establish that input was never accepted.

Private journals use two alternating chunk banks with a hash-checked atomic
manifest. This keeps the last complete intent through interrupted replacement
without growing a new content file on every poll. Large event data becomes an
explicitly marked summary with the original event and task identities. A bounded
notification batch preserves excess pending events for the next idle turn.

Interval triggers use the task creation time; daily triggers use the configured
IANA zone and local date. Stable occurrence IDs survive restart and takeover.
Only the latest due occurrence is considered, so recovery does not replay an
offline backlog. Server-generated takeover events retain the actual gap facts.

The managed Bot lifecycle joins maintenance and application work before stopping
Controllers. Deletion first closes that Bot's scheduling and joins its in-flight
work, then deletes only its derived private state with the existing inode and
parent checks. Assistant work remains outside project Task concurrency slots.

## Alternatives

**Model-driven renewal and event polling.** An idle model would need artificial
turns for every renewal, and a long-running turn could prevent the fixed cadence.
The Worker already owns Controller health and lifetime, so deterministic loops
belong there.

**A second claim credential store for the Worker.** Independent tokens would
race with CLI mutations and fail across transfer or lost replies. The existing
private state and operation recovery already describe the shared owner.

**A new Session command after a timeout.** The previous request may have reached
the Provider. A fresh identity could start duplicate work and make later ACKs
misleading. Uncertainty therefore retains the original command, even when that
temporarily blocks newer notifications for the same Bot.

**One immutable journal file for every content version.** It simplifies recovery
but grows with each event and confirmation. Two banks retain crash-safe
replacement with a fixed maximum footprint per journal, without expanding the
shared private-file record limit or introducing another database format.

## Consequences

Worker shutdown or unhealthy Controllers stop renewal, and the server's fixed
five-minute lease determines eligibility for another holder. Local cancellation
cannot withdraw an already submitted external message. Applications must use
the guard, propagate cancellation and join their own jobs; the runtime does not
claim to stop an application that ignores its signal.

Unknown Session operations can block delivery until their original receipt is
resolved. A bounded summary never grants permission to act on omitted facts.
The runtime journal retains at most two four-MiB banks per key; claim-operation
receipts keep the CLI's existing retention. Bot deletion owns final private
state removal. Fake-clock and real-file tests prove local coordination, while
real two-Worker acceptance establishes takeover and native notification flow.
