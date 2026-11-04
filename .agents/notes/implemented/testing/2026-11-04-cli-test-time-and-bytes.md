# Agent Note: Exercise binary equality and IPC deadlines without long waits

Status: implemented

## Problem

Large binary transport assertions can spend more time traversing Buffer properties
than executing the transport. The Controller admission regression also spends
31 seconds waiting for a native provider fixture, although its required evidence
is the separation of an incomplete frame's admission timeout from an admitted
request's response deadline. These costs recur in ordinary CLI validation.

## Decision

The 150,000-byte attachment and compiled stdout tests compare full payloads with
`Buffer.equals`. This checks length and every byte through Node's native byte
comparison. Payload size, stream chunk bounds, metadata and exit assertions remain
part of the same tests; Buffer object properties are not transport data.

The admission regression uses real Controller IPC sockets and a provider completion
barrier. It observes the production 30,000ms socket timeout and verifies that the
authenticated socket disables that timeout before native input completes. Only the
incomplete socket's native timer is rescheduled to expire promptly after its
partial frame has arrived. Its real timeout event and disconnection remain
observable while the authenticated request stays open. Advancing global virtual
time past 30 seconds checks that the separate response wait remains pending;
releasing the provider barrier then confirms the original operation exactly once.

Node socket idle timers use internal timer functions, so replacing global
`setTimeout` does not control their expiry. Explicit timeout-state assertions and
a real native timeout keep that distinction visible. The test restores timers
and socket spies and joins its pending work before removing its fixture.

The [development guide](../../../../docs/development.md#cli-development) owns the
validation commands. The [session design](../../../../docs/design/task-session-protocol.md)
owns production admission and response deadlines, which remain unchanged.

## Alternatives

**Retain the real 31-second provider delay.** This exercises elapsed native time,
but repeats a long wait to establish the same timeout cancellation and subsequent
completion guarantees on every ordinary run.

**Advance only Vitest's global fake timers.** Node socket idle timers would not
advance. A test could therefore pass after removing the production cancellation
of the admission timer. The real socket timeout state must be asserted separately.

**Shorten production deadlines or all test socket deadlines.** Changing production
deadlines changes the IPC contract. Scaling every accepted socket's deadline also
creates a short race between request admission and runner scheduling. Only the
already identified incomplete connection has its native expiry accelerated.

## Consequences

Large binary comparisons retain exact byte and length checks without generic
object traversal. On failure, a boolean equality assertion identifies a payload
mismatch without rendering a large per-byte object diff.

The admission regression removes the 31-second wall-clock delay while preserving
real IPC, native incomplete-frame expiry, authenticated timer cancellation and
one native dispatch. It verifies the configured 30-second admission value and
its lifecycle rather than benchmarking Node's timer accuracy. Targeted mutations
of admission cancellation and incomplete-frame expiry must still fail the test.
