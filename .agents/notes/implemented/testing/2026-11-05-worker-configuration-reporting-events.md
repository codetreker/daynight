# Agent Note: Worker Configuration Reporting Completion Events

Status: implemented

## Problem

Runtime configuration application, periodic reporting and execution backend
initialization finish independently. A report containing an applied scalar and
a native validation failure can precede application of another scalar or
creation of the coordinator. Treating that report as proof of coordinator
creation makes a valid asynchronous ordering fail the runtime integration test.
The test must also establish that unavailable native settings do not prevent
independent settings from reaching their consumers.

## Decision

Runtime reporting tests use separate completion observations for configuration
application, report emission and coordinator startup. A deferred backend
initialization forces reporting to run before coordinator creation. The fixture
observes all three applied scalars and sanitized native failures while that
initialization is held, then releases it and waits for the coordinator's own
creation and configuration events.

A controlled clock advances the configuration manager's existing retry deadline
for an unchanged native target. Recovery is observed at the original coordinator
and in a subsequent configuration report. Assertion retries only inspect state;
time advancement happens once at the relevant event boundary.

The [configuration application decision](../architecture/2026-11-04-worker-cloud-runtime-configuration.md)
owns independent item application and retry semantics. The
[reporting decision](../architecture/2026-10-28-worker-runtime-reporting.md)
owns independent transport scheduling. The
[reporting verification requirements](../../../../docs/spec/daynight-worker-reporting.md#验证)
own these observable validation obligations.

## Alternatives

**Wait only for the native error report.** That snapshot proves the reported
items' states, but does not join backend initialization or prove every scalar
has become usable by the coordinator.

**Make reporting wait for the coordinator.** A slow or failed backend would then
suppress configuration observations and machine liveness, violating the existing
independent reporting requirement.

**Add a fixed sleep or increase the assertion timeout.** Host scheduling and
filesystem persistence still decide when startup finishes. A deferred operation
and an observed completion event make the required ordering explicit.

## Consequences

The regression exercises a valid ordering deterministically while retaining
scalar application, native unavailability, error redaction and recovery checks.
It preserves the existing runtime behavior and retry implementation. Mocked
version probes establish configuration integration behavior; they do not prove
real provider launch capability or native process lifecycle correctness.
