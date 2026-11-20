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

Assistant task operations classify their business actions in core, where mixed
updates and returned resource views can require multiple scopes. Scoped admission
reads the authoritative policy through the transaction-bound authorization
reader and retains the existing identity, Bot ownership and claim checks. Inbox
management has its own capability and does not change inbound token authentication.

## Alternatives

**Group grants.** Treating a selected group as an enduring grant would authorize
newly introduced operations without another user decision. Explicit IDs preserve
the original selection.

**Per-scope rows or bitsets.** Separate rows add joins and multirow updates to a
small per-credential set; bitsets require a durable allocation protocol. The
selected model uses readable normalized IDs and allows atomic replacement in the
persistence implementation.

**Transport-only admission.** HTTP methods do not distinguish a deletion encoded
as a PATCH or a combined update, and other callers can reuse the same operations.
Classifying the action in core keeps those paths under the same business rules.

## Consequences

CLI and MCP defaults use the applicable available entries; Team defaults to read
and MCP excludes Worker execution. Agent authorization is a separate group.
Saved snapshots remain unchanged as the catalog grows. The policy does not grant
resource membership, override profile bindings, or enforce public operations by
itself. Persistence, production admission and issuance remain independent work.
The scoped assistant task path requires a transaction-bound policy reader; the
existing production assembly remains on its original credential path until the
scoped assembly and authoritative storage are connected.
