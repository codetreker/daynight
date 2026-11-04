# Agent Note: Account-owned Worker Cloud Configuration

Status: implemented

## Problem

A stable Worker needs remotely editable runtime settings independently of the
tasks it currently owns. Reports already provide an authenticated exchange, but
their strict receipt contains only time facts. Concurrent target edits, first
imports, and application reports need distinct ownership: saving a desired value
does not prove that the machine applied it.

## Decision

The account-owned Worker row stores a revisioned desired configuration and a
separately revisioned application observation. The
[configuration contract](../../../../docs/spec/daynight-worker-configuration.md)
owns wire types and refusals; the
[design](../../../../docs/design/daynight-worker-configuration.md) owns
transactions and representation.

Clients opt into the report extension with a dedicated configuration header.
Reports without it retain the existing snapshot contract. The first valid
candidate initializes an absent target; later candidates cannot overwrite it.
PUT edits an initialized target using an exact revision. Application reports
have their own CAS revision, so heartbeats do not invalidate target edits and
stale application reports cannot replace a newer accepted observation.

The same Worker row serializes these operations. Configuration admission uses
the authenticated account and existing project access relation. It does not
inspect active claims, alter task storage or grant semantics, or require tasks
to finish before configuration is imported. Native preparation and resource
control remain the runtime's responsibility. The
[snapshot decision](2026-10-28-worker-runtime-snapshots.md) retains liveness,
task-reference normalization, and filtered snapshot reads.

New revisions are canonical decimal strings. Project overrides preserve omitted
inheritance separately from explicit model null and an empty argument array.
Configuration remains stored after recent-snapshot visibility expires; reading
or editing it does not renew machine liveness.

## Alternatives

**Use one revision for targets and application reports.** Heartbeats would
either invalidate editor drafts or allow older machine results to overwrite
newer observations. Separate revisions express the two writers.

**Attach configuration to task ownership.** Idle Workers still need settings.
Task migrations and acquisition restrictions would couple configuration to an
unrelated lifecycle.

**Apply configuration inside the server or report request.** The server cannot
observe local native-tool readiness or safely perform machine-side resource
actions. Reports transport targets and observations; the machine applies them.

## Consequences

The service exchanges desired settings and partial application outcomes without
changing task formats or lifecycle rules. Existing snapshot consumers remain
valid while editors use a stable target revision.

A target save is not an application acknowledgment. Consumers keep target
values, actual values, failures and observation times distinct. The service
validates structure and access; it does not prove that a client performed a
reported local operation.
