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
without changing the existing product assembly.

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
itself. Persistence, production assembly and issuance remain independent work.
