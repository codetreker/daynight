# Agent Note: Server Team Boundaries

Status: implemented

## Problem

Team lifecycle, membership and invitation rules need to share transaction-bound
facts while remaining independent of the PostgreSQL implementation and HTTP
transport. Creation and changes to an existing Team have different locking
requirements. A domain refusal also cannot hide a failed or uncertain transaction
completion.

## Decision

`core/team` owns Team rules and operates on scoped DAO capabilities.
`service/team` selects creation, existing Team write or read-only snapshot scopes,
stages domain refusals and handles completion. `server/team` owns HTTP input,
response and error adaptation. Shared Project callers use the same actor and Team
ID validation and completion classification directly.

Creation locks the creator user and atomically inserts the Team and its initial
admin. Existing Team writes lock the Team before reading current membership and
versions. Deletion checks ownership in a separate Read Committed statement after
that lock. Invitation acceptance rechecks the invitation and membership after
locking the Team. The [Team lifecycle decision](2026-11-04-team-lifecycle.md)
retains the locking rationale and public behavior.

## Alternatives

**Place transaction orchestration in HTTP handlers.** This would expose completion
and staged refusal handling to the protocol layer and duplicate it across routes.

**Use one creation and existing-Team lock path.** A new Team row does not exist
to lock, while an existing Team must serialize ownership and membership changes.
Separate scopes preserve both requirements.

## Consequences

Team business rules no longer depend on a concrete transaction or root service;
the transaction-bound DAO remains valid only during its callback. Cleanup failures
and unknown commits take precedence over business refusals. Project authorization
and the physical PostgreSQL move retain their separate owners.
