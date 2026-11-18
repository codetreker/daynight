# Agent Note: Remove Worker capacity responsibility section

Status: implemented

## Problem

The capacity responsibility section exposes diagnostic rows whose meaning is
unclear to users, including an empty state that does not explain capacity usage.
Operators still need the occupied and available totals, the reported occupancy
breakdown, and actionable failure and recovery details.

## Decision

The Worker detail monitoring view omits the independent responsibilities section
for every observation. The capacity card retains totals and the optional active
and retained breakdown. Activities, failures, recovery guidance and general
coverage notices remain visible. The monitoring protocol, validation and permission
projection retain `reservations`; this is a Web presentation decision.

This narrows the detail presentation of the [Web monitoring decision](../architecture/2026-11-09-web-worker-monitoring.md)
without changing its observation and access guarantees.

## Alternatives

**Keep or relabel the section.** Its rows still expose a diagnostic concept that
users cannot readily interpret, while the capacity breakdown and failure details
already explain the actionable retained-resource case.

## Consequences

Individual reservation roles and their links are no longer presented in the
monitoring view. The API can still carry them for other consumers. Capacity totals
are not derived from visible detail, so restricted or partial observations do not
change their meaning.
