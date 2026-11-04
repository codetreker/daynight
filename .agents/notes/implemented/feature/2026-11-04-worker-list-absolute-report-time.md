# Agent Note: Absolute Worker List Report Time

Status: implemented

## Problem

A relative report age changes as time passes and does not directly show when a
Worker last reported. Splitting the label and value across lines also makes the
list harder to scan.

## Decision

Worker list cards show the report timestamp as a localized absolute date and
time in the browser time zone, with seconds. The label and value stay together
on one line, while the card's navigation text can wrap separately. The existing
[observation decision](../architecture/2026-10-29-web-worker-observations.md)
continues to govern online status, ordering and refresh.

## Alternatives

**Keep the relative age.** It highlights elapsed time but changes on every tick
and requires another step to determine the actual report time.

## Consequences

The same report remains visually stable as the online badge changes; a new
report replaces the displayed value. Absolute formatting follows the user's
language and time zone, so people in different time zones can see different
local representations of the same instant.
