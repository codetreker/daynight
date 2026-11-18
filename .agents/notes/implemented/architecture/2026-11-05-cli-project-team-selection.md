# Agent Note: CLI Project Creation Team Selection

Status: implemented

## Problem

A new Project needs an explicit ownership context, while repository discovery
must continue to find existing Projects across all accessible Teams. A saved Team
can become inaccessible, and using it before discovery could prevent reuse of an
existing Project or direct a new Project to an unintended owner.

## Decision

The CLI originally scanned all accessible Project pages for the repository before
resolving a Team. A unique match returned read-only; multiple matches failed as
ambiguous. Only zero matches selected the explicit Team, the current service/account
default, or the caller's Personal Team when no default was configured. An invalid configured
Team fails instead of silently falling back. Creation confirms the target, binds
the request and response to the current principal, and submits the original name
and repository. The server rechecks membership and grants the creator direct
admin in the creation transaction. A noninteractive new creation needs
`--confirm`; discovery of an existing Project does not.

The [target-Team reuse decision](2026-11-18-cli-target-team-project-reuse.md)
replaces the cross-Team creation preflight. Independent repository discovery
still searches the visible range.

The [client requirements](../../../../docs/spec/daynight-project-task.md#pt6-project-命令)
own observable behavior. The [Team context decision](../../archived/architecture/2026-11-04-cli-team-context.md) records the rationale for default resolution, and the [Team Project creation decision](../../archived/architecture/2026-11-04-team-project-creation.md) records the rationale for the server transaction. This extends the archived
[repository discovery decision](../../archived/bug-fix/2026-10-21-project-create-repository-discovery.md)
with a target and confirmation only for the zero-match path.

## Alternatives

**Resolve the default before repository discovery.** An inaccessible or deleted
Team would block a read-only return of an existing accessible Project, although
its owner does not depend on the default. Filtering discovery by the selected
Team would also miss accessible Projects and could create an unintended duplicate.

## Consequences

Explicit selection bypasses an invalid stored default; an absent default means
Personal but an invalid one is visible. Confirmation and target selection do not
rebind an existing Project or change Task command identity. At the time of this
decision, discovery and POST were separate requests without a server uniqueness
constraint, so concurrent registrations could produce duplicate associations.
Unknown writes remain unknown and are not replayed.
