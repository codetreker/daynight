# Agent Note: Credential Scope Contract

Status: implemented

## Problem

Credentials need independent business permissions without changing their identity,
existing resource bindings, or the account and resource checks that already
control access. Group-based grants would silently expand when new capabilities
are added, while REST and MCP need a common vocabulary for equivalent actions.

## Decision

The server's internal `scopepolicy` package owns stable scope IDs, ordered groups,
credential applicability, explicit selection normalization, defaults and shared
operation requirements. A validated policy is an immutable, versioned snapshot;
combined actions require every applicable scope. Credential authorization retains
the principal separately and distinguishes scoped PAT and MCP policies from
fixed profiles. Model and store contracts carry policy or approved scope values
without changing the existing product assembly. PAT storage supports explicit
policies with an independent version and rejects absent or malformed policies
on scoped reads. The preparation migration leaves historical and legacy-writer
rows unscoped until the coordinated backfill and cutover. Device records reserve
the approved selection without changing the existing redemption flow.

Team operations apply that contract at their business admission points, after
visibility checks and before protected output or mutation. Existing role checks
remain mandatory without exposing role-dependent results to a credential that
lacks the required scope.

The scoped service constructors require explicit credential authorization
providers; operations with an existing transaction-bound credential recheck use
the current authorization from that same transaction or snapshot. The existing
production constructors retain their original profile until scoped assembly is
enabled. Team invitation acceptance has its own permission and does not require
project reading. Its minimal service receipt needs only acceptance permission;
the existing full response also requires permission to read the invitation.

Bot definition services accept an explicitly supplied authorization source for
snapshot reads and transaction-bound writes. Definition reads, writes and
deletion use their respective operations, alongside the existing credential and
owner checks. Full definition responses also require Session read permission
because their existing representation includes execution facts. Deletion retains
its coordinated Session revocation and cleanup. The existing production
constructors remain unchanged until scoped authorization is assembled. Defaults
that expose Worker status also require Worker read permission; their explicit
native model discovery checks Worker inspect permission before each broker request.
The necessary discovery within Bot creation retains Bot admission and the
existing Worker resource checks, including for MCP grants.
The optional Bot attention projection requires Assistant Task read permission;
its creation response is admitted before the definition is written.

## Alternatives

**Group grants.** Treating a selected group as an enduring grant would authorize
newly introduced operations without another user decision. Explicit IDs preserve
the original selection.

**Per-scope rows or bitsets.** Separate rows add joins and multirow updates to a
small per-credential set; bitsets require a durable allocation protocol. The
selected model uses readable normalized IDs and allows atomic replacement in the
persistence implementation.

## Consequences

CLI and MCP defaults use the applicable available entries; Team defaults to read
and MCP excludes Worker execution. Agent authorization is a separate group.
Saved snapshots remain unchanged as the catalog grows. The policy does not grant
resource membership, override profile bindings, or enforce public operations by
itself. The [Tag admission mechanism](2026-11-20-tag-scope-admission.md) consumes
the policy through opt-in service and transport entry points. Production
activation, device issuance integration and historical backfill remain independent
work. Scope updates compare the owner and observed version and only advance it for
a changed selection; usage timestamps remain independent. PAT management
rechecks expiry against database time after acquiring the target lock. Bot
definition permission does not confer Session or runtime control. A scoped
authorization source must read current authority at each supplied boundary and
preserve the principal; it cannot substitute a stale request snapshot for an
existing transactional recheck.
