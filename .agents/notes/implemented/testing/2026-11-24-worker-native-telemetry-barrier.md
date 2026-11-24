# Agent Note: Worker Native Telemetry Barrier

Status: implemented

## Problem

The cloud bootstrap startup test sampled telemetry after configuration admission
readiness. That readiness does not require the global native configuration's
applied value and validation proof to match. Project native applications may
finish first, so a valid intermediate report can have a null global native value.

## Decision

The startup test holds the global native application while project applications
continue. It observes admission readiness alongside the intermediate telemetry,
then releases the application and waits for the expected global telemetry value
and source before checking the complete report. A bounded failure reports the
global applied item, the effective native projection of proof matching, and
native application events. The fixture releases its barrier during cleanup.

## Alternatives

**Wait only for admission readiness.** This does not establish that the global
native value is reportable.

**Increase the delay or accept null telemetry.** Neither proves application and
proof completion or preserves the intended configuration assertion.

## Consequences

The test exercises the intermediate ordering deterministically without changing
production configuration semantics. Its keyed barrier relies on the fixture's
absence of asynchronous tool selection preparation, which the test checks.
