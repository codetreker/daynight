# Agent Note: Control native startup test deadlines after request delivery

Status: implemented

## Problem

Native startup regressions distinguish explicit rejection, transport uncertainty
and a missing initialization response. Five cases across the Controller SDK,
compiled Copilot cleanup and Worker startup chain wait for a 30-second response
deadline. Their purpose is to verify the resulting observation and cleanup, but
serial real-time expiry adds roughly 150 seconds of accumulated file execution.
The SDK connection, actual request delivery and owned process exit remain part of
the behavior these tests must exercise.

## Decision

A shared test-only deadline controller captures the requested 30-second timer and
its real handle while forwarding timers to the native implementation. It waits
for the fixture's initialization request log before expiring the remaining
captured callback asynchronously. Cleared timers are removed from consideration;
ambiguous active deadlines fail the test. The socket-close fixture additionally
observes the actual SDK client socket and joins its close event before expiry.
A request log or one event-loop yield cannot establish that the peer FIN reached
the client; otherwise forced cleanup could close the socket before the tested
failure condition occurred. The timer functions and scoped socket observer are
restored after the operation and its cleanup settle.

The SDKs, transport, fixture child, rejection classification, durable journal and
Worker report remain real. The compiled Copilot fixture still executes with
strict unhandled rejection handling and verifies no teardown RPC or surviving
owned process. Separate virtual-time assertions preserve the production default
and the pending-before-expiry boundary. The
[development guide](../../../../docs/development.md#cli-development) owns the
validation commands and timing contract.

## Alternatives

**Wait for real expiry.** This retains the full wall-clock interval but adds a
fixed half minute whenever one missing-response case runs. The tests need the
configured deadline and its error path, rather than a performance measurement of
elapsed native time.

**Advance every timer or shorten matching durations globally.** SDK connection,
transport and cleanup timers also run during startup. Advancing them before
request delivery can replace the intended missing-response outcome with an
unrelated connection failure. Capturing the single active response deadline
keeps those phases independent.

**Expose shorter production startup options.** Production callers do not require
a different response policy. Adding an option only for these fixtures would
expand the provider API and leave the normal configured value less directly
exercised.

**Optimize unrelated slow suites in the same change.** Web accessibility queries
and Go transaction overlap tests have separate proof boundaries. Their remaining
cost can be addressed independently without restructuring this helper or changing
production timing. They continue to run with their existing assertions and
settings.

## Consequences

Startup failures become available without waiting through an incidental real
response interval. Captured deadline values and boundary checks still reject a
changed default, and actual I/O must reach the intended stalled request first.
The helper relies on one active timer with the expected duration at that phase;
a new concurrent deadline requires the fixture to establish a more specific
identity before it can expire either timer safely.

File-level savings do not add directly to job savings under parallel workers.
Web browser and Go jobs can remain the overall CI critical path. Container
measurements and native hosted results must retain their own source, toolchain,
worker and resource context.
