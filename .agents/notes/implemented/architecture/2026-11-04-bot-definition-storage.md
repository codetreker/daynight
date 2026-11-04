# Agent Note: Bot definition storage

Status: implemented

## Problem

An assistant needs a durable owner and hosting identity outside any project or
Task claim. Retrying a creation after a lost response must recover the same
configuration, and hiding a deleted assistant must not discard outstanding
cleanup responsibility or imply that its execution stopped.

## Decision

A separate Bot row belongs to a user and references the existing composite
Worker identity. The caller supplies its UUID. Normalized name and explicit
overrides determine the creation fingerprint; the first resolved configuration
is frozen independently. Database-generated creation order supports later
successful-preference ordering without relying on completion order.

ReadCommitted insertion handles duplicate IDs without rewriting existing data.
A subsequent statement locks and reads the winning row, preserving concurrent
creation identity. Current credentials and owner checks apply to replay as well
as first creation. Version and creation order cross HTTP as decimal strings.

Deletion records an original request ID/version and separate pending Worker and
server obligations. Normal lists omit the row; detail exposes only minimal
responsibility. No Task relationship or mutation is introduced. A bound Session
is refused until deletion can install its barrier atomically in Bot-before-Session
lock order. The [specification](../../../../docs/spec/assistant.md) and
[design](../../../../docs/design/assistant.md) own behavior and mechanism.

## Alternatives

**Expose an explicit-configuration create endpoint immediately.** This would
make the storage kernel callable but establish a public contract requiring
settings that name-only creation must resolve. Creation remains an internal
service entry until default resolution can supply the confirmed public contract.

**Let deletion intent accept a bound Session immediately.** Recording only the
Bot marker would leave ordinary Session paths able to read or write history.
Rejecting bound definitions preserves the later atomic deletion barrier without
claiming that hidden rows have completed cleanup.

## Consequences

The definition kernel can be delivered and validated independently of hosting.
It adds one migration and owner-scoped indexes, with no fabricated project or
Task. Exact duplicate requests retain the original frozen configuration and
cleanup identity. Sequence gaps after rollback or conflicting insertion are
acceptable; creation order promises ordering, not consecutive numbering.

Default resolution, native execution, Session registration and actual history
cleanup remain separate capabilities. Pending deletion can persist indefinitely
until cleanup consumers are available. Those consumers must preserve credential
checks, Bot-before-Session locking and original-request reconciliation; they
cannot turn existing Task or Test endpoints into alternative Bot lifecycle paths.
