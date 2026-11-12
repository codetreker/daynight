# Agent Note: Schedule Released Tasks as Ordinary Candidates

Status: implemented

## Problem

A released task remains eligible for an ordinary server claim, but the Worker
candidate iterator discarded it. Automatic Workers could not reclaim it even
when all normal eligibility conditions were met.

## Decision

The candidate stream yields eligible released tasks in service order, preserving
its filters, pagination and platform preference. Active claims remain protocol
errors. The coordinator checks retained resources and archive responsibilities
before requesting a new claim, and generates fresh execution identities after
admission. Server version and active-claim checks arbitrate competing Workers.

## Alternatives

**Keep released tasks outside automatic scheduling.** This prevents ordinary
reclaim and requires a separate manual resume even when normal eligibility holds.

**Prioritize or reserve released tasks for their former Worker.** This changes
service ordering and competition without resolving retained local resources.

## Consequences

The original Worker can compete after its local responsibilities end; other
Workers need not wait for that local barrier. Release now clears the current record; the [release ownership decision](../simplification/2026-11-12-release-clears-ownership.md) records that change. Ordinary eligibility and the existing resource fences continue to apply.
The later [resume retirement decision](../simplification/2026-11-12-retire-worker-resume.md)
removes the separate manual protocol.
