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
itself. Production admission, device issuance integration and historical backfill remain
independent work. Scope updates compare the owner and observed version and only
advance it for a changed selection; usage timestamps remain independent. PAT
management rechecks expiry against database time after acquiring the target lock.
