# Agent Note: One New Worker Claim per Scheduling Round

Status: implemented

## Problem

A Worker with several free execution slots can acquire a batch of ready tasks
within one scheduling round. Capacity therefore controls both simultaneous
execution and the size of an immediate acquisition burst. New tasks need to be
admitted gradually while preserving the configured execution capacity and
progress of claims the Worker already owns.

## Decision

The coordinator ends new acquisition after one confirmed grant across all
configured Projects. It records the grant as pending, publishes the claim and
starts it when capacity and the old-claim resource barrier permit. A grant that
must remain pending still ends acquisition for that round. Candidate generators
are closed on exit. Existing claim failure handling also ends the round and
leaves later complete inventory responsible for reconciliation.

The next acquisition uses the normal [polling interval](2026-10-28-worker-default-poll-interval.md)
after the complete round. Project rotation continues from the next Project;
empty Projects can be skipped, and candidates retain server ready order within
each Project. No additional timer or persistent admission counter is needed.

The [claim-record scheduling decision](../simplification/2026-10-27-worker-claim-records.md)
retains capacity accounting, old-claim barriers and pending startup priority.
Existing pending claims can still start across multiple free slots in one round,
and already active claims continue recovery independently.

## Alternatives

**Fill every free slot in one round.** This uses idle capacity sooner but makes
one scheduling pass acquire several new tasks immediately, defeating gradual
admission.

## Consequences

Filling initially empty capacity from new work now takes successive scheduling
rounds. With the default polling interval, each later round waits sixty seconds
after the preceding round completes. Execution concurrency remains controlled by
`maxConcurrent`, while acquisition cadence is bounded separately. Recovered
pending claims can still start together because their ownership was already
granted.

The limit belongs to one Worker's scheduling round. It does not impose a
cross-Worker acquisition rate or change the service's atomic claim rules.
