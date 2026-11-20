# Agent Note: Webhook Scope Admission

Status: implemented

## Problem

Webhook configuration, signing secrets, deletion and external delivery have
different consequences. A single management permission cannot restrict one
without granting the others, and a full post-write projection can disclose
configuration to a credential that is allowed to write but not read it.

## Decision

The production Webhook service and HTTP assembly apply the shared credential
scope policy alongside existing owner and role authorization. The current policy
is read in the business snapshot or after the write transaction's credential
lock. A configuration mutation requires delivery permission when its actual
changes enable, redirect, reconfirm, or expand an active delivery set. Disabled
configuration can be drafted, while enabling it checks delivery permission and
available configuration expansion. The minimal write receipt contains only the
operation and resource IDs; a full projection also needs read permission before
commit. The [management design](../../../../docs/design/webhook-management.md)
owns the detailed behavior. The [credential scope decision](2026-11-20-credential-scope-contract.md)
owns the common policy and the separate production activation boundary.

## Alternatives

**Use management permission for all actions.** This would let an ordinary edit
credential rotate secrets or initiate external delivery and would make a
write-only receipt impossible.

**Authorize from the request snapshot alone.** A credential can be narrowed
while a mutation waits for resource locks; checking current policy under the
existing credential lock preserves the intended ordering.

## Consequences

Production uses scoped authentication and Webhook assembly. Availability filtering retains ordinary
management when dispatch is unavailable without changing saved policies. Full
responses keep their authorized post-commit snapshot and unknown-outcome behavior;
minimal receipts avoid a second disclosure read after a confirmed commit.
