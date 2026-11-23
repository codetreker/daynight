# Agent Note: Unfinished Chain Tab Count

Status: implemented

## Problem

The Task chains tab badge counted unfinished member Tasks, so one chain with
several unfinished members could contribute several units. People using the
badge to understand how many chains remain could not infer that number.

## Decision

The chain badge counts each ordinary multi-member component once if a member
within the unparented scope is both unfinished and matches the selected assignee.
The complete ordinary graph determines components before Parent scoping; external
edges do not combine them. A finished representative does not suppress a matching
unfinished successor, and a member outside the scope cannot qualify a chain.
The badge has its own localized tooltip. The standalone count retains its unit
and eligibility; the separate [unfinished Goal decision](2026-11-14-unfinished-goal-tab-count.md)
changes Goal eligibility independently.

This partially supersedes the chain unit of the [assignee-scoped count decision](2026-11-13-assignee-scoped-tab-counts.md)
while preserving its assignee, scope and snapshot rationale. It also replaces the
chain unit of the archived [unfinished task count decision](../../archived/feature/2026-10-22-unfinished-task-tab-counts.md).
The [Web requirements](../../../../docs/spec/daynight-web.md) and
[design](../../../../docs/design/daynight-web.md) own current behavior and data flow.

## Alternatives

**Count unfinished member Tasks.** This reports remaining task volume, the
original reason for the earlier unit, but cannot report the number of unfinished
chains when multiple members belong to one component.

**Count filtered chain rows or representative status.** List filters and pages
would alter the badge, and an ended representative can have an unfinished
successor. Neither gives the qualifying chain count from the complete scope.

## Consequences

The badge expresses unfinished chains rather than unfinished task volume, so it
cannot be added to the standalone badge to obtain an unfinished task total.
Same-member matching prevents an unfinished member from qualifying another
assignee's finished work. Snapshot and assignee changes recompute the projection;
failed refreshes retain the last successful snapshot. No new request or stored
format is required.
