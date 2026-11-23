# Agent Note: Validation Probe Timeout Forwarding

Status: implemented

## Problem

The validation probe recorder test for ordinary command failures started a
child that emitted partial output and then blocked for two seconds. That
case verifies how the recorder handles a timeout result from its executor.
The process lifecycle and native timeout behavior already have dedicated
tests.

## Decision

Supply a typed synchronous command result at the recorder's executor
boundary. It carries a timeout error object, the signal, and distinct
partial stdout and stderr. Verify a single execution with the original
command, arguments and configured timeout. The recorder still persists
the diagnostics and propagates the same error object.

The native tests still exercise a real blocked read, a real command
resolution block, helper termination and reaping, and partial output from
a native child that times out through the `gh` probe path.

## Alternatives

**Keep the duplicate child timeout.** That repeats a two-second wait to
produce a result that the forwarding case can supply directly.

## Consequences

The forwarding case isolates recorder behavior and can verify the exact
error identity without waiting for a child process. The native cases own
the evidence for deadline enforcement and process cleanup.
