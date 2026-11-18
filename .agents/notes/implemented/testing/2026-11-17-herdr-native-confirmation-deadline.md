# Agent Note: Control Herdr Native Confirmation Deadlines at the Intended Phase

Status: implemented

The dedicated Herdr runtime tests described here were removed with the [daemon](../simplification/2026-11-18-remove-herdr-daemon.md); this decision remains historical.

## Problem

Native Session confirmation tests must first establish that their original input
has reached the state whose recovery they exercise. A 180 ms durable-facade
operation budget also covered real startup fingerprinting and SQLite IO before
input delivery. A deferred-input execution scenario similarly started a 100 ms
budget before submission while requiring repeated held Session observations.
Either deadline could expire before the intended confirmation phase; an arbitrary
rejection would not prove the required delivery and recovery behavior.

## Decision

Both scenarios retain a normal bounded Operation until their observed target
phase. A wrapper delegates ordinary checks and injects a specific
`OperationError("deadline")` from subsequent `check` or `remainingMs` calls only
after that phase is established. Caller-level tests control the fault location;
Operation tests retain responsibility for actual timer scheduling, elapsed-time
boundaries and cancellation.

The durable Herdr facade scenario retains real lifecycle and input SQLite
journals. It arms the injected deadline from `onPromptTransportCompleted`, after
the original input and lifecycle records have committed, and requires the exact
injected error object. The durable record must retain `transport_completed`
after exactly one initial input. Reopening must skip another initial submission,
reject continuation with `native_session_pending`, and preserve the single input
and single native launch.

The mapped shared deferred-input scenario retains the execution driver, Herdr
agent manager and in-memory SQLite Worker store with controlled RPC, Git and tool
mapping collaborators. Its confirmed and deadline paths first observe at least
three held Session snapshots. Until official Session confirmation, the operation
must remain pending, the stored native Session ID must remain null, and no
started or reconnected event may be published. Only then may the deadline path
arm its fault and verify the caller's submitted-input, unknown-result error and
its exact injected deadline cause. Releasing discovery and advancing recovery must establish the original official
Session with exactly one managed input and one native launch. The started promise is immediately
owned by `Promise.allSettled`; a finally block releases held discovery and awaits
that settlement even when an intermediate assertion fails, preserving the
original failure while completing owned work.

## Alternatives

**Raise the arbitrary short deadlines.** Larger allowances still let startup IO
choose which phase expires and add waiting without establishing the intended
delivery or held-confirmation state.

**Retry the unchanged scenarios.** A passing retry cannot establish which phase
failed or correct a fault that can precede the required observations.

## Consequences

The caller-level proofs no longer depend on startup IO fitting inside a short
fault window. Durable writes, reopen behavior, official identity gating,
recovery and no-replay assertions retain their existing owners and collaborators.
Joining started work prevents a failed observation assertion from leaving an
unobserved rejection or active discovery loop. These tests establish handling of
a deadline at the required phase; they do not prove the Operation timer's elapsed
behavior. Production deadlines and Herdr behavior are unchanged.
