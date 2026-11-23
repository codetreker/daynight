# Agent Note: Project Platform Filter

Status: implemented

## Problem

Project task lists could not isolate work requiring a particular execution
platform, or distinguish unrestricted tasks from platform-specific work. Chain
filtering must retain dependency context and apply combined conditions to the
same in-scope member.

## Decision

The ordinary task lists share a project-visit platform selection over the
synchronized `requiredPlatform` field. All tasks is unrestricted; Any platform
matches only null, and each named platform matches exactly. Matching precedes
pagination and does not change complete chain members, graph or counts. Goal
and expression search retain their own filtering. A platform change resets both
ordinary pages, while navigation clears it only when it still hides the target
after the existing filter rules. Pending Overview tag checks are fenced against
platform changes. The [Web specification](../../../../docs/spec/daynight-web.md)
owns observable behavior and the [design](../../../../docs/design/daynight-web.md)
owns composition.

## Alternatives

**Use the compatible-platform query.** That query includes unrestricted tasks,
so it cannot express the exact choices and would add a request.

**Persist the selection.** A visit-scoped choice avoids silently hiding work on
return while preserving the choice across ordinary tabs during a visit.

## Consequences

Filtering is local and issues no business writes. A matching chain can include
members on other platforms; their presence preserves the full context. The
existing [status and assignee decision](2026-11-05-task-list-status-filter.md)
continues to own the shared same-member and full-chain rules.
