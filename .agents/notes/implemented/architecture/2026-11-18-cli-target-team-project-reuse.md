# Agent Note: CLI Target Team Project Reuse

Status: implemented

## Problem

Different Teams may each own a Project for the same repository. Returning an
accessible Project owned by another Team prevents creation for the intended Team,
while callers with only a direct Project grant still need to reuse their Project.

## Decision

Project creation resolves its target from the explicit Team, the current
service/account default, or Personal. It reads all accessible Project pages and
matches repository identity only among Projects owned by that Team. A unique
visible match returns without Team membership or creation confirmation. Historical
addresses that cannot be parsed do not match; pagination and protocol failures
prevent a write. Zero matches require Team membership and confirmation before
creation. The service enforces occupancy against races and reports a conflict;
unknown write outcomes are not replayed.

The [client requirements](../../../../docs/spec/daynight-project-task.md#pt6-project-命令)
own the observable behavior. This replaces the creation lookup scope in the
[earlier Team selection decision](2026-11-05-cli-project-team-selection.md),
and complements the [server uniqueness decision](2026-11-18-team-project-repository-uniqueness.md).
Independent repository discovery retains its full visible scope.

## Alternatives

**Reuse across all visible Teams.** This avoids resolving a potentially stale
default for a read-only return, but can return another Team's Project and prevent
the intended Team from owning its own Project.

**List only Team Projects.** The Team listing requires membership and would hide
an otherwise accessible Project from a user with a direct Project grant. Filtering
the existing visible list retains that access path.

## Consequences

Resolving an invalid configured default can prevent reuse until the caller selects
or fixes the target. A separate server-side check remains necessary because the
visible preflight cannot see private conflicts or serialize concurrent writes.
