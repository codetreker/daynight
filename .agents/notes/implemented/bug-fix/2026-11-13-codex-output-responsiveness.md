# Agent Note: Codex output consumption yields to ready I/O

Status: implemented

## Problem

A stream of valid native notifications can keep the Controller executing decoder,
projection and journal work while ready sockets and timers wait. Awaiting an
already-resolved Promise only runs microtasks, so an observation may depend on
the native input ending. Adding I/O checkpoints also exposes a stale timer when
a formerly partial frame finishes, and makes close and media ownership ordering
observable between frames. A child's normal close event can run while the reader
still owns received bytes, so treating that event as cancellation loses final
notifications and successful responses.

## Decision

The private Codex RPC reader consumes each OS chunk through bounded subarrays of
the existing decoder buffer limit. It serially delivers each frame, preserves
the consumer microtask before releasing the frame, then awaits a ref'ed
`node:timers/promises.setImmediate()`. Each exhausted input slice uses the same
checkpoint, including slices without a complete frame. The same decoder retains
UTF-8, JSON and media state across slices.

The checkpoint checks closure before synchronizing the original absolute frame
deadline, awaits its immediate, then checks closure again. Completion clears an
old partial-frame timer; further fragments retain their initial deadline. An
already-scheduled immediate settles normally and belongs to `rpc.stopped`;
shutdown never clears an immediate while leaving its Promise unresolved. Final
decoder disposal preserves independently retained consumer media references.

Natural child closure closes outbound dispatch immediately, while the reader
drains received stdout through its normal checkpoints and validates decoder EOF.
The provider invalidates local read authority on physical exit and defers turn
rejection and runtime shutdown until that reader stops, preserving buffered
terminal evidence. Physical exit and reader completion are tracked separately so
shutdown cannot wait for an already-consumed close event. Explicit disposal,
genuine transport errors and frame deadline failures still cancel consumption
immediately. Automatic rejection of native requests is skipped after known
physical exit: replying to a dead peer must not abort the remaining input. Live
peers retain their normal rejection behavior.

The [Controller design](../../../../docs/design/task-session-protocol.md#codex-输出消费与-io)
owns the execution contract and its limits. Ordinary regressions exercise real
socket readiness, frame deadlines, immediate cancellation and real-process exit
with buffered notifications and responses. A separate local stress fixture
retains native stdout pipes, tool projection, SQLite, authenticated runtime IPC
and an independent client process, including combined persistent outbox accounting.

## Alternatives

**Microtask-only yielding.** A Promise continuation does not give ready socket
callbacks an execution opportunity while buffered input continues to dispatch.

**Time or frame budgets.** Batching can reduce scheduling overhead for cheap
frames, but adds threshold, cross-chunk and elapsed-time state to cancellation,
deadline and fairness rules. Yielding at every safe boundary requires no new
tuning parameter and provides directly observable ordering.

**Yield only after an OS chunk.** Pipe chunk boundaries are outside our control.
A large chunk can contain many complete frames or a long incomplete frame, so
the opportunity for ready I/O must also exist within the chunk.

**Cancel pending immediates during close.** Clearing an immediate without settling
its awaited Promise can prevent the reader and media cleanup from terminating.
Letting the existing immediate settle keeps a single joined asynchronous owner.

**Finalize directly on child close.** OS stream closure does not mean that our
asynchronous reader has consumed its current chunk. Both transport failure and
provider shutdown can destroy that owned input; natural closure must join the
reader before applying terminal effects.

## Consequences

Ready I/O no longer depends on exhausting buffered native notifications. Per-frame
and per-slice immediates add scheduling overhead while preserving serial backpressure,
content order, original execution identity and the existing 2,000 ms observation
timeout. This is cooperative scheduling: individual synchronous decode, image or
SQLite work remains non-preemptible. Synthetic local timing is evidence for its
recorded environment, not a hard real-time guarantee for arbitrary loads.
