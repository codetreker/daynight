# Agent Note: Control Herdr Native Confirmation Deadline After Durable Transport

Status: implemented

## Problem

The durable Herdr integration scenario must prove that a delivered initial input
survives a failure while confirming the original native Session identity. Its
180 ms operation budget also covered real startup fingerprinting and SQLite IO
before input delivery. An arbitrary rejection could therefore occur before the
state whose recovery the scenario intends to verify.

## Decision

The scenario retains the real Herdr facade, lifecycle and input SQLite journals,
and a normal bounded Operation. A wrapper delegates ordinary operation checks
until `onPromptTransportCompleted` confirms that the input and lifecycle records
have committed. Subsequent `check` or `remainingMs` calls throw the exact injected
`OperationError("deadline")`; the test requires that same error object and the
observed transport-completion callback.

The durable record must retain `transport_completed` after exactly one initial
input. Reopening the fixture must skip another initial submission, reject
continuation with `native_session_pending`, and preserve the single input and
single native launch. These assertions keep delivery, native confirmation and
replay prevention separate.

## Alternatives

**Raise the arbitrary short deadline.** A larger allowance still lets startup IO
choose which phase expires and adds waiting without establishing that input was
delivered before the failure.

**Retry the unchanged scenario.** A passing retry cannot prove that the rejected
operation reached native identity confirmation or correct the fault placement.

## Consequences

The integration test controls the failure phase while retaining real durable
writes, reopen behavior and no-replay checks. It proves deadline-error handling
after committed transport; actual timer scheduling, elapsed-time boundaries and
Operation cancellation remain the responsibility of Operation tests. Production
deadlines and Herdr behavior are unchanged.
