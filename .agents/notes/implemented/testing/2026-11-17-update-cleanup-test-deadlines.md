# Agent Note: Control Update Cleanup Test Deadlines

Status: implemented

## Problem

Four update supervisor cases wait for the full ten-second cleanup or release
budget. They must establish the error and cleanup behavior after real process and
IPC transitions, but elapsed wall time is incidental to those assertions.

## Decision

The isolated test drivers control only the cleanup or release deadline registered
before the corresponding IPC request. They record its original duration and
handle, retain native cancellation semantics, and deliver only an active timer.
Other timers and process interactions remain real. The cases wait for the
relevant group observation, IPC callback, or anchor close before expiry; repeated
interruptions must not replace the first deadline. The production duration and
error chain are asserted independently of elapsed time.

The [cleanup decision](../bug-fix/2026-11-13-update-process-group-cleanup.md)
owns the product guarantee and its limits. The
[development guide](../../../../docs/development.md#cli-test-fixtures) describes
the test boundary.

## Alternatives

**Wait for real expiry.** This preserves the native interval but adds forty
seconds of accumulated waiting without proving the intervening I/O completed.

**Shorten or advance all timers.** Command and group observation timers have
separate roles; changing them could produce a different failure before the
intended cleanup state is reached.

**Add a production timing option.** The product has no need for a configurable
cleanup budget, and a test-only option would expand its interface.

## Consequences

The tests exercise the real subprocess and IPC lifecycle while avoiding fixed
wall-clock expiry. Their timer identification depends on the request registration
sequence and fails if that sequence changes. The controlled deadline proves its
configured duration and expiry behavior, not native timer scheduling accuracy.
File-level savings do not by themselves establish hosted job or overall CI savings.
