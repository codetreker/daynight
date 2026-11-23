# Agent Note: Grant Row Style Isolation

Status: implemented

## Problem

Project members and account OAuth authorizations share a row class but require
different column layouts. Account authorization rules using that shared class
overrode the project member table, wrapping its five cells into multiple rows
and displacing controls from their headings.

## Decision

Account authorization column, action, revoked and responsive rules target the
existing `owner-grant-row` marker. Project members retain their five-column grid
and the [local scrolling decision](2026-11-05-project-grant-table-overflow.md).
The [auth design](../../../../docs/design/daynight-auth.md) describes the layouts.

## Alternatives

**Override the account rules again for project members.** This would leave the
two consumers coupled to stylesheet order and require project rules to undo each
account breakpoint and action placement.

## Consequences

Project headings and member cells stay in corresponding columns while account
authorization rows retain their three-, two- and one-column responsive layouts.
Each consumer still shares general row styling, so future consumer-specific rules
must use their own marker. Browser fixtures check geometry and controls using the
production styles and controlled API responses.
